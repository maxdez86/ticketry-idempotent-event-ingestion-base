import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Socket } from "node:net";

import {
  authenticateApiKey,
  findMembership,
  hashApiKey,
  looksLikeApiKey,
  recordAudit,
  resolveStaffTenant
} from "@ticketry/core";
import type { MembershipRole } from "@ticketry/core";
import type { SelfMembership } from "@ticketry/core";
import { setLocalTenant } from "@ticketry/db";
import type { Pool, PoolClient } from "@ticketry/db";

import { forbidden, unauthorized } from "../lib/http.js";

export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  isStaff: boolean;
  apiKeyId: string;
  tenantId: string;
  tenantSlug: string;
  role: MembershipRole | "staff";
  memberships: SelfMembership[];
}

/**
 * The request's database surface: the checked-out client's query interface,
 * fenced so that work resumed after the request was finalized (for example a
 * continuation that wakes up after an abort rolled it back) cannot reach the
 * connection once it may belong to another request.
 */
export type RequestDatabase = Pick<PoolClient, "query" | "getTransactionStatus">;

type TransactionPhase = "bootstrap" | "route" | "committed" | "rolled_back" | "none";

interface RequestDatabaseLifecycle {
  client: PoolClient;
  connection: RequestDatabase;
  connectionErrorListener: (error: Error) => void;
  phase: TransactionPhase;
  finalization?: Promise<void>;
  finalizationErrorReported?: boolean;
  poisonedBy?: Error;
  /**
   * Set once a staff request's workspace has resolved and its access record has been issued in the
   * bootstrap transaction. From then until that transaction commits, a failure or disconnect must
   * keep the record, so finalization commits the bootstrap instead of rolling it back.
   */
  accessRecordIssued?: boolean;
  released: boolean;
  socket?: Socket;
  socketCloseListener?: () => void;
}

declare module "fastify" {
  interface FastifyRequest {
    db: RequestDatabase;
    principal: Principal;
    requestDatabaseLifecycle?: RequestDatabaseLifecycle;
  }
}

export const TENANT_HEADER = "x-ticketry-tenant";

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token || !looksLikeApiKey(token)) {
    return null;
  }
  return token;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function releaseClient(state: RequestDatabaseLifecycle, active: Set<RequestDatabaseLifecycle>, error?: Error): void {
  if (state.released) {
    return;
  }
  state.released = true;
  active.delete(state);
  if (state.socket && state.socketCloseListener) {
    state.socket.off("close", state.socketCloseListener);
  }
  state.client.off("error", state.connectionErrorListener);
  // A poisoned connection (failed commit/rollback, or a connection error observed
  // between statements) is destroyed by the pool instead of being reused.
  state.client.release(error ?? state.poisonedBy);
}

/** Throws once finalization has started: the connection is no longer this request's to use. */
function assertLive(state: RequestDatabaseLifecycle): void {
  if (state.finalization || state.released) {
    throw new Error("request database connection is no longer available: the request was already finalized");
  }
}

type AnyQuery = (...args: unknown[]) => unknown;

function fencedConnection(state: RequestDatabaseLifecycle): RequestDatabase {
  const query: AnyQuery = (...args) => {
    assertLive(state);
    return (state.client.query as AnyQuery)(...args);
  };
  return {
    query: query as PoolClient["query"],
    getTransactionStatus: () => {
      assertLive(state);
      return state.client.getTransactionStatus();
    }
  };
}

async function rollbackAndRelease(
  state: RequestDatabaseLifecycle,
  active: Set<RequestDatabaseLifecycle>
): Promise<void> {
  let rollbackError: Error | undefined;
  if (state.phase === "bootstrap" && state.accessRecordIssued) {
    // The staff access record is an access log, not the request's work: it survives the request's
    // failure. The bootstrap transaction holds nothing else, and the pg client queues this COMMIT
    // behind the record's insert if that is still in flight. A failed insert has already aborted
    // the transaction, and COMMIT then ends it without persisting anything.
    try {
      await state.client.query("COMMIT");
      state.phase = "committed";
    } catch (error) {
      rollbackError = asError(error);
    }
  } else if (state.phase === "bootstrap" || state.phase === "route") {
    try {
      await state.client.query("ROLLBACK");
      state.phase = "rolled_back";
    } catch (error) {
      rollbackError = asError(error);
    }
  }
  releaseClient(state, active, rollbackError ?? state.poisonedBy);
  if (rollbackError) {
    throw rollbackError;
  }
}

async function commitAndRelease(
  state: RequestDatabaseLifecycle,
  active: Set<RequestDatabaseLifecycle>
): Promise<void> {
  if (state.phase !== "route") {
    await rollbackAndRelease(state, active);
    return;
  }
  try {
    await state.client.query("COMMIT");
    state.phase = "committed";
    releaseClient(state, active);
  } catch (error) {
    state.poisonedBy = asError(error);
    try {
      await rollbackAndRelease(state, active);
    } catch {
      // The commit error determines the response; rollback failure only determines client disposal.
    }
    throw error;
  }
}

function finalizeRequest(
  state: RequestDatabaseLifecycle,
  active: Set<RequestDatabaseLifecycle>,
  outcome: "commit" | "rollback"
): Promise<void> {
  state.finalization ??=
    outcome === "commit" ? commitAndRelease(state, active) : rollbackAndRelease(state, active);
  return state.finalization;
}

async function rollbackQuietly(
  request: FastifyRequest,
  active: Set<RequestDatabaseLifecycle>,
  log: FastifyBaseLogger
): Promise<void> {
  const state = request.requestDatabaseLifecycle;
  if (!state || state.released) {
    return;
  }
  try {
    await finalizeRequest(state, active, "rollback");
  } catch (error) {
    log.error({ err: error }, "failed to roll back request transaction");
  }
}

async function commitBootstrap(state: RequestDatabaseLifecycle): Promise<void> {
  assertLive(state);
  try {
    await state.connection.query("COMMIT");
    state.phase = "none";
    state.accessRecordIssued = false;
  } catch (error) {
    state.poisonedBy = asError(error);
    throw error;
  }
}

async function beginTenantTransaction(state: RequestDatabaseLifecycle, tenantId: string): Promise<void> {
  assertLive(state);
  // Mark the phase before BEGIN is sent so an abort observed while it is in
  // flight still rolls back instead of releasing a connection with an open transaction.
  state.phase = "route";
  try {
    await state.connection.query("BEGIN");
  } catch (error) {
    state.poisonedBy = asError(error);
    throw error;
  }
  await setLocalTenant(state.connection, tenantId);
}

/** Resolve the caller and start the transaction in which its route will run. */
export async function authenticate(request: FastifyRequest): Promise<Principal> {
  const state = request.requestDatabaseLifecycle;
  if (!state || state.phase !== "bootstrap") {
    throw new Error("authentication requires a bootstrap transaction");
  }

  const token = bearerToken(request);
  if (!token) {
    throw unauthorized();
  }
  const key = await authenticateApiKey(request.db, hashApiKey(token));
  if (!key) {
    throw unauthorized();
  }

  const base = {
    userId: key.userId,
    email: key.email,
    displayName: key.displayName,
    isStaff: key.isStaff,
    apiKeyId: key.apiKeyId,
    memberships: key.memberships
  };

  if (key.tenantId) {
    await commitBootstrap(state);
    await beginTenantTransaction(state, key.tenantId);
    const membership = await findMembership(request.db, key.tenantId, key.userId);
    if (!membership || membership.revokedAt) {
      throw forbidden("the key's user is not a member of its workspace");
    }
    return {
      ...base,
      tenantId: key.tenantId,
      tenantSlug: membership.tenantSlug,
      role: membership.role
    };
  }

  if (!key.isStaff) {
    throw forbidden("API key is not bound to a workspace");
  }
  const requested = request.headers[TENANT_HEADER];
  const slug = Array.isArray(requested) ? requested[0] : requested;
  if (!slug) {
    throw forbidden(`staff requests must name a workspace in ${TENANT_HEADER}`);
  }
  const tenant = await resolveStaffTenant(request.db, slug);
  if (!tenant) {
    throw forbidden(`unknown workspace: ${slug}`);
  }
  // The workspace has resolved: from here the access record must be written and must outlive any
  // failure of this request. Scope and record are issued back to back, with no await in between,
  // so a disconnect cannot land after resolution but before the record is on the connection.
  state.accessRecordIssued = true;
  const scoped = setLocalTenant(request.db, tenant.tenantId);
  const recorded = recordAudit(request.db, {
    tenantId: tenant.tenantId,
    actorId: key.userId,
    action: "staff.workspace_access",
    targetType: "tenant",
    targetId: tenant.tenantId,
    metadata: { method: request.method, path: request.url }
  });
  await Promise.all([scoped, recorded]);
  await commitBootstrap(state);
  await beginTenantTransaction(state, tenant.tenantId);
  return { ...base, tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: "staff" };
}

const WRITE_ROLES: ReadonlySet<Principal["role"]> = new Set(["owner", "agent", "staff"]);

export function canWrite(principal: Principal): boolean {
  return WRITE_ROLES.has(principal.role);
}

export function requireWrite(principal: Principal): void {
  if (!canWrite(principal)) {
    throw forbidden("viewers cannot modify tickets");
  }
}

export function requireStaff(principal: Principal): void {
  if (principal.role !== "staff") {
    throw forbidden("provider lifecycle ingestion requires a staff API key");
  }
}

/** Register acquisition and rollback hooks; call the return value after all other hooks to add commit last. */
export function registerAuth(
  app: FastifyInstance,
  pool: Pool,
  publicPaths: ReadonlySet<string>
): () => void {
  const active = new Set<RequestDatabaseLifecycle>();
  const isPublic = (request: FastifyRequest): boolean => {
    const pathname = request.url.split("?")[0] ?? request.url;
    return publicPaths.has(pathname);
  };

  app.decorateRequest("db");
  app.decorateRequest("principal");
  app.decorateRequest("requestDatabaseLifecycle");

  const commitRequest = async (
    request: FastifyRequest,
    _reply: FastifyReply,
    payload: unknown
  ): Promise<unknown> => {
    const state = request.requestDatabaseLifecycle;
    if (state) {
      try {
        await finalizeRequest(state, active, "commit");
      } catch (error) {
        if (!state.finalizationErrorReported) {
          state.finalizationErrorReported = true;
          throw error;
        }
      }
    }
    return payload;
  };

  app.addHook("onRoute", (routeOptions) => {
    const existing = routeOptions.onSend;
    routeOptions.onSend = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), commitRequest]
      : commitRequest;
  });

  app.addHook("onRequest", async (request) => {
    if (isPublic(request)) {
      return;
    }
    const client = await pool.connect();
    // The client may have gone away while this request queued for a connection. Its close
    // event has then already fired, so no listener registered below would ever see it: hand
    // the connection straight back and run nothing on its behalf.
    if (request.raw.socket.destroyed) {
      client.release();
      throw new Error("the client disconnected before a database connection became available");
    }
    const state = {
      client,
      phase: "none",
      released: false,
      connectionErrorListener: (error: Error): void => {
        state.poisonedBy ??= error;
      }
    } as RequestDatabaseLifecycle;
    state.connection = fencedConnection(state);
    client.on("error", state.connectionErrorListener);
    request.db = state.connection;
    request.requestDatabaseLifecycle = state;
    active.add(state);
    const socket = request.raw.socket;
    const socketCloseListener = (): void => {
      void rollbackQuietly(request, active, request.log);
    };
    state.socket = socket;
    state.socketCloseListener = socketCloseListener;
    socket.once("close", socketCloseListener);
    try {
      state.phase = "bootstrap";
      try {
        await state.connection.query("BEGIN");
      } catch (error) {
        state.poisonedBy = asError(error);
        throw error;
      }
      request.principal = await authenticate(request);
    } catch (error) {
      try {
        await finalizeRequest(state, active, "rollback");
      } catch (rollbackError) {
        request.log.error({ err: rollbackError }, "failed to roll back authentication transaction");
      }
      throw error;
    }
  });

  app.addHook("onError", async (request) => {
    await rollbackQuietly(request, active, request.log);
  });
  app.addHook("onRequestAbort", async (request) => {
    await rollbackQuietly(request, active, request.log);
  });
  app.addHook("onResponse", async (request) => {
    await rollbackQuietly(request, active, request.log);
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled([...active].map((state) => finalizeRequest(state, active, "rollback")));
  });

  return () => {
    app.addHook("onSend", async (request, _reply, payload) => {
      if (request.is404) {
        return commitRequest(request, _reply, payload);
      }
      return payload;
    });
  };
}

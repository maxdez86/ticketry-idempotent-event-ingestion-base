/**
 * GOLD-NATIVE REQUEST LIFECYCLE AUDIT — private, NOT transferable acceptance.
 *
 * Reproduces "resumed work after abort": a request whose socket closed while
 * its processing was suspended must not, when it resumes, issue SQL on the
 * connection that abort cleanup already returned to the pool and that another
 * request now holds under its own workspace scope; nor may it finalize or
 * release that connection a second time.
 *
 * The suspension point is a test-only gated route mounted on the real app, so
 * the route rides the implementation's ordinary authentication and transaction
 * lifecycle; the route exists only to suspend and observe. The bootstrap-phase
 * variant suspends inside authentication itself through an owner-installed
 * barrier on the key's usage update, and observes stray work by logging the
 * statements issued on the pooled connection after cleanup released it. This
 * suite is bound to this gold's lifecycle and must never be copied into
 * candidate acceptance.
 */
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import type { PoolClient } from "@ticketry/db";
import { createApiKey, createMember, createTenant, createTestContext, createUser } from "@ticketry/test-support";
import type { TestContext, TestTenant } from "@ticketry/test-support";

import { buildApp } from "../src/app.js";
import {
  TicketBarrier,
  barrierSubject,
  installApiKeyUsageBarrier,
  installStaffAccessBarrier,
  removeApiKeyUsageBarrier,
  removeStaffAccessBarrier,
  waitUntil
} from "./support/barrier.js";

const TIMEOUT_MS = 10_000;

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface GatedOutcome {
  first: string[];
  second: string[] | null;
  error: string | null;
}

/** One gated request: what its handler saw before suspending, and after resuming. */
interface Gate {
  reached: Deferred<string[]>;
  resume: Deferred<void>;
  outcome: Deferred<GatedOutcome>;
}

function gate(): Gate {
  return { reached: deferred<string[]>(), resume: deferred(), outcome: deferred<GatedOutcome>() };
}

interface LiveRequest {
  destroy(): void;
  done: Promise<{ statusCode: number | null; body: string }>;
}

function httpGet(port: number, path: string, apiKey: string, headers: Record<string, string> = {}): LiveRequest {
  const finished = deferred<{ statusCode: number | null; body: string }>();
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "GET",
    path,
    headers: { ...headers, authorization: `Bearer ${apiKey}` }
  });
  request.on("response", (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      body += chunk;
    });
    response.on("end", () => finished.resolve({ statusCode: response.statusCode ?? null, body }));
    response.on("error", () => finished.resolve({ statusCode: response.statusCode ?? null, body }));
  });
  request.on("error", () => finished.resolve({ statusCode: null, body: "" }));
  request.end();
  return { destroy: () => request.destroy(), done: finished.promise };
}

interface LoggedStatement {
  text: string;
  values: unknown[];
}

type AnyQuery = (...args: unknown[]) => unknown;

describe("gold-native request lifecycle audit", () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let port: number;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let keyA: string;
  let keyB: string;
  let memberAUserId: string;
  const gates = new Map<string, Gate>();
  const handlerRuns: string[] = [];
  /** Every statement issued on the pooled runtime connection, in order. */
  const statements: LoggedStatement[] = [];
  /** `statements.length` at each pool release: the boundary after which work belongs to the next borrower. */
  const releaseMarks: number[] = [];

  beforeAll(async () => {
    ctx = await createTestContext({ appPoolMax: 1 });
    ctx.app.on("connect", (client: PoolClient) => {
      const original = client.query.bind(client) as AnyQuery;
      (client as unknown as { query: AnyQuery }).query = (...args) => {
        const first = args[0];
        const text = typeof first === "string" ? first : ((first as { text?: string } | undefined)?.text ?? "");
        const values = Array.isArray(args[1]) ? args[1] : ((first as { values?: unknown[] } | undefined)?.values ?? []);
        statements.push({ text, values });
        return original(...args);
      };
    });
    ctx.app.on("release", () => releaseMarks.push(statements.length));

    tenantA = await createTenant(ctx.admin, "lifecycle-alpha");
    tenantB = await createTenant(ctx.admin, "lifecycle-beta");
    const memberA = await createMember(ctx.admin, tenantA.id, "agent");
    const memberB = await createMember(ctx.admin, tenantB.id, "agent");
    keyA = memberA.apiKey;
    keyB = memberB.apiKey;
    memberAUserId = memberA.user.id;

    app = buildApp({ pool: ctx.app });
    // Test-only suspension point on the real lifecycle: one scoped read, a
    // controllable pause with no database work in flight, then a second read.
    app.get("/__lifecycle/gated", async (request) => {
      const { id } = request.query as { id: string };
      const step = gates.get(id)!;
      handlerRuns.push(id);
      const first = (await request.db.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((row) => row.id);
      step.reached.resolve(first);
      await step.resume.promise;
      try {
        const second = (await request.db.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map(
          (row) => row.id
        );
        step.outcome.resolve({ first, second, error: null });
        return { first, second };
      } catch (error) {
        step.outcome.resolve({ first, second: null, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const step of gates.values()) {
      step.resume.resolve();
    }
    await app.close();
    await ctx.close();
  });

  function openGates(...ids: string[]): void {
    for (const id of ids) {
      gates.set(id, gate());
    }
  }

  function releaseGates(...ids: string[]): void {
    for (const id of ids) {
      gates.get(id)?.resume.resolve();
    }
  }

  /** Statements issued on the connection after the `index`-th release that carry tenant A's id. */
  function tenantAWorkAfterRelease(index: number): LoggedStatement[] {
    const cutoff = releaseMarks[index];
    expect(cutoff, "expected pool release was not observed").toBeDefined();
    return statements.slice(cutoff).filter((statement) => statement.values.includes(tenantA.id));
  }

  async function expectPoolClean(): Promise<void> {
    await waitUntil(async () => ctx.app.totalCount - ctx.app.idleCount === 0 && ctx.app.waitingCount === 0, TIMEOUT_MS, "pool release");
    const client = await bounded(ctx.app.connect(), "reborrow");
    try {
      const visible = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM tenants");
      expect(visible.rows[0]?.count, "reborrowed connection retained workspace scope").toBe(0);
      expect(client.getTransactionStatus(), "reborrowed connection left inside a transaction").toBe("I");
    } finally {
      client.release();
    }
  }

  it("fences an aborted request's resumed route work off the connection its successor now holds", async () => {
    openGates("stale", "successor");
    try {
      const stale = httpGet(port, "/__lifecycle/gated?id=stale", keyA);
      expect(await bounded(gates.get("stale")!.reached.promise, "stale request suspension")).toEqual([tenantA.id]);
      const releasesBefore = releaseMarks.length;
      stale.destroy();
      await bounded(stale.done, "stale socket close");
      // Abort cleanup rolls the suspended request back and returns its connection.
      await waitUntil(async () => releaseMarks.length > releasesBefore && ctx.app.idleCount === 1, TIMEOUT_MS, "abort cleanup release");

      // The successor borrows that same connection and establishes its own scope.
      const successor = httpGet(port, "/__lifecycle/gated?id=successor", keyB);
      expect(await bounded(gates.get("successor")!.reached.promise, "successor suspension")).toEqual([tenantB.id]);

      // Resume the stale request while the successor holds the connection.
      releaseGates("stale");
      const staleOutcome = await bounded(gates.get("stale")!.outcome.promise, "stale request resumption");
      expect(staleOutcome.second, "stale request read through the successor's scoped connection").toBeNull();
      expect(staleOutcome.error).not.toBeNull();

      // The successor's transaction was neither finalized nor rescoped by the stale request.
      releaseGates("successor");
      const successorResponse = await bounded(successor.done, "successor response");
      expect(successorResponse.statusCode).toBe(200);
      expect(JSON.parse(successorResponse.body)).toEqual({ first: [tenantB.id], second: [tenantB.id] });

      await expectPoolClean();
      expect(tenantAWorkAfterRelease(releasesBefore), "stale tenant A work issued after its connection was released").toEqual([]);
    } finally {
      releaseGates("stale", "successor");
    }
  }, 30_000);

  it("issues no work for a request aborted while its authentication was still in progress", async () => {
    await installApiKeyUsageBarrier(ctx.admin);
    const objid = 101;
    const barrier = new TicketBarrier(ctx.admin, objid);
    const barredKey = await createApiKey(ctx.admin, {
      tenantId: tenantA.id,
      userId: memberAUserId,
      label: barrierSubject(objid)
    });
    openGates("bootstrap-stale", "bootstrap-successor");
    try {
      await barrier.hold();
      const stale = httpGet(port, "/__lifecycle/gated?id=bootstrap-stale", barredKey);
      await barrier.awaitReached(TIMEOUT_MS);
      const releasesBefore = releaseMarks.length;
      stale.destroy();
      await bounded(stale.done, "stale socket close");

      // The successor queues on the size-one pool behind the suspended authentication.
      const successor = httpGet(port, "/__lifecycle/gated?id=bootstrap-successor", keyB);
      await waitUntil(async () => ctx.app.waitingCount === 1, TIMEOUT_MS, "successor waiting on the pool");

      // Let authentication finish: cleanup must win, and the stale continuation
      // must not carry its bootstrap commit, route BEGIN, or tenant A scope onto
      // the connection the successor receives.
      await barrier.release();
      expect(await bounded(gates.get("bootstrap-successor")!.reached.promise, "successor suspension")).toEqual([tenantB.id]);
      releaseGates("bootstrap-successor");
      const successorResponse = await bounded(successor.done, "successor response");
      expect(successorResponse.statusCode).toBe(200);
      expect(JSON.parse(successorResponse.body)).toEqual({ first: [tenantB.id], second: [tenantB.id] });

      await expectPoolClean();
      expect(handlerRuns, "aborted request reached its route handler after cleanup").not.toContain("bootstrap-stale");
      expect(tenantAWorkAfterRelease(releasesBefore), "stale tenant A work issued after its connection was released").toEqual([]);
    } finally {
      releaseGates("bootstrap-stale", "bootstrap-successor");
      await barrier.release();
      await removeApiKeyUsageBarrier(ctx.admin);
    }
  }, 30_000);

  it("keeps a staff access record whose client disconnected while it was being written, and runs no route", async () => {
    const staff = await createUser(ctx.admin, { displayName: "Lifecycle staff", isStaff: true });
    const staffKey = await createApiKey(ctx.admin, { tenantId: null, userId: staff.id });
    const objid = 102;
    await installStaffAccessBarrier(ctx.admin, objid);
    const barrier = new TicketBarrier(ctx.admin, objid);
    openGates("staff-stale");
    try {
      await barrier.hold();
      const stale = httpGet(port, "/__lifecycle/gated?id=staff-stale", staffKey, { "x-ticketry-tenant": tenantA.slug });
      await barrier.awaitReached(TIMEOUT_MS);
      stale.destroy();
      await bounded(stale.done, "stale socket close");

      // Let the record's insert finish: the disconnect must keep it, and must still stop the route.
      await barrier.release();
      await expectPoolClean();
      const records = await ctx.admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM audit_log
         WHERE tenant_id = $1 AND actor_id = $2 AND action = 'staff.workspace_access'`,
        [tenantA.id, staff.id]
      );
      expect(records.rows[0]?.count, "staff access record lost to a disconnect during its write").toBe(1);
      expect(handlerRuns, "aborted staff request reached its route handler").not.toContain("staff-stale");
    } finally {
      releaseGates("staff-stale");
      await barrier.release();
      await removeStaffAccessBarrier(ctx.admin);
    }
  }, 30_000);
});

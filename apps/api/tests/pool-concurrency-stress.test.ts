import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import {
  addMembership,
  createApiKey,
  createMember,
  createTenant,
  createTestContext,
  createUser,
  revokeApiKey,
  revokeMembership,
  seedComment,
  seedTicket
} from "@ticketry/test-support";
import type { TestContext, TestTenant, TestUser } from "@ticketry/test-support";
import type { Pool, PoolClient } from "@ticketry/db";

import { buildApp } from "../src/app.js";
import { auth } from "./helpers.js";
import {
  TicketBarrier,
  barrierSubject,
  installTicketInsertBarrier,
  removeTicketInsertBarrier,
  waitUntil
} from "./support/barrier.js";

const API_REUSE_CYCLES = 25;
const OPERATION_TIMEOUT_MS = 10_000;

interface Deferred<T> {
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
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${OPERATION_TIMEOUT_MS}ms`)), OPERATION_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectPoolClean(pool: Pool, max: number): Promise<void> {
  // Socket-abort cleanup is asynchronous: the request can observe its rollback
  // before the finalization hook has returned the client to the pool. Wait for
  // that boundary instead of making the assertion depend on event-loop timing.
  await waitUntil(
    async () => pool.waitingCount === 0 && pool.totalCount - pool.idleCount === 0,
    OPERATION_TIMEOUT_MS,
    "pool cleanup"
  );
  const clients: PoolClient[] = [];
  try {
    for (let index = 0; index < max; index += 1) {
      clients.push(await bounded(pool.connect(), `borrow pool client ${index + 1}`));
    }
    // A reborrowed connection that retained workspace scope would still see its
    // previous tenant's rows; clean reuse leaves every protected read empty.
    const reads = await Promise.all(
      clients.map((client) => client.query<{ count: number }>("SELECT count(*)::int AS count FROM tenants"))
    );
    for (const result of reads) {
      expect(result.rows[0]?.count, "reborrowed connection retained workspace scope").toBe(0);
    }
  } finally {
    clients.forEach((client) => client.release());
  }
  expect(pool.totalCount - pool.idleCount).toBe(0);
}

interface LiveRequest {
  destroy(): void;
  done: Promise<void>;
}

function postTicket(port: number, apiKey: string, subject: string): LiveRequest {
  const body = JSON.stringify({ subject, body: `body:${subject}` });
  const finished = deferred<void>();
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/tickets",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    }
  });
  request.on("response", (response) => {
    response.resume();
    response.on("end", () => finished.resolve());
  });
  request.on("error", () => finished.resolve());
  request.end(body);
  return { destroy: () => request.destroy(), done: finished.promise };
}

interface Fixture {
  ctx: TestContext;
  app: FastifyInstance;
  tenantA: TestTenant;
  tenantB: TestTenant;
  agentA: { user: TestUser; apiKey: string };
  agentB: { user: TestUser; apiKey: string };
  shared: TestUser;
  sharedKeyA: string;
  sharedKeyB: string;
  staff: TestUser;
  staffKey: string;
  revokedMembershipKey: string;
  revokedApiKey: string;
  disabledKey: string;
  ticketA: { id: string; number: number };
  ticketB: { id: string; number: number };
  commentB: string;
  viewB: string;
  exportA: string;
  exportB: string;
}

async function createFixture(poolMax: number): Promise<Fixture> {
  const ctx = await createTestContext({ appPoolMax: poolMax });
  const app = buildApp({ pool: ctx.app });
  await app.ready();

  const tenantA = await createTenant(ctx.admin, `stress-alpha-${poolMax}`);
  const tenantB = await createTenant(ctx.admin, `stress-beta-${poolMax}`);
  const agentA = await createMember(ctx.admin, tenantA.id, "agent");
  const agentB = await createMember(ctx.admin, tenantB.id, "agent");
  const shared = await createUser(ctx.admin, { displayName: `Shared ${poolMax}` });
  await addMembership(ctx.admin, tenantA.id, shared.id, "agent");
  await addMembership(ctx.admin, tenantB.id, shared.id, "viewer");
  const sharedKeyA = await createApiKey(ctx.admin, { tenantId: tenantA.id, userId: shared.id });
  const sharedKeyB = await createApiKey(ctx.admin, { tenantId: tenantB.id, userId: shared.id });
  const staff = await createUser(ctx.admin, { displayName: `Staff ${poolMax}`, isStaff: true });
  const staffKey = await createApiKey(ctx.admin, { tenantId: null, userId: staff.id });

  const revokedMember = await createMember(ctx.admin, tenantA.id, "agent");
  await revokeMembership(ctx.admin, tenantA.id, revokedMember.user.id);
  const revokedKeyMember = await createMember(ctx.admin, tenantA.id, "agent");
  await revokeApiKey(ctx.admin, revokedKeyMember.apiKey);
  const disabledMember = await createMember(ctx.admin, tenantB.id, "agent");
  await ctx.admin.query("UPDATE users SET disabled_at = now() WHERE id = $1", [disabledMember.user.id]);

  const ticketA = await seedTicket(ctx.admin, {
    tenantId: tenantA.id,
    requesterId: agentA.user.id,
    subject: `ALPHA_TICKET_${poolMax}`
  });
  const ticketB = await seedTicket(ctx.admin, {
    tenantId: tenantB.id,
    requesterId: agentB.user.id,
    subject: `BETA_TICKET_${poolMax}`
  });
  await seedComment(ctx.admin, {
    tenantId: tenantA.id,
    ticketId: ticketA.id,
    authorId: agentA.user.id,
    body: `ALPHA_COMMENT_${poolMax}`
  });
  const commentB = await seedComment(ctx.admin, {
    tenantId: tenantB.id,
    ticketId: ticketB.id,
    authorId: agentB.user.id,
    body: `BETA_COMMENT_${poolMax}`
  });
  const views = await ctx.admin.query<{ id: string; tenant_id: string }>(
    `INSERT INTO saved_views (tenant_id, owner_id, name, filters)
     VALUES ($1, $3, $4, '{}'), ($2, $5, $6, '{}') RETURNING id, tenant_id`,
    [tenantA.id, tenantB.id, agentA.user.id, `ALPHA_VIEW_${poolMax}`, agentB.user.id, `BETA_VIEW_${poolMax}`]
  );
  const viewA = views.rows.find((row) => row.tenant_id === tenantA.id)!.id;
  const viewB = views.rows.find((row) => row.tenant_id === tenantB.id)!.id;
  const exports = await ctx.admin.query<{ id: string; tenant_id: string }>(
    `INSERT INTO export_jobs (tenant_id, requested_by, view_id, status, row_count, csv, finished_at)
     VALUES ($1, $3, $5, 'done', 1, $7, now()), ($2, $4, $6, 'done', 1, $8, now())
     RETURNING id, tenant_id`,
    [
      tenantA.id,
      tenantB.id,
      agentA.user.id,
      agentB.user.id,
      viewA,
      viewB,
      `ALPHA_CSV_${poolMax}`,
      `BETA_CSV_${poolMax}`
    ]
  );

  return {
    ctx,
    app,
    tenantA,
    tenantB,
    agentA,
    agentB,
    shared,
    sharedKeyA,
    sharedKeyB,
    staff,
    staffKey,
    revokedMembershipKey: revokedMember.apiKey,
    revokedApiKey: revokedKeyMember.apiKey,
    disabledKey: disabledMember.apiKey,
    ticketA,
    ticketB,
    commentB,
    viewB,
    exportA: exports.rows.find((row) => row.tenant_id === tenantA.id)!.id,
    exportB: exports.rows.find((row) => row.tenant_id === tenantB.id)!.id
  };
}

for (const poolMax of [1, 2]) {
  describe(`API pool concurrency stress (max=${poolMax})`, () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await createFixture(poolMax);
    });

    afterAll(async () => {
      await fixture.app.close();
      await fixture.ctx.close();
    });

    it(`survives ${API_REUSE_CYCLES} interleaved tenant reuse cycles`, async () => {
      for (let cycle = 0; cycle < API_REUSE_CYCLES; cycle += 1) {
        const commentA = `alpha-cycle-${poolMax}-${cycle}`;
        const commentB = `beta-cycle-${poolMax}-${cycle}`;
        const staffTenants = cycle % 2 === 0 ? [fixture.tenantA, fixture.tenantB] : [fixture.tenantB, fixture.tenantA];
        const responses = await bounded(
          Promise.all([
            fixture.app.inject({ method: "GET", url: `/tickets/${fixture.ticketA.id}`, headers: auth(fixture.sharedKeyA) }),
            fixture.app.inject({ method: "GET", url: `/tickets/${fixture.ticketB.id}`, headers: auth(fixture.sharedKeyB) }),
            fixture.app.inject({ method: "POST", url: `/tickets/${fixture.ticketA.id}/comments`, headers: auth(fixture.agentA.apiKey), payload: { body: commentA } }),
            fixture.app.inject({ method: "POST", url: `/tickets/${fixture.ticketB.id}/comments`, headers: auth(fixture.agentB.apiKey), payload: { body: commentB } }),
            ...staffTenants.map((tenant) => fixture.app.inject({ method: "GET", url: "/me", headers: auth(fixture.staffKey, { "x-ticketry-tenant": tenant.slug }) })),
            fixture.app.inject({ method: "GET", url: `/tickets/${fixture.ticketB.id}/comments`, headers: auth(fixture.sharedKeyA) }),
            fixture.app.inject({ method: "GET", url: `/views/${fixture.viewB}/tickets`, headers: auth(fixture.sharedKeyA) }),
            fixture.app.inject({ method: "GET", url: `/exports/${fixture.exportB}`, headers: auth(fixture.sharedKeyA) }),
            fixture.app.inject({ method: "GET", url: `/users/${fixture.agentB.user.id}`, headers: auth(fixture.sharedKeyA) }),
            fixture.app.inject({ method: "POST", url: "/tickets", headers: auth(fixture.agentA.apiKey), payload: { subject: "" } }),
            fixture.app.inject({ method: "GET", url: "/me", headers: auth(fixture.revokedMembershipKey) }),
            fixture.app.inject({ method: "GET", url: "/me", headers: auth(fixture.revokedApiKey) }),
            fixture.app.inject({ method: "GET", url: "/me", headers: auth(fixture.disabledKey) }),
            fixture.app.inject({ method: "GET", url: "/tickets/00000000-0000-4000-8000-000000000000", headers: auth(fixture.agentA.apiKey) }),
            fixture.app.inject({ method: "GET", url: `/exports/${fixture.exportA}`, headers: auth(fixture.sharedKeyA) })
          ]),
          `API cycle ${cycle}`
        );

        expect(responses[0]!.statusCode).toBe(200);
        expect(responses[0]!.json().ticket).toMatchObject({ id: fixture.ticketA.id, subject: `ALPHA_TICKET_${poolMax}` });
        expect(responses[1]!.statusCode).toBe(200);
        expect(responses[1]!.json().ticket).toMatchObject({ id: fixture.ticketB.id, subject: `BETA_TICKET_${poolMax}` });
        expect(responses[2]!.json().comment).toMatchObject({ ticketId: fixture.ticketA.id, body: commentA });
        expect(responses[3]!.json().comment).toMatchObject({ ticketId: fixture.ticketB.id, body: commentB });
        expect(responses[4]!.json().workspace.id).toBe(staffTenants[0]!.id);
        expect(responses[5]!.json().workspace.id).toBe(staffTenants[1]!.id);
        for (const response of responses.slice(6, 10)) expect(response.statusCode).toBe(404);
        expect(responses[6]!.body).not.toContain(fixture.commentB);
        expect(responses[8]!.body).not.toContain(`BETA_CSV_${poolMax}`);
        expect(responses[9]!.body).not.toContain(fixture.agentB.user.email);
        expect(responses[10]!.statusCode).toBe(400);
        expect(responses[10]!.json().error.code).toBe("bad_request");
        expect(responses[11]!.statusCode).toBe(403);
        expect(responses[12]!.statusCode).toBe(401);
        expect(responses[13]!.statusCode).toBe(401);
        expect(responses[14]!.statusCode).toBe(404);
        expect(responses[15]!.json().export).toMatchObject({ id: fixture.exportA, tenantId: fixture.tenantA.id, status: "done" });

        const written = await fixture.ctx.admin.query<{ tenant_id: string; body: string }>(
          "SELECT tenant_id, body FROM comments WHERE body = ANY($1::text[]) ORDER BY body",
          [[commentA, commentB]]
        );
        expect(written.rows).toEqual([
          { tenant_id: fixture.tenantA.id, body: commentA },
          { tenant_id: fixture.tenantB.id, body: commentB }
        ]);
        const timestamps = await fixture.ctx.admin.query<{ tenant_id: string; updated_at: Date; latest_comment: Date }>(
          `SELECT ticket.tenant_id, ticket.updated_at, max(comment.created_at) AS latest_comment
           FROM tickets AS ticket JOIN comments AS comment ON comment.ticket_id = ticket.id
           WHERE ticket.id = ANY($1::uuid[]) GROUP BY ticket.id ORDER BY ticket.tenant_id`,
          [[fixture.ticketA.id, fixture.ticketB.id]]
        );
        expect(timestamps.rows).toHaveLength(2);
        for (const row of timestamps.rows) expect(row.updated_at).toEqual(row.latest_comment);
        const exportRows = await fixture.ctx.admin.query<{ id: string; tenant_id: string; csv: string }>(
          "SELECT id, tenant_id, csv FROM export_jobs WHERE id = ANY($1::uuid[]) ORDER BY tenant_id",
          [[fixture.exportA, fixture.exportB]]
        );
        expect(new Map(exportRows.rows.map((row) => [row.id, [row.tenant_id, row.csv]]))).toEqual(
          new Map([
            [fixture.exportA, [fixture.tenantA.id, `ALPHA_CSV_${poolMax}`]],
            [fixture.exportB, [fixture.tenantB.id, `BETA_CSV_${poolMax}`]]
          ])
        );
        expect((await fixture.ctx.admin.query("SELECT 1 FROM notification_outbox")).rowCount).toBe(0);
        const audit = await fixture.ctx.admin.query<{ tenant_id: string; action: string; count: number }>(
          `SELECT tenant_id, action, count(*)::int AS count FROM audit_log
           WHERE action IN ('comment.created', 'staff.workspace_access')
           GROUP BY tenant_id, action ORDER BY tenant_id, action`
        );
        for (const tenant of [fixture.tenantA, fixture.tenantB]) {
          expect(audit.rows.find((row) => row.tenant_id === tenant.id && row.action === "comment.created")?.count).toBe(cycle + 1);
          expect(audit.rows.find((row) => row.tenant_id === tenant.id && row.action === "staff.workspace_access")?.count).toBe(cycle + 1);
        }
        if (poolMax === 1) {
          const selfRead = await bounded(
            fixture.app.inject({ method: "GET", url: "/me", headers: auth(fixture.sharedKeyA) }),
            `size-one self read ${cycle}`
          );
          expect(selfRead.statusCode).toBe(200);
          expect(selfRead.json().memberships).toEqual([
            { tenantSlug: fixture.tenantA.slug, role: "agent" },
            { tenantSlug: fixture.tenantB.slug, role: "viewer" }
          ]);
          const followingUser = await bounded(
            fixture.app.inject({
              method: "GET",
              url: `/tickets/${fixture.ticketB.id}`,
              headers: auth(fixture.agentB.apiKey)
            }),
            `size-one following user ${cycle}`
          );
          expect(followingUser.statusCode).toBe(200);
          expect(followingUser.json().ticket.id).toBe(fixture.ticketB.id);
        }
        await expectPoolClean(fixture.ctx.app, poolMax);
      }
    }, 120_000);

    it("rolls back a real socket abort before commit and retains a close after commit", async () => {
      await installTicketInsertBarrier(fixture.ctx.admin);
      await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const address = fixture.app.server.address() as AddressInfo;

      const auditsFor = async (): Promise<number> =>
        (
          await fixture.ctx.admin.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'ticket.created'",
            [fixture.tenantA.id]
          )
        ).rows[0]!.n;

      try {
        // --- Pre-commit abort: the mutation is reached, the socket is aborted,
        // and the route transaction must roll back its ticket and its audit. ---
        const beforeObjid = poolMax * 10 + 1;
        const beforeMarker = barrierSubject(beforeObjid);
        const beforeBarrier = new TicketBarrier(fixture.ctx.admin, beforeObjid);
        const auditBaseline = await auditsFor();
        await beforeBarrier.hold();
        const aborted = postTicket(address.port, fixture.agentA.apiKey, beforeMarker);
        await beforeBarrier.awaitReached(OPERATION_TIMEOUT_MS);
        aborted.destroy();
        await beforeBarrier.release();
        await bounded(aborted.done, "aborted request close");
        await waitUntil(
          async () =>
            (await fixture.ctx.admin.query("SELECT 1 FROM tickets WHERE subject = $1", [beforeMarker])).rowCount === 0,
          OPERATION_TIMEOUT_MS,
          "pre-commit rollback"
        );
        expect((await fixture.ctx.admin.query("SELECT 1 FROM tickets WHERE subject = $1", [beforeMarker])).rowCount).toBe(0);
        // Detecting the orphaned business audit requires correlating on the real
        // action/tenant, not the never-recorded metadata.subject field.
        expect(await auditsFor()).toBe(auditBaseline);
        await expectPoolClean(fixture.ctx.app, poolMax);

        // --- Close after commit: the commit is confirmed first, then the socket
        // closes; the committed ticket and its audit must remain. ---
        const afterObjid = poolMax * 10 + 2;
        const afterMarker = barrierSubject(afterObjid);
        const afterBarrier = new TicketBarrier(fixture.ctx.admin, afterObjid);
        await afterBarrier.hold();
        const committed = postTicket(address.port, fixture.agentA.apiKey, afterMarker);
        await afterBarrier.awaitReached(OPERATION_TIMEOUT_MS);
        await afterBarrier.release();
        await waitUntil(
          async () =>
            (await fixture.ctx.admin.query("SELECT 1 FROM tickets WHERE subject = $1", [afterMarker])).rowCount === 1,
          OPERATION_TIMEOUT_MS,
          "confirmed route commit"
        );
        const committedTicket = await fixture.ctx.admin.query<{ id: string; tenant_id: string }>(
          "SELECT id, tenant_id FROM tickets WHERE subject = $1",
          [afterMarker]
        );
        expect(committedTicket.rows.map((row) => row.tenant_id)).toEqual([fixture.tenantA.id]);
        // A close observed after the commit must not undo it.
        committed.destroy();
        await bounded(committed.done, "post-commit request close");
        expect((await fixture.ctx.admin.query("SELECT tenant_id FROM tickets WHERE subject = $1", [afterMarker])).rows).toEqual([
          { tenant_id: fixture.tenantA.id }
        ]);
        // The committed ticket's business audit is durable and correctly scoped.
        expect(
          (
            await fixture.ctx.admin.query(
              "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'ticket.created' AND tenant_id = $2",
              [committedTicket.rows[0]!.id, fixture.tenantA.id]
            )
          ).rowCount
        ).toBe(1);
        await expectPoolClean(fixture.ctx.app, poolMax);
      } finally {
        await removeTicketInsertBarrier(fixture.ctx.admin);
      }
    }, 60_000);
  });
}

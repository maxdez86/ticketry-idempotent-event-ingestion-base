import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMembership,
  createTenant,
  createTestContext,
  createUser,
  seedTicket
} from "@ticketry/test-support";
import type { TestContext, TestTenant, TestUser } from "@ticketry/test-support";
import type { Pool } from "@ticketry/db";

import { runDigest, runExports, runSlaSweep } from "../src/index.js";

const WORKER_REUSE_CYCLES = 12;
const OPERATION_TIMEOUT_MS = 15_000;

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

async function expectPoolClean(pool: Pool): Promise<void> {
  expect(pool.waitingCount).toBe(0);
  expect(pool.totalCount - pool.idleCount).toBe(0);
  const first = await bounded(pool.connect(), "borrow first worker pool client");
  const second = await bounded(pool.connect(), "borrow second worker pool client");
  try {
    for (const client of [first, second]) {
      // A reborrowed connection carrying residual scope would still see its
      // previous tenant's rows; with clean reuse a protected read is empty.
      const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM tenants");
      expect(result.rows[0]?.count, "reborrowed connection retained workspace scope").toBe(0);
    }
  } finally {
    first.release();
    second.release();
  }
  expect(pool.totalCount - pool.idleCount).toBe(0);
}

describe("worker pool concurrency and adversarial stress", () => {
  let ctx: TestContext;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let shared: TestUser;
  let viewA: string;
  let viewB: string;
  let brokenViewA: string;

  beforeAll(async () => {
    ctx = await createTestContext({ appPoolMax: 2 });
    tenantA = await createTenant(ctx.admin, "worker-stress-alpha");
    tenantB = await createTenant(ctx.admin, "worker-stress-beta");
    shared = await createUser(ctx.admin, { displayName: "Worker Stress Shared" });
    await addMembership(ctx.admin, tenantA.id, shared.id, "agent");
    await addMembership(ctx.admin, tenantB.id, shared.id, "agent");
    await seedTicket(ctx.admin, {
      tenantId: tenantA.id,
      requesterId: shared.id,
      assigneeId: shared.id,
      subject: "ALPHA_WORKER_SENTINEL"
    });
    await seedTicket(ctx.admin, {
      tenantId: tenantB.id,
      requesterId: shared.id,
      assigneeId: shared.id,
      subject: "BETA_WORKER_SENTINEL"
    });
    const views = await ctx.admin.query<{ id: string; tenant_id: string; name: string }>(
      `INSERT INTO saved_views (tenant_id, owner_id, name, filters)
       VALUES ($1, $3, 'alpha-valid', '{}'),
              ($2, $3, 'beta-valid', '{}'),
              ($1, $3, 'alpha-broken', '{"assigneeId":"not-a-uuid"}')
       RETURNING id, tenant_id, name`,
      [tenantA.id, tenantB.id, shared.id]
    );
    viewA = views.rows.find((row) => row.name === "alpha-valid")!.id;
    viewB = views.rows.find((row) => row.name === "beta-valid")!.id;
    brokenViewA = views.rows.find((row) => row.name === "alpha-broken")!.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it(`reuses a two-client pool for ${WORKER_REUSE_CYCLES} forced-overlap cycles`, async () => {
    for (let cycle = 0; cycle < WORKER_REUSE_CYCLES; cycle += 1) {
      const now = new Date(Date.UTC(2026, 7, 10, 0, cycle));
      const overdueA = await seedTicket(ctx.admin, {
        tenantId: tenantA.id,
        requesterId: shared.id,
        assigneeId: shared.id,
        subject: `ALPHA_OVERDUE_${cycle}`,
        slaDueAt: new Date(now.getTime() - 60_000)
      });
      const overdueB = await seedTicket(ctx.admin, {
        tenantId: tenantB.id,
        requesterId: shared.id,
        assigneeId: shared.id,
        subject: `BETA_OVERDUE_${cycle}`,
        slaDueAt: new Date(now.getTime() - 60_000)
      });
      const jobs = await ctx.admin.query<{ id: string; tenant_id: string; view_id: string }>(
        `INSERT INTO export_jobs (tenant_id, requested_by, view_id, created_at)
         VALUES ($1, $3, $4, $7), ($2, $3, $5, $7 + interval '1 second'),
                ($1, $3, $6, $7 + interval '2 seconds'), ($2, $3, $5, $7 + interval '3 seconds'),
                ($1, $3, $4, $7 + interval '4 seconds'), ($2, $3, $5, $7 + interval '5 seconds')
         RETURNING id, tenant_id, view_id`,
        [tenantA.id, tenantB.id, shared.id, viewA, viewB, brokenViewA, now]
      );

      // Overlapping capped invocations must not double-claim a job. Valid
      // serialization satisfies the contract, so we do not force two claims to
      // be held at once; we assert unique, complete, correctly scoped work.
      const cappedRuns = await bounded(
        Promise.all([
          runExports(ctx.app, 1, now),
          runExports(ctx.app, 1, now),
          runExports(ctx.app, 1, now)
        ]),
        `concurrent export claims in cycle ${cycle}`
      );
      for (const result of cappedRuns) expect(result.processed.length).toBeLessThanOrEqual(1);
      const firstPassIds = cappedRuns.flatMap((result) => result.processed.map((job) => job.id));
      expect(new Set(firstPassIds).size).toBe(firstPassIds.length);
      expect(firstPassIds).toHaveLength(3);

      const remainingBeforeClean = await ctx.admin.query<{ id: string }>(
        "SELECT id FROM export_jobs WHERE id = ANY($1::uuid[]) AND status = 'queued'",
        [jobs.rows.map((row) => row.id)]
      );
      expect(remainingBeforeClean.rowCount).toBe(3);
      const clean = await bounded(runExports(ctx.app, 10, now), `clean export drain in cycle ${cycle}`);
      expect(clean.processed.length).toBeLessThanOrEqual(10);
      const allProcessedIds = [...firstPassIds, ...clean.processed.map((job) => job.id)];
      expect(allProcessedIds.sort()).toEqual(jobs.rows.map((row) => row.id).sort());
      expect(new Set(allProcessedIds).size).toBe(jobs.rows.length);

      const persisted = await ctx.admin.query<{
        id: string;
        tenant_id: string;
        status: string;
        csv: string | null;
      }>("SELECT id, tenant_id, status, csv FROM export_jobs WHERE id = ANY($1::uuid[])", [jobs.rows.map((row) => row.id)]);
      expect(persisted.rows.filter((row) => row.status === "failed")).toHaveLength(1);
      for (const row of persisted.rows) {
        const fixture = jobs.rows.find((job) => job.id === row.id)!;
        expect(row.tenant_id).toBe(fixture.tenant_id);
        if (row.status === "done" && row.tenant_id === tenantA.id) {
          expect(row.csv).toContain("ALPHA_WORKER_SENTINEL");
          expect(row.csv).not.toContain("BETA_WORKER_SENTINEL");
        }
        if (row.status === "done" && row.tenant_id === tenantB.id) {
          expect(row.csv).toContain("BETA_WORKER_SENTINEL");
          expect(row.csv).not.toContain("ALPHA_WORKER_SENTINEL");
        }
      }
      const exportAudit = await ctx.admin.query<{ target_id: string; tenant_id: string; count: number }>(
        `SELECT target_id, tenant_id, count(*)::int AS count FROM audit_log
         WHERE target_id = ANY($1::text[]) AND action IN ('export.completed', 'export.failed')
         GROUP BY target_id, tenant_id`,
        [jobs.rows.map((row) => row.id)]
      );
      expect(exportAudit.rows).toHaveLength(jobs.rows.length);
      for (const row of exportAudit.rows) {
        expect(row.count).toBe(1);
        expect(row.tenant_id).toBe(jobs.rows.find((job) => job.id === row.target_id)!.tenant_id);
      }

      const sweeps = await bounded(
        Promise.all([runSlaSweep(ctx.app, now), runSlaSweep(ctx.app, now), runSlaSweep(ctx.app, now)]),
        `SLA sweeps in cycle ${cycle}`
      );
      expect(sweeps.reduce((sum, result) => sum + result.breached, 0)).toBe(2);
      const slaAudit = await ctx.admin.query<{ target_id: string; tenant_id: string; count: number }>(
        `SELECT target_id, tenant_id, count(*)::int AS count FROM audit_log
         WHERE target_id = ANY($1::text[]) AND action = 'ticket.sla_breached'
         GROUP BY target_id, tenant_id`,
        [[overdueA.id, overdueB.id]]
      );
      expect(slaAudit.rows).toEqual(expect.arrayContaining([
        { target_id: overdueA.id, tenant_id: tenantA.id, count: 1 },
        { target_id: overdueB.id, tenant_id: tenantB.id, count: 1 }
      ]));
      expect(slaAudit.rows).toHaveLength(2);

      const digestRuns = await bounded(
        Promise.all([runDigest(ctx.app, now), runDigest(ctx.app, now)]),
        `digest runs in cycle ${cycle}`
      );
      expect(digestRuns.every((result) => result.notificationsQueued === 2)).toBe(true);
      const digests = await ctx.admin.query<{ tenant_id: string; payload: { generatedAt: string; tickets: { subject: string }[] } }>(
        `SELECT tenant_id, payload FROM notification_outbox
         WHERE kind = 'daily_digest' AND payload->>'generatedAt' = $1`,
        [now.toISOString()]
      );
      expect(digests.rows).toHaveLength(4);
      for (const row of digests.rows) {
        const subjects = row.payload.tickets.map((ticket) => ticket.subject);
        if (row.tenant_id === tenantA.id) {
          expect(subjects).toContain("ALPHA_WORKER_SENTINEL");
          expect(subjects.some((subject) => subject.startsWith("BETA_"))).toBe(false);
        } else {
          expect(row.tenant_id).toBe(tenantB.id);
          expect(subjects).toContain("BETA_WORKER_SENTINEL");
          expect(subjects.some((subject) => subject.startsWith("ALPHA_"))).toBe(false);
        }
      }
      await expectPoolClean(ctx.app);
    }
  }, 120_000);

  it("rolls back one tenant's controlled digest error and recovers on a clean run", async () => {
    const failedAt = new Date("2026-08-11T00:00:00.000Z");
    await ctx.admin.query(`
      CREATE FUNCTION fail_stress_alpha_digest() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tenant_id = '${tenantA.id}'::uuid AND NEW.payload->>'generatedAt' = '${failedAt.toISOString()}'
        THEN RAISE EXCEPTION 'controlled stress tenant failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_stress_alpha_digest BEFORE INSERT ON notification_outbox
      FOR EACH ROW EXECUTE FUNCTION fail_stress_alpha_digest();
    `);
    try {
      await expect(bounded(runDigest(ctx.app, failedAt), "controlled digest failure")).rejects.toThrow();
    } finally {
      await ctx.admin.query("DROP TRIGGER fail_stress_alpha_digest ON notification_outbox; DROP FUNCTION fail_stress_alpha_digest()")
    }
    const failedRun = await ctx.admin.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM notification_outbox WHERE payload->>'generatedAt' = $1",
      [failedAt.toISOString()]
    );
    expect(failedRun.rows).toEqual([{ tenant_id: tenantB.id }]);

    const recoveredAt = new Date("2026-08-11T00:01:00.000Z");
    const recovered = await bounded(runDigest(ctx.app, recoveredAt), "digest recovery run");
    expect(recovered.notificationsQueued).toBe(2);
    const recoveredRows = await ctx.admin.query<{ tenant_id: string; payload: { tickets: { subject: string }[] } }>(
      "SELECT tenant_id, payload FROM notification_outbox WHERE payload->>'generatedAt' = $1 ORDER BY tenant_id",
      [recoveredAt.toISOString()]
    );
    expect(recoveredRows.rows.map((row) => row.tenant_id).sort()).toEqual([tenantA.id, tenantB.id].sort());
    for (const row of recoveredRows.rows) {
      const serialized = JSON.stringify(row.payload);
      if (row.tenant_id === tenantA.id) expect(serialized).not.toContain("BETA_");
      if (row.tenant_id === tenantB.id) expect(serialized).not.toContain("ALPHA_");
    }
    expect((await ctx.admin.query("SELECT 1 FROM export_jobs WHERE status = 'queued'")).rowCount).toBe(0);
    await expectPoolClean(ctx.app);
  }, 60_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPendingNotifications } from "@ticketry/core";
import {
  addMembership,
  createTenant,
  createTestContext,
  createUser,
  revokeMembership,
  seedTicket
} from "@ticketry/test-support";
import type { TestContext, TestTenant, TestUser } from "@ticketry/test-support";

import { runDigest, runExports, runSlaSweep } from "../src/index.js";

describe("worker tenant-isolation acceptance", () => {
  let ctx: TestContext;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let shared: TestUser;

  beforeAll(async () => {
    ctx = await createTestContext({ appPoolMax: 2 });
    tenantA = await createTenant(ctx.admin, "worker-alpha");
    tenantB = await createTenant(ctx.admin, "worker-beta");
    shared = await createUser(ctx.admin, { displayName: "Shared Worker User" });
    await addMembership(ctx.admin, tenantA.id, shared.id, "agent");
    await addMembership(ctx.admin, tenantB.id, shared.id, "agent");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("sweeps every tenant exactly once while ignoring ineligible SLA rows", async () => {
    const now = new Date("2026-08-02T12:00:00Z");
    const breachedA = await seedTicket(ctx.admin, {
      tenantId: tenantA.id,
      requesterId: shared.id,
      subject: "same overdue",
      slaDueAt: new Date("2026-08-01T12:00:00Z")
    });
    const breachedB = await seedTicket(ctx.admin, {
      tenantId: tenantB.id,
      requesterId: shared.id,
      subject: "same overdue",
      status: "pending",
      slaDueAt: new Date("2026-08-01T12:00:00Z")
    });
    const ignored = [
      await seedTicket(ctx.admin, {
        tenantId: tenantA.id,
        requesterId: shared.id,
        status: "solved",
        slaDueAt: new Date("2026-08-01T12:00:00Z")
      }),
      await seedTicket(ctx.admin, {
        tenantId: tenantB.id,
        requesterId: shared.id,
        slaDueAt: new Date("2026-08-03T12:00:00Z")
      }),
      await seedTicket(ctx.admin, { tenantId: tenantB.id, requesterId: shared.id, slaDueAt: null })
    ];

    const [first, concurrent] = await Promise.all([runSlaSweep(ctx.app, now), runSlaSweep(ctx.app, now)]);
    expect(first.breached + concurrent.breached).toBe(2);
    expect((await runSlaSweep(ctx.app, now)).breached).toBe(0);
    const rows = await ctx.admin.query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM tickets WHERE sla_breached ORDER BY tenant_id"
    );
    expect(new Map(rows.rows.map((row) => [row.id, row.tenant_id]))).toEqual(
      new Map([
        [breachedA.id, tenantA.id],
        [breachedB.id, tenantB.id]
      ])
    );
    for (const ticket of ignored) {
      expect(rows.rows.some((row) => row.id === ticket.id)).toBe(false);
    }
    const audit = await ctx.admin.query<{ tenant_id: string; target_id: string }>(
      "SELECT tenant_id, target_id FROM audit_log WHERE action = 'ticket.sla_breached'"
    );
    expect(new Map(audit.rows.map((row) => [row.target_id, row.tenant_id]))).toEqual(
      new Map([
        [breachedA.id, tenantA.id],
        [breachedB.id, tenantB.id]
      ])
    );
  });

  it("builds ordered tenant-local digests only for active users and memberships", async () => {
    const now = new Date("2026-08-03T08:00:00Z");
    const firstA = await seedTicket(ctx.admin, {
      tenantId: tenantA.id,
      requesterId: shared.id,
      assigneeId: shared.id,
      subject: "Alpha urgent",
      slaDueAt: new Date("2026-08-02T08:00:00Z")
    });
    const secondA = await seedTicket(ctx.admin, {
      tenantId: tenantA.id,
      requesterId: shared.id,
      assigneeId: shared.id,
      subject: "Alpha later",
      slaDueAt: new Date("2026-08-05T08:00:00Z")
    });
    const onlyB = await seedTicket(ctx.admin, {
      tenantId: tenantB.id,
      requesterId: shared.id,
      assigneeId: shared.id,
      subject: "Beta only",
      slaDueAt: new Date("2026-08-04T08:00:00Z")
    });
    await runSlaSweep(ctx.app, now);

    const empty = await createUser(ctx.admin);
    await addMembership(ctx.admin, tenantA.id, empty.id, "agent");
    const revoked = await createUser(ctx.admin);
    await addMembership(ctx.admin, tenantA.id, revoked.id, "agent");
    await revokeMembership(ctx.admin, tenantA.id, revoked.id);
    await seedTicket(ctx.admin, {
      tenantId: tenantA.id,
      requesterId: shared.id,
      assigneeId: revoked.id,
      subject: "revoked assignment"
    });
    const disabled = await createUser(ctx.admin);
    await addMembership(ctx.admin, tenantB.id, disabled.id, "agent");
    await ctx.admin.query("UPDATE users SET disabled_at = now() WHERE id = $1", [disabled.id]);
    await seedTicket(ctx.admin, {
      tenantId: tenantB.id,
      requesterId: shared.id,
      assigneeId: disabled.id,
      subject: "disabled assignment"
    });

    const result = await runDigest(ctx.app, now);
    expect(result.notificationsQueued).toBe(2);
    const messages = await ctx.admin.query<{ tenant_id: string; user_id: string; payload: { tickets: { id: string }[] } }>(
      "SELECT tenant_id, user_id, payload FROM notification_outbox WHERE kind = 'daily_digest' ORDER BY tenant_id"
    );
    expect(messages.rows).toHaveLength(2);
    const byTenant = new Map(messages.rows.map((row) => [row.tenant_id, row]));
    expect(byTenant.get(tenantA.id)?.user_id).toBe(shared.id);
    expect(byTenant.get(tenantA.id)?.payload.tickets.map((ticket) => ticket.id)).toEqual([firstA.id, secondA.id]);
    expect(byTenant.get(tenantB.id)?.payload.tickets.map((ticket) => ticket.id)).toEqual([onlyB.id]);
    expect(messages.rows.some((row) => [empty.id, revoked.id, disabled.id].includes(row.user_id))).toBe(false);
  });

  it("exports both tenants with scoped views and keeps completion/failure state in the owner tenant", async () => {
    const ownA = await seedTicket(ctx.admin, {
      tenantId: tenantA.id,
      requesterId: shared.id,
      subject: "ALPHA_EXPORT_SENTINEL",
      priority: "high"
    });
    const ownB = await seedTicket(ctx.admin, {
      tenantId: tenantB.id,
      requesterId: shared.id,
      subject: "BETA_EXPORT_SENTINEL",
      priority: "low"
    });
    const views = await ctx.admin.query<{ id: string; tenant_id: string }>(
      `INSERT INTO saved_views (tenant_id, owner_id, name, filters)
       VALUES ($1, $3, 'High subset', '{"priority":"high"}'),
              ($2, $3, 'Low subset', '{"priority":"low"}'),
              ($1, $3, 'Broken subset', '{"assigneeId":"not-a-uuid"}')
       RETURNING id, tenant_id`,
      [tenantA.id, tenantB.id, shared.id]
    );
    const viewA = views.rows.find((row) => row.tenant_id === tenantA.id)!.id;
    const viewB = views.rows.find((row) => row.tenant_id === tenantB.id)!.id;
    const brokenView = views.rows.filter((row) => row.tenant_id === tenantA.id)[1]!.id;
    const jobs = await ctx.admin.query<{ id: string; tenant_id: string }>(
      `INSERT INTO export_jobs (tenant_id, requested_by, view_id, created_at)
       VALUES ($1, $3, $4, '2026-08-01T00:00:00Z'),
              ($2, $3, $5, '2026-08-01T00:00:01Z'),
              ($1, $3, $6, '2026-08-01T00:00:02Z')
       RETURNING id, tenant_id`,
      [tenantA.id, tenantB.id, shared.id, viewA, viewB, brokenView]
    );

    const run = await runExports(ctx.app, 10, new Date("2026-08-04T00:00:00Z"));
    expect(run.processed).toHaveLength(3);
    const persisted = await ctx.admin.query<{
      id: string;
      tenant_id: string;
      status: string;
      csv: string | null;
      row_count: number | null;
    }>("SELECT id, tenant_id, status, csv, row_count FROM export_jobs WHERE id = ANY($1::uuid[])", [jobs.rows.map((row) => row.id)]);
    for (const row of persisted.rows) {
      expect(row.tenant_id).toBe(jobs.rows.find((job) => job.id === row.id)?.tenant_id);
      if (row.status === "done" && row.tenant_id === tenantA.id) {
        expect(row.csv).toContain(ownA.id ? "ALPHA_EXPORT_SENTINEL" : "unreachable");
        expect(row.csv).not.toContain("BETA_EXPORT_SENTINEL");
      }
      if (row.status === "done" && row.tenant_id === tenantB.id) {
        expect(row.csv).toContain(ownB.id ? "BETA_EXPORT_SENTINEL" : "unreachable");
        expect(row.csv).not.toContain("ALPHA_EXPORT_SENTINEL");
      }
    }
    expect(persisted.rows.filter((row) => row.status === "done")).toHaveLength(2);
    expect(persisted.rows.filter((row) => row.status === "failed")).toHaveLength(1);
    const audit = await ctx.admin.query<{ tenant_id: string; target_id: string; action: string }>(
      "SELECT tenant_id, target_id, action FROM audit_log WHERE target_id = ANY($1::text[])",
      [jobs.rows.map((row) => row.id)]
    );
    expect(audit.rows).toHaveLength(3);
    for (const row of audit.rows) {
      expect(row.tenant_id).toBe(jobs.rows.find((job) => job.id === row.target_id)?.tenant_id);
      expect(["export.completed", "export.failed"]).toContain(row.action);
    }
  });

  it("does not double-claim work, applies maxJobs globally, and leaves failed tenant scope behind", async () => {
    const queued = await ctx.admin.query<{ id: string }>(
      `INSERT INTO export_jobs (tenant_id, requested_by, created_at)
       VALUES ($1, $3, '2026-08-05T00:00:00Z'),
              ($1, $3, '2026-08-05T00:00:01Z'),
              ($2, $3, '2026-08-05T00:00:02Z') RETURNING id`,
      [tenantA.id, tenantB.id, shared.id]
    );
    const capped = await runExports(ctx.app, 1, new Date("2026-08-05T01:00:00Z"));
    expect(capped.processed).toHaveLength(1);
    const remaining = await ctx.admin.query<{ id: string }>(
      "SELECT id FROM export_jobs WHERE id = ANY($1::uuid[]) AND status = 'queued'",
      [queued.rows.map((row) => row.id)]
    );
    expect(remaining.rowCount).toBe(2);

    const concurrent = await Promise.all([
      runExports(ctx.app, 10, new Date("2026-08-05T02:00:00Z")),
      runExports(ctx.app, 10, new Date("2026-08-05T02:00:00Z"))
    ]);
    expect(concurrent.flatMap((result) => result.processed).map((job) => job.id).sort()).toEqual(
      remaining.rows.map((row) => row.id).sort()
    );
    expect((await ctx.admin.query("SELECT 1 FROM export_jobs WHERE id = ANY($1::uuid[]) AND status = 'done'", [queued.rows.map((row) => row.id)])).rowCount).toBe(3);

    await ctx.admin.query(`
      CREATE FUNCTION fail_alpha_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tenant_id = '${tenantA.id}'::uuid THEN RAISE EXCEPTION 'controlled tenant failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_alpha_outbox BEFORE INSERT ON notification_outbox
      FOR EACH ROW EXECUTE FUNCTION fail_alpha_outbox();
    `);
    try {
      // The run must surface the tenant failure; its error class is not a
      // retained contract, so we assert the report and the tenant-local effect.
      await expect(runDigest(ctx.app, new Date("2026-08-06T00:00:00Z"))).rejects.toThrow();
    } finally {
      await ctx.admin.query("DROP TRIGGER fail_alpha_outbox ON notification_outbox; DROP FUNCTION fail_alpha_outbox()")
    }
    expect((await ctx.app.query("SELECT id FROM tenants")).rowCount).toBe(0);
    const tenantBPending = await listPendingNotifications(ctx.admin, tenantB.id);
    expect(tenantBPending.some((message) => message.userId === shared.id)).toBe(true);
  });
});

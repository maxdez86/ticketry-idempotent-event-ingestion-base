import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPendingNotifications } from "@ticketry/core";
import {
  addMembership,
  createTenant,
  createTestContext,
  createUser,
  seedTicket
} from "@ticketry/test-support";
import type { TestContext, TestTenant, TestUser } from "@ticketry/test-support";

import { runDigest, runExports, runSlaSweep } from "../src/index.js";

describe("worker jobs", () => {
  let ctx: TestContext;
  let tenant: TestTenant;
  let requester: TestUser;
  let agent: TestUser;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenant = await createTenant(ctx.admin);
    requester = await createUser(ctx.admin);
    agent = await createUser(ctx.admin);
    await addMembership(ctx.admin, tenant.id, requester.id, "viewer");
    await addMembership(ctx.admin, tenant.id, agent.id, "agent");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("flags overdue active tickets exactly once and audits each breach", async () => {
    const now = new Date("2026-03-02T12:00:00Z");
    const overdueOpen = await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, slaDueAt: new Date("2026-03-02T11:00:00Z") });
    const overduePending = await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, status: "pending", slaDueAt: new Date("2026-03-01T00:00:00Z") });
    const overdueSolved = await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, status: "solved", slaDueAt: new Date("2026-03-01T00:00:00Z") });
    const notYet = await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, slaDueAt: new Date("2026-03-02T12:00:01Z") });
    const noSla = await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, slaDueAt: null });

    const first = await runSlaSweep(ctx.app, now);
    expect(first.breached).toBe(2);
    const second = await runSlaSweep(ctx.app, now);
    expect(second.breached).toBe(0);

    const flagged = await ctx.admin.query<{ id: string }>(
      "SELECT id FROM tickets WHERE tenant_id = $1 AND sla_breached ORDER BY number",
      [tenant.id]
    );
    expect(flagged.rows.map((row) => row.id)).toEqual([overdueOpen.id, overduePending.id]);
    for (const untouched of [overdueSolved, notYet, noSla]) {
      expect(flagged.rows.map((row) => row.id)).not.toContain(untouched.id);
    }

    const audit = await ctx.admin.query<{ target_id: string; metadata: { number: number } }>(
      "SELECT target_id, metadata FROM audit_log WHERE tenant_id = $1 AND action = 'ticket.sla_breached' ORDER BY id",
      [tenant.id]
    );
    expect(audit.rows.map((row) => [row.target_id, row.metadata.number])).toEqual([
      [overdueOpen.id, overdueOpen.number],
      [overduePending.id, overduePending.number]
    ]);
  });

  it("queues a digest per active membership listing the member's open assignments", async () => {
    const now = new Date("2026-03-03T08:00:00Z");
    const assignedLate = await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, assigneeId: agent.id, subject: "Late", slaDueAt: new Date("2026-03-01T00:00:00Z") });
    const assignedSoon = await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, assigneeId: agent.id, subject: "Soon", slaDueAt: new Date("2026-03-04T00:00:00Z") });
    await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, assigneeId: agent.id, subject: "Done", status: "closed" });
    await runSlaSweep(ctx.app, now);

    const result = await runDigest(ctx.app, now);
    expect(result.notificationsQueued).toBeGreaterThanOrEqual(1);

    const pending = await listPendingNotifications(ctx.admin, tenant.id);
    const forAgent = pending.filter((message) => message.userId === agent.id);
    expect(forAgent).toHaveLength(1);
    const payload = forAgent[0]!.payload as { generatedAt: string; tickets: { id: string; slaBreached: boolean }[] };
    expect(payload.generatedAt).toBe(now.toISOString());
    expect(payload.tickets.map((t) => t.id)).toEqual([assignedLate.id, assignedSoon.id]);
    expect(payload.tickets[0]?.slaBreached).toBe(true);

    // The requester has no assignments and therefore no digest.
    expect(pending.some((message) => message.userId === requester.id)).toBe(false);
  });

  it("drains queued exports in order and leaves nothing behind", async () => {
    await seedTicket(ctx.admin, { tenantId: tenant.id, requesterId: requester.id, subject: "Exportable" });
    const inserted = await ctx.admin.query<{ id: string }>(
      `INSERT INTO export_jobs (tenant_id, requested_by, created_at)
       VALUES ($1, $2, now() - interval '2 minutes'), ($1, $2, now() - interval '1 minute')
       RETURNING id`,
      [tenant.id, agent.id]
    );

    const result = await runExports(ctx.app);
    expect(result.processed.map((job) => job.id)).toEqual(inserted.rows.map((row) => row.id));
    expect(result.processed.every((job) => job.status === "done")).toBe(true);
    expect(result.processed[0]?.csv).toContain("Exportable");

    const remaining = await ctx.admin.query("SELECT count(*)::int AS n FROM export_jobs WHERE status = 'queued'");
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it("digest work does not scale with member count", async () => {
    const tenantA = await createTenant(ctx.admin);
    const agentA1 = await createUser(ctx.admin);
    const agentA2 = await createUser(ctx.admin);
    await addMembership(ctx.admin, tenantA.id, agentA1.id, "agent");
    await addMembership(ctx.admin, tenantA.id, agentA2.id, "agent");
    await seedTicket(ctx.admin, { tenantId: tenantA.id, assigneeId: agentA1.id, requesterId: agentA1.id });
    await seedTicket(ctx.admin, { tenantId: tenantA.id, assigneeId: agentA2.id, requesterId: agentA2.id });

    let queryCountA = 0;
    const originalQuery = ctx.app.query.bind(ctx.app);
    const instrumentedA = new Proxy(ctx.app, {
      get(target, property) {
        if (property === "query") {
          return (...args: unknown[]) => {
            queryCountA++;
            return Reflect.apply(originalQuery, target, args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    await runDigest(instrumentedA);

    for (let i = 0; i < 5; i++) {
      const u = await createUser(ctx.admin);
      await addMembership(ctx.admin, tenantA.id, u.id, "agent");
      await seedTicket(ctx.admin, { tenantId: tenantA.id, assigneeId: u.id, requesterId: u.id });
    }

    let queryCountB = 0;
    const instrumentedB = new Proxy(ctx.app, {
      get(target, property) {
        if (property === "query") {
          return (...args: unknown[]) => {
            queryCountB++;
            return Reflect.apply(originalQuery, target, args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    await runDigest(instrumentedB);

    expect(queryCountB).toBe(queryCountA);
  });
});

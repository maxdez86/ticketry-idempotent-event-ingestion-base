import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLifecycleFixtures, createTestContext } from "@ticketry/test-support";
import type { LifecycleFixtures, TestContext } from "@ticketry/test-support";

import { runLifecycleIngestion } from "../src/index.js";

describe("lifecycle ingestion", () => {
  let ctx: TestContext;
  let fixtures: LifecycleFixtures;

  beforeAll(async () => {
    ctx = await createTestContext();
    fixtures = await createLifecycleFixtures(ctx.admin);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("records and applies an ordered status and priority delivery in one workspace", async () => {
    const [tenant, otherTenant] = fixtures.tenants;
    const [ticket, otherTicket] = fixtures.tickets;
    const occurredAt = new Date("2026-09-01T00:00:00Z");
    const result = await runLifecycleIngestion(ctx.app, [
      { event_id: "evt-status", ticket_sequence: 1, workspace_slug: tenant.slug, ticket_id: ticket.id, occurred_at: occurredAt, event: { kind: "status_changed", target_status: "pending" } },
      { event_id: "evt-priority", ticket_sequence: 2, workspace_slug: tenant.slug, ticket_id: ticket.id, occurred_at: new Date(occurredAt.getTime() + 1000), event: { kind: "priority_changed", target_priority: "urgent" } }
    ], new Date("2026-09-01T01:00:00Z"));
    expect(result.processed).toEqual(["evt-status", "evt-priority"]);
    const applied = await ctx.admin.query<{ event_id: string; ticket_sequence: number }>(
      "SELECT event_id, ticket_sequence FROM lifecycle_events WHERE tenant_id = $1 ORDER BY ticket_sequence", [tenant.id]
    );
    expect(applied.rows).toEqual([{ event_id: "evt-status", ticket_sequence: 1 }, { event_id: "evt-priority", ticket_sequence: 2 }]);
    const updated = await ctx.admin.query<{ status: string; priority: string }>("SELECT status, priority FROM tickets WHERE id = $1", [ticket.id]);
    expect(updated.rows[0]).toEqual({ status: "pending", priority: "urgent" });
    const audit = await ctx.admin.query<{ action: string }>("SELECT action FROM audit_log WHERE tenant_id = $1 AND target_id = $2", [tenant.id, ticket.id]);
    expect(audit.rows.map((row) => row.action)).toContain("ticket.lifecycle_applied");
    const untouched = await ctx.admin.query<{ status: string; priority: string }>("SELECT status, priority FROM tickets WHERE id = $1", [otherTicket.id]);
    expect(untouched.rows[0]).toEqual({ status: "open", priority: "normal" });
    expect(otherTenant.id).not.toBe(tenant.id);
  });
});


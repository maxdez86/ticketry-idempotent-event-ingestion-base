import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiKey, createMember, createTenant, createUser } from "@ticketry/test-support";

import { auth, createTicketVia, startApi } from "./helpers.js";
import type { ApiHarness } from "./helpers.js";

describe("provider lifecycle events", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await startApi();
  });

  afterAll(async () => {
    await h.close();
  });

  it("applies an ordered status and priority delivery in one workspace", async () => {
    const ticket = await createTicketVia(h.app, h.agent.apiKey);
    const otherTenant = await createTenant(h.ctx.admin);
    const otherMember = await createMember(h.ctx.admin, otherTenant.id, "agent");
    const otherTicket = await createTicketVia(h.app, otherMember.apiKey);
    const staff = await createUser(h.ctx.admin, { isStaff: true });
    const staffKey = await createApiKey(h.ctx.admin, { tenantId: null, userId: staff.id });
    const headers = auth(staffKey, { "x-ticketry-tenant": h.tenant.slug });

    const status = await h.app.inject({
      method: "POST",
      url: "/lifecycle-events",
      headers,
      payload: {
        event_id: "http-status",
        ticket_sequence: 1,
        workspace_slug: h.tenant.slug,
        ticket_id: ticket.id,
        occurred_at: "2026-09-01T00:00:00.000Z",
        event: { kind: "status_changed", target_status: "pending" }
      }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ eventId: "http-status", ticket: { id: ticket.id, status: "pending" } });

    const priority = await h.app.inject({
      method: "POST",
      url: "/lifecycle-events",
      headers,
      payload: {
        event_id: "http-priority",
        ticket_sequence: 2,
        workspace_slug: h.tenant.slug,
        ticket_id: ticket.id,
        occurred_at: "2026-09-01T00:00:01.000Z",
        event: { kind: "priority_changed", target_priority: "urgent" }
      }
    });
    expect(priority.statusCode).toBe(200);
    expect(priority.json()).toMatchObject({
      eventId: "http-priority",
      ticket: { id: ticket.id, status: "pending", priority: "urgent", slaBreached: false }
    });
    expect(
      new Date(priority.json().ticket.slaDueAt as string).getTime() - new Date(ticket.createdAt as string).getTime()
    ).toBe(4 * 3600 * 1000);

    const events = await h.ctx.admin.query<{ event_id: string; ticket_sequence: number }>(
      "SELECT event_id, ticket_sequence FROM lifecycle_events WHERE tenant_id = $1 ORDER BY ticket_sequence",
      [h.tenant.id]
    );
    expect(events.rows).toEqual([
      { event_id: "http-status", ticket_sequence: 1 },
      { event_id: "http-priority", ticket_sequence: 2 }
    ]);

    const lifecycleAudit = await h.ctx.admin.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE tenant_id = $1 AND target_id = $2 AND action = 'ticket.lifecycle_applied'",
      [h.tenant.id, ticket.id]
    );
    expect(lifecycleAudit.rows).toHaveLength(2);

    const untouched = await h.ctx.admin.query<{ status: string; priority: string }>(
      "SELECT status, priority FROM tickets WHERE tenant_id = $1 AND id = $2",
      [otherTenant.id, otherTicket.id]
    );
    expect(untouched.rows[0]).toEqual({ status: "open", priority: "normal" });
  });
});

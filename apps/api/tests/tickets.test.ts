import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMember, createTenant } from "@ticketry/test-support";

import { auth, createTicketVia, startApi } from "./helpers.js";
import type { ApiHarness } from "./helpers.js";

describe("tickets", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await startApi();
  });

  afterAll(async () => {
    await h.close();
  });

  it("creates tickets with per-workspace numbering and an SLA from priority", async () => {
    const first = await createTicketVia(h.app, h.agent.apiKey, { priority: "urgent" });
    const second = await createTicketVia(h.app, h.owner.apiKey, { priority: "low" });
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(first).toMatchObject({ status: "open", priority: "urgent", requesterId: h.agent.user.id, slaBreached: false });

    const createdAt = new Date(first.createdAt as string).getTime();
    expect(new Date(first.slaDueAt as string).getTime() - createdAt).toBe(4 * 3600 * 1000);
    expect(new Date(second.slaDueAt as string).getTime() - new Date(second.createdAt as string).getTime()).toBe(
      72 * 3600 * 1000
    );

    const other = await createTenant(h.ctx.admin);
    const otherMember = await createMember(h.ctx.admin, other.id, "owner");
    const foreign = await createTicketVia(h.app, otherMember.apiKey);
    expect(foreign.number).toBe(1);
  });

  it("validates input", async () => {
    const missing = await h.app.inject({ method: "POST", url: "/tickets", headers: auth(h.agent.apiKey), payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("bad_request");

    const badPriority = await h.app.inject({
      method: "POST",
      url: "/tickets",
      headers: auth(h.agent.apiKey),
      payload: { subject: "x", priority: "p0" }
    });
    expect(badPriority.statusCode).toBe(400);
  });

  it("refuses writes from viewers", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/tickets",
      headers: auth(h.viewer.apiKey),
      payload: { subject: "Viewer ticket" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("lists and filters the workspace's tickets", async () => {
    const assigned = await createTicketVia(h.app, h.agent.apiKey, {
      subject: "Assigned one",
      assigneeId: h.agent.user.id,
      priority: "high"
    });
    await h.app.inject({
      method: "POST",
      url: `/tickets/${assigned.id}/tags`,
      headers: auth(h.agent.apiKey),
      payload: { name: "billing" }
    });

    const all = await h.app.inject({ method: "GET", url: "/tickets", headers: auth(h.viewer.apiKey) });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBeGreaterThanOrEqual(3);
    expect(all.json().tickets.every((t: { tenantId: string }) => t.tenantId === h.tenant.id)).toBe(true);

    const byAssignee = await h.app.inject({
      method: "GET",
      url: `/tickets?assigneeId=${h.agent.user.id}&priority=high`,
      headers: auth(h.viewer.apiKey)
    });
    expect(byAssignee.json().tickets.map((t: { id: string }) => t.id)).toEqual([assigned.id]);

    const byTag = await h.app.inject({ method: "GET", url: "/tickets?tag=billing", headers: auth(h.viewer.apiKey) });
    expect(byTag.json().tickets.map((t: { id: string }) => t.id)).toEqual([assigned.id]);

    const paged = await h.app.inject({ method: "GET", url: "/tickets?limit=1&offset=1", headers: auth(h.viewer.apiKey) });
    expect(paged.json().tickets).toHaveLength(1);
    expect(paged.json().limit).toBe(1);

    const badFilter = await h.app.inject({ method: "GET", url: "/tickets?owner=me", headers: auth(h.viewer.apiKey) });
    expect(badFilter.statusCode).toBe(400);
    const badLimit = await h.app.inject({ method: "GET", url: "/tickets?limit=1000", headers: auth(h.viewer.apiKey) });
    expect(badLimit.statusCode).toBe(400);
  });

  it("reads and updates a ticket, recomputing the SLA when priority changes", async () => {
    const ticket = await createTicketVia(h.app, h.agent.apiKey, { priority: "normal" });
    const read = await h.app.inject({ method: "GET", url: `/tickets/${ticket.id}`, headers: auth(h.viewer.apiKey) });
    expect(read.statusCode).toBe(200);
    expect(read.json().ticket.id).toBe(ticket.id);

    const updated = await h.app.inject({
      method: "PATCH",
      url: `/tickets/${ticket.id}`,
      headers: auth(h.agent.apiKey),
      payload: { status: "pending", priority: "urgent", assigneeId: h.owner.user.id }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().ticket).toMatchObject({ status: "pending", priority: "urgent", assigneeId: h.owner.user.id });
    const createdAt = new Date(ticket.createdAt as string).getTime();
    expect(new Date(updated.json().ticket.slaDueAt).getTime() - createdAt).toBe(4 * 3600 * 1000);

    const unknownField = await h.app.inject({
      method: "PATCH",
      url: `/tickets/${ticket.id}`,
      headers: auth(h.agent.apiKey),
      payload: { tenantId: "x" }
    });
    expect(unknownField.statusCode).toBe(400);

    const audit = await h.app.inject({ method: "GET", url: "/audit", headers: auth(h.owner.apiKey) });
    const actions = audit.json().entries.map((e: { action: string; targetId: string }) => [e.action, e.targetId]);
    expect(actions).toContainEqual(["ticket.updated", ticket.id]);
    expect(actions).toContainEqual(["ticket.created", ticket.id]);
  });

  it("applies the lifecycle transition table and stops the SLA at terminal status", async () => {
    const ticket = await createTicketVia(h.app, h.agent.apiKey, { priority: "normal" });
    const pending = await h.app.inject({
      method: "PATCH", url: `/tickets/${ticket.id}`, headers: auth(h.agent.apiKey), payload: { status: "pending" }
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().ticket.slaDueAt).not.toBeNull();
    const solved = await h.app.inject({
      method: "PATCH", url: `/tickets/${ticket.id}`, headers: auth(h.agent.apiKey), payload: { status: "solved" }
    });
    expect(solved.statusCode).toBe(200);
    expect(solved.json().ticket).toMatchObject({ status: "solved", slaDueAt: null, slaBreached: false });
    const illegal = await h.app.inject({
      method: "PATCH", url: `/tickets/${ticket.id}`, headers: auth(h.agent.apiKey), payload: { status: "pending" }
    });
    expect(illegal.statusCode).toBe(400);
    expect(illegal.json()).toEqual({ error: { code: "invalid_transition", message: "cannot transition ticket from solved to pending" } });
  });

  it("does not expose another workspace's ticket by id", async () => {
    const other = await createTenant(h.ctx.admin);
    const otherMember = await createMember(h.ctx.admin, other.id, "owner");
    const foreign = await createTicketVia(h.app, otherMember.apiKey);

    const read = await h.app.inject({ method: "GET", url: `/tickets/${foreign.id}`, headers: auth(h.agent.apiKey) });
    expect(read.statusCode).toBe(404);

    const update = await h.app.inject({
      method: "PATCH",
      url: `/tickets/${foreign.id}`,
      headers: auth(h.agent.apiKey),
      payload: { status: "closed" }
    });
    expect(update.statusCode).toBe(404);

    const list = await h.app.inject({ method: "GET", url: "/tickets", headers: auth(h.agent.apiKey) });
    expect(list.json().tickets.map((t: { id: string }) => t.id)).not.toContain(foreign.id);
  });
});

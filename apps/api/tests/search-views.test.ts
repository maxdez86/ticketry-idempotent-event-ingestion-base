import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth, createTicketVia, startApi } from "./helpers.js";
import type { ApiHarness } from "./helpers.js";

describe("search and saved views", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await startApi();
  });

  afterAll(async () => {
    await h.close();
  });

  it("finds tickets by subject, body, and comment text without duplicates", async () => {
    const bySubject = await createTicketVia(h.app, h.agent.apiKey, { subject: "Invoice PDF is blank", body: "Nothing renders." });
    const byBody = await createTicketVia(h.app, h.agent.apiKey, { subject: "Question", body: "Where is my invoice?" });
    const byComment = await createTicketVia(h.app, h.agent.apiKey, { subject: "Login loop", body: "Keeps redirecting." });
    await createTicketVia(h.app, h.agent.apiKey, { subject: "Unrelated", body: "Nothing to see." });
    await h.app.inject({
      method: "POST",
      url: `/tickets/${byComment.id}/comments`,
      headers: auth(h.agent.apiKey),
      payload: { body: "They also mentioned the invoice page." }
    });
    await h.app.inject({
      method: "POST",
      url: `/tickets/${bySubject.id}/comments`,
      headers: auth(h.agent.apiKey),
      payload: { body: "invoice invoice invoice" }
    });

    const response = await h.app.inject({ method: "GET", url: "/search?q=invoice", headers: auth(h.viewer.apiKey) });
    expect(response.statusCode).toBe(200);
    const hits = response.json().hits as { ticketId: string; matchedIn: string }[];
    expect(hits.map((hit) => hit.ticketId).sort()).toEqual([bySubject.id, byBody.id, byComment.id].sort());
    expect(hits.find((hit) => hit.ticketId === bySubject.id)?.matchedIn).toBe("ticket");
    expect(hits.find((hit) => hit.ticketId === byComment.id)?.matchedIn).toBe("comment");

    const short = await h.app.inject({ method: "GET", url: "/search?q=a", headers: auth(h.viewer.apiKey) });
    expect(short.statusCode).toBe(400);
  });

  it("stores views, runs them, and rejects unknown filters and duplicate names", async () => {
    const urgent = await createTicketVia(h.app, h.agent.apiKey, { subject: "Urgent thing", priority: "urgent" });
    await createTicketVia(h.app, h.agent.apiKey, { subject: "Calm thing", priority: "low" });

    const created = await h.app.inject({
      method: "POST",
      url: "/views",
      headers: auth(h.agent.apiKey),
      payload: { name: "Urgent open", filters: { status: "open", priority: "urgent" } }
    });
    expect(created.statusCode).toBe(201);
    const view = created.json().view;
    expect(view).toMatchObject({ tenantId: h.tenant.id, ownerId: h.agent.user.id, filters: { status: "open", priority: "urgent" } });

    const duplicate = await h.app.inject({
      method: "POST",
      url: "/views",
      headers: auth(h.agent.apiKey),
      payload: { name: "Urgent open", filters: {} }
    });
    expect(duplicate.statusCode).toBe(409);

    const unknown = await h.app.inject({
      method: "POST",
      url: "/views",
      headers: auth(h.agent.apiKey),
      payload: { name: "Broken", filters: { owner: "me" } }
    });
    expect(unknown.statusCode).toBe(400);

    const listed = await h.app.inject({ method: "GET", url: "/views", headers: auth(h.viewer.apiKey) });
    expect(listed.json().views.map((v: { id: string }) => v.id)).toEqual([view.id]);

    const ran = await h.app.inject({ method: "GET", url: `/views/${view.id}/tickets`, headers: auth(h.viewer.apiKey) });
    expect(ran.statusCode).toBe(200);
    expect(ran.json().tickets.map((t: { id: string }) => t.id)).toEqual([urgent.id]);

    const deleted = await h.app.inject({ method: "DELETE", url: `/views/${view.id}`, headers: auth(h.agent.apiKey) });
    expect(deleted.statusCode).toBe(204);
    const gone = await h.app.inject({ method: "GET", url: `/views/${view.id}/tickets`, headers: auth(h.viewer.apiKey) });
    expect(gone.statusCode).toBe(404);
  });
});

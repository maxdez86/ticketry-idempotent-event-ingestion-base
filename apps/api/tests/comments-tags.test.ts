import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth, createTicketVia, startApi } from "./helpers.js";
import type { ApiHarness } from "./helpers.js";

describe("comments and tags", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await startApi();
  });

  afterAll(async () => {
    await h.close();
  });

  it("adds comments, hides internal notes from viewers, and bumps the ticket", async () => {
    const ticket = await createTicketVia(h.app, h.agent.apiKey);
    const before = new Date(ticket.updatedAt as string).getTime();

    const publicComment = await h.app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/comments`,
      headers: auth(h.agent.apiKey),
      payload: { body: "Looking into it." }
    });
    expect(publicComment.statusCode).toBe(201);
    expect(publicComment.json().comment).toMatchObject({ ticketId: ticket.id, authorId: h.agent.user.id, isInternal: false });

    const internal = await h.app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/comments`,
      headers: auth(h.owner.apiKey),
      payload: { body: "Customer is a VIP.", isInternal: true }
    });
    expect(internal.statusCode).toBe(201);

    const asAgent = await h.app.inject({ method: "GET", url: `/tickets/${ticket.id}/comments`, headers: auth(h.agent.apiKey) });
    expect(asAgent.json().comments.map((c: { body: string }) => c.body)).toEqual(["Looking into it.", "Customer is a VIP."]);

    const asViewer = await h.app.inject({ method: "GET", url: `/tickets/${ticket.id}/comments`, headers: auth(h.viewer.apiKey) });
    expect(asViewer.json().comments.map((c: { body: string }) => c.body)).toEqual(["Looking into it."]);

    const viewerWrite = await h.app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/comments`,
      headers: auth(h.viewer.apiKey),
      payload: { body: "hi" }
    });
    expect(viewerWrite.statusCode).toBe(403);

    const empty = await h.app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/comments`,
      headers: auth(h.agent.apiKey),
      payload: { body: "" }
    });
    expect(empty.statusCode).toBe(400);

    const refreshed = await h.app.inject({ method: "GET", url: `/tickets/${ticket.id}`, headers: auth(h.agent.apiKey) });
    expect(new Date(refreshed.json().ticket.updatedAt).getTime()).toBeGreaterThanOrEqual(before);

    const missing = await h.app.inject({
      method: "GET",
      url: "/tickets/00000000-0000-4000-8000-000000000000/comments",
      headers: auth(h.agent.apiKey)
    });
    expect(missing.statusCode).toBe(404);
  });

  it("tags tickets idempotently and counts usage per workspace", async () => {
    const a = await createTicketVia(h.app, h.agent.apiKey);
    const b = await createTicketVia(h.app, h.agent.apiKey);
    for (const [id, name] of [
      [a.id, "billing"],
      [a.id, "billing"],
      [a.id, "urgent-client"],
      [b.id, "billing"]
    ] as const) {
      const response = await h.app.inject({
        method: "POST",
        url: `/tickets/${id}/tags`,
        headers: auth(h.agent.apiKey),
        payload: { name }
      });
      expect(response.statusCode).toBe(201);
    }

    const tags = await h.app.inject({ method: "GET", url: "/tags", headers: auth(h.viewer.apiKey) });
    expect(tags.json().tags.map((t: { name: string; ticketCount: number }) => [t.name, t.ticketCount])).toEqual([
      ["billing", 2],
      ["urgent-client", 1]
    ]);

    const ticketTags = await h.app.inject({ method: "GET", url: `/tickets/${a.id}/tags`, headers: auth(h.viewer.apiKey) });
    expect(ticketTags.json().tags.map((t: { name: string }) => t.name)).toEqual(["billing", "urgent-client"]);

    const removed = await h.app.inject({
      method: "DELETE",
      url: `/tickets/${a.id}/tags/billing`,
      headers: auth(h.agent.apiKey)
    });
    expect(removed.statusCode).toBe(204);
    const after = await h.app.inject({ method: "GET", url: `/tickets/${a.id}/tags`, headers: auth(h.viewer.apiKey) });
    expect(after.json().tags.map((t: { name: string }) => t.name)).toEqual(["urgent-client"]);

    const invalid = await h.app.inject({
      method: "POST",
      url: `/tickets/${a.id}/tags`,
      headers: auth(h.agent.apiKey),
      payload: { name: "Not A Slug" }
    });
    expect(invalid.statusCode).toBe(400);
  });
});

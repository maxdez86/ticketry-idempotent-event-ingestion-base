import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processNextExport } from "@ticketry/core";
import { addMembership, createTenant, revokeMembership } from "@ticketry/test-support";

import { auth, createTicketVia, startApi } from "./helpers.js";
import type { ApiHarness } from "./helpers.js";

describe("exports and users", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await startApi();
  });

  afterAll(async () => {
    await h.close();
  });

  it("queues an export, the worker completes it, and the CSV downloads", async () => {
    await createTicketVia(h.app, h.agent.apiKey, { subject: 'Subject with "quotes", commas', priority: "high" });
    await createTicketVia(h.app, h.agent.apiKey, { subject: "Second", priority: "low" });

    const queued = await h.app.inject({ method: "POST", url: "/exports", headers: auth(h.agent.apiKey), payload: {} });
    expect(queued.statusCode).toBe(202);
    const job = queued.json().export;
    expect(job).toMatchObject({ tenantId: h.tenant.id, requestedBy: h.agent.user.id, status: "queued", viewId: null });

    const notReady = await h.app.inject({ method: "GET", url: `/exports/${job.id}/download`, headers: auth(h.agent.apiKey) });
    expect(notReady.statusCode).toBe(409);

    const processed = await processNextExport(h.ctx.app);
    expect(processed?.id).toBe(job.id);
    expect(processed?.status).toBe("done");
    expect(processed?.rowCount).toBe(2);
    expect(await processNextExport(h.ctx.app)).toBeNull();

    const status = await h.app.inject({ method: "GET", url: `/exports/${job.id}`, headers: auth(h.viewer.apiKey) });
    expect(status.json().export.status).toBe("done");

    const download = await h.app.inject({ method: "GET", url: `/exports/${job.id}/download`, headers: auth(h.viewer.apiKey) });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    const lines = download.body.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("number,subject,status,priority,assignee_id,sla_due_at,sla_breached,created_at");
    expect(lines).toHaveLength(3);
    expect(download.body).toContain('"Subject with ""quotes"", commas"');

    const listed = await h.app.inject({ method: "GET", url: "/exports", headers: auth(h.viewer.apiKey) });
    expect(listed.json().exports.map((e: { id: string; csv?: string }) => [e.id, e.csv])).toEqual([[job.id, undefined]]);
  });

  it("scopes an export to a saved view and rejects views it cannot find", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/views",
      headers: auth(h.agent.apiKey),
      payload: { name: "Low only", filters: { priority: "low" } }
    });
    const view = created.json().view;
    const queued = await h.app.inject({ method: "POST", url: "/exports", headers: auth(h.agent.apiKey), payload: { viewId: view.id } });
    expect(queued.statusCode).toBe(202);
    const processed = await processNextExport(h.ctx.app);
    expect(processed?.rowCount).toBe(1);
    expect(processed?.csv).toContain("Second,open,low");

    const missing = await h.app.inject({
      method: "POST",
      url: "/exports",
      headers: auth(h.agent.apiKey),
      payload: { viewId: "00000000-0000-4000-8000-000000000000" }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lists active members of the workspace and shows a member profile", async () => {
    const other = await createTenant(h.ctx.admin);
    await addMembership(h.ctx.admin, other.id, h.agent.user.id, "viewer");
    await revokeMembership(h.ctx.admin, h.tenant.id, h.viewer.user.id);

    const members = await h.app.inject({ method: "GET", url: "/users", headers: auth(h.owner.apiKey) });
    expect(members.statusCode).toBe(200);
    const ids = members.json().users.map((u: { id: string }) => u.id);
    expect(ids).toContain(h.owner.user.id);
    expect(ids).toContain(h.agent.user.id);
    expect(ids).not.toContain(h.viewer.user.id);

    const profile = await h.app.inject({ method: "GET", url: `/users/${h.agent.user.id}`, headers: auth(h.owner.apiKey) });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().user).toMatchObject({ id: h.agent.user.id, email: h.agent.user.email });
    expect(profile.json().memberships.map((m: { tenantSlug: string }) => m.tenantSlug)).toContain(h.tenant.slug);

    const unknown = await h.app.inject({
      method: "GET",
      url: "/users/00000000-0000-4000-8000-000000000000",
      headers: auth(h.owner.apiKey)
    });
    expect(unknown.statusCode).toBe(404);
  });
});

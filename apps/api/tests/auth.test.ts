import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiKey, createTenant, createUser, revokeApiKey } from "@ticketry/test-support";

import { auth, startApi } from "./helpers.js";
import type { ApiHarness } from "./helpers.js";

describe("authentication", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await startApi();
  });

  afterAll(async () => {
    await h.close();
  });

  it("serves /health without a key and reports the schema version", async () => {
    const response = await h.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
    expect(response.json().schemaVersion).toBeGreaterThanOrEqual(3);
  });

  it("rejects missing, malformed, unknown, and revoked keys", async () => {
    expect((await h.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ method: "GET", url: "/me", headers: { authorization: "Basic abc" } })).statusCode
    ).toBe(401);
    expect(
      (await h.app.inject({ method: "GET", url: "/me", headers: auth("tk_0000000000000000000000") })).statusCode
    ).toBe(401);

    await revokeApiKey(h.ctx.admin, h.agent.apiKey);
    expect((await h.app.inject({ method: "GET", url: "/me", headers: auth(h.agent.apiKey) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/me", headers: auth(h.owner.apiKey) })).statusCode).toBe(200);
  });

  it("describes the caller and the workspace the key acts in", async () => {
    const response = await h.app.inject({ method: "GET", url: "/me", headers: auth(h.owner.apiKey) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: h.owner.user.id, email: h.owner.user.email, isStaff: false },
      workspace: { id: h.tenant.id, slug: h.tenant.slug, role: "owner" },
      memberships: [{ tenantSlug: h.tenant.slug, role: "owner" }]
    });
  });

  it("rejects disabled users", async () => {
    await h.ctx.admin.query("UPDATE users SET disabled_at = now() WHERE id = $1", [h.viewer.user.id]);
    const response = await h.app.inject({ method: "GET", url: "/me", headers: auth(h.viewer.apiKey) });
    expect(response.statusCode).toBe(401);
  });

  it("lets platform staff pick a workspace per request and records it", async () => {
    const staff = await createUser(h.ctx.admin, { isStaff: true, email: "staff@ticketry.test" });
    const staffKey = await createApiKey(h.ctx.admin, { tenantId: null, userId: staff.id });

    const noHeader = await h.app.inject({ method: "GET", url: "/me", headers: auth(staffKey) });
    expect(noHeader.statusCode).toBe(403);

    const unknown = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: auth(staffKey, { "x-ticketry-tenant": "nope" })
    });
    expect(unknown.statusCode).toBe(403);

    const other = await createTenant(h.ctx.admin);
    const response = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: auth(staffKey, { "x-ticketry-tenant": other.slug })
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().workspace).toEqual({ id: other.id, slug: other.slug, role: "staff" });

    const audit = await h.ctx.admin.query(
      "SELECT action, actor_id FROM audit_log WHERE tenant_id = $1 AND action = 'staff.workspace_access'",
      [other.id]
    );
    expect(audit.rows).toEqual([{ action: "staff.workspace_access", actor_id: staff.id }]);
  });

  it("refuses a non-staff key that is not bound to a workspace", async () => {
    const user = await createUser(h.ctx.admin);
    const key = await createApiKey(h.ctx.admin, { tenantId: null, userId: user.id });
    const response = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: auth(key, { "x-ticketry-tenant": h.tenant.slug })
    });
    expect(response.statusCode).toBe(403);
  });
});

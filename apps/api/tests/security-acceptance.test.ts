import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashApiKey, processNextTenantExport } from "@ticketry/core";
import {
  addMembership,
  createApiKey,
  createMember,
  createTenant,
  createTestContext,
  createUser,
  revokeMembership,
  seedComment,
  seedTicket
} from "@ticketry/test-support";

import { buildApp } from "../src/app.js";
import { auth, createTicketVia, startApi } from "./helpers.js";
import { buildProbeApp } from "./support/transport.js";
import type { ScopeProbeResult } from "./support/transport.js";
import type { ApiHarness } from "./helpers.js";

describe("API tenant-isolation acceptance", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await startApi({ appPoolMax: 1 });
  });

  afterAll(async () => {
    await h.close();
  });

  it("cannot comment on a known foreign ticket and leaves all related state unchanged", async () => {
    const other = await createTenant(h.ctx.admin);
    const otherMember = await createMember(h.ctx.admin, other.id, "agent");
    const foreign = await seedTicket(h.ctx.admin, {
      tenantId: other.id,
      requesterId: otherMember.user.id,
      subject: "same-looking ticket"
    });
    const before = await h.ctx.admin.query<{ updated_at: Date }>("SELECT updated_at FROM tickets WHERE id = $1", [
      foreign.id
    ]);

    const response = await h.app.inject({
      method: "POST",
      url: `/tickets/${foreign.id}/comments`,
      headers: auth(h.agent.apiKey),
      payload: { body: "must not persist" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message: `ticket ${foreign.id} not found` } });
    expect((await h.ctx.admin.query("SELECT 1 FROM comments WHERE ticket_id = $1", [foreign.id])).rowCount).toBe(0);
    expect((await h.ctx.admin.query("SELECT updated_at FROM tickets WHERE id = $1", [foreign.id])).rows[0]?.updated_at).toEqual(
      before.rows[0]?.updated_at
    );
    expect(
      (
        await h.ctx.admin.query(
          "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'comment.created' AND tenant_id = ANY($2::uuid[])",
          [foreign.id, [h.tenant.id, other.id]]
        )
      ).rowCount
    ).toBe(0);
  });

  it("isolates comment search, saved views, and export detail/download by tenant", async () => {
    const ownTicket = await createTicketVia(h.app, h.agent.apiKey, { subject: "shared ordinary", body: "plain" });
    await h.app.inject({
      method: "POST",
      url: `/tickets/${ownTicket.id}/comments`,
      headers: auth(h.agent.apiKey),
      payload: { body: "needle-security needle-security" }
    });
    const ownSubject = await createTicketVia(h.app, h.agent.apiKey, {
      subject: "needle-security subject",
      body: "needle-security"
    });
    await h.app.inject({
      method: "POST",
      url: `/tickets/${ownSubject.id}/comments`,
      headers: auth(h.agent.apiKey),
      payload: { body: "needle-security repeated" }
    });

    const other = await createTenant(h.ctx.admin);
    const otherMember = await createMember(h.ctx.admin, other.id, "agent");
    const foreignTicket = await seedTicket(h.ctx.admin, {
      tenantId: other.id,
      requesterId: otherMember.user.id,
      subject: "shared ordinary",
      body: "plain"
    });
    await seedComment(h.ctx.admin, {
      tenantId: other.id,
      ticketId: foreignTicket.id,
      authorId: otherMember.user.id,
      body: "needle-security foreign-only"
    });
    const foreignViewResponse = await h.app.inject({
      method: "POST",
      url: "/views",
      headers: auth(otherMember.apiKey),
      payload: { name: "Confusable view", filters: {} }
    });
    const foreignView = foreignViewResponse.json().view as { id: string };
    const foreignExport = await h.ctx.admin.query<{ id: string }>(
      `INSERT INTO export_jobs (tenant_id, requested_by, view_id, status, row_count, csv, finished_at)
       VALUES ($1, $2, $3, 'done', 1, 'FOREIGN_CSV_SENTINEL', now()) RETURNING id`,
      [other.id, otherMember.user.id, foreignView.id]
    );
    const foreignExportId = foreignExport.rows[0]!.id;

    const search = await h.app.inject({
      method: "GET",
      url: "/search?q=needle-security",
      headers: auth(h.viewer.apiKey)
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().hits.map((hit: { ticketId: string }) => hit.ticketId).sort()).toEqual(
      [ownTicket.id, ownSubject.id].sort()
    );
    expect(search.json().hits.filter((hit: { ticketId: string }) => hit.ticketId === ownSubject.id)).toHaveLength(1);
    expect(search.body).not.toContain(foreignTicket.id);

    const view = await h.app.inject({
      method: "GET",
      url: `/views/${foreignView.id}/tickets`,
      headers: auth(h.viewer.apiKey)
    });
    expect(view.statusCode).toBe(404);
    expect(view.body).not.toContain("Confusable view");
    for (const suffix of ["", "/download"]) {
      const response = await h.app.inject({
        method: "GET",
        url: `/exports/${foreignExportId}${suffix}`,
        headers: auth(h.viewer.apiKey)
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("FOREIGN_CSV_SENTINEL");
      expect(response.body).not.toContain("done");
      expect(response.body).not.toContain("rowCount");
    }

    const ownExport = await h.app.inject({
      method: "POST",
      url: "/exports",
      headers: auth(h.agent.apiKey),
      payload: {}
    });
    expect(ownExport.statusCode).toBe(202);
    const ownJob = ownExport.json().export as { id: string };
    await processNextTenantExport(h.ctx.app, h.tenant.id, new Date("2026-08-01T00:00:00Z"));
    const ownDownload = await h.app.inject({
      method: "GET",
      url: `/exports/${ownJob.id}/download`,
      headers: auth(h.viewer.apiKey)
    });
    expect(ownDownload.statusCode).toBe(200);
    expect(ownDownload.headers["content-type"]).toContain("text/csv");
  });

  it("limits profiles and invalidates tenant keys immediately when membership is revoked", async () => {
    const other = await createTenant(h.ctx.admin);
    const both = await createUser(h.ctx.admin, { displayName: "Same Profile" });
    await addMembership(h.ctx.admin, h.tenant.id, both.id, "agent");
    await addMembership(h.ctx.admin, other.id, both.id, "viewer");
    const otherOnly = await createMember(h.ctx.admin, other.id, "agent");
    const revoked = await createMember(h.ctx.admin, h.tenant.id, "viewer");
    const disabled = await createMember(h.ctx.admin, h.tenant.id, "viewer");
    await revokeMembership(h.ctx.admin, h.tenant.id, revoked.user.id);
    await h.ctx.admin.query("UPDATE users SET disabled_at = now() WHERE id = $1", [disabled.user.id]);

    const profile = await h.app.inject({ method: "GET", url: `/users/${both.id}`, headers: auth(h.owner.apiKey) });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().memberships).toEqual([
      { tenantId: h.tenant.id, tenantSlug: h.tenant.slug, role: "agent", revokedAt: null }
    ]);
    for (const userId of [otherOnly.user.id, revoked.user.id, disabled.user.id]) {
      const response = await h.app.inject({ method: "GET", url: `/users/${userId}`, headers: auth(h.owner.apiKey) });
      expect(response.statusCode).toBe(404);
    }

    const temporary = await createMember(h.ctx.admin, h.tenant.id, "agent");
    expect((await h.app.inject({ method: "GET", url: "/me", headers: auth(temporary.apiKey) })).statusCode).toBe(200);
    await revokeMembership(h.ctx.admin, h.tenant.id, temporary.user.id);
    expect((await h.app.inject({ method: "GET", url: "/me", headers: auth(temporary.apiKey) })).statusCode).toBe(403);
  });

  it("returns the caller's complete active memberships without widening tenant-scoped reads", async () => {
    const tenantA = await createTenant(h.ctx.admin, "zz-self-home");
    const tenantB = await createTenant(h.ctx.admin, "aa-self-away");
    const revokedTenant = await createTenant(h.ctx.admin, "mm-self-revoked");
    const shared = await createUser(h.ctx.admin, { displayName: "Confusable Self" });
    await addMembership(h.ctx.admin, tenantA.id, shared.id, "agent");
    await addMembership(h.ctx.admin, tenantB.id, shared.id, "viewer");
    await addMembership(h.ctx.admin, revokedTenant.id, shared.id, "owner");
    await revokeMembership(h.ctx.admin, revokedTenant.id, shared.id);
    const keyA = await createApiKey(h.ctx.admin, { tenantId: tenantA.id, userId: shared.id });
    const keyB = await createApiKey(h.ctx.admin, { tenantId: tenantB.id, userId: shared.id });

    const unrelatedA = await createUser(h.ctx.admin, { displayName: "Confusable Self" });
    const unrelatedB = await createUser(h.ctx.admin, { displayName: "Confusable Self" });
    await addMembership(h.ctx.admin, tenantA.id, unrelatedA.id, "viewer");
    await addMembership(h.ctx.admin, tenantB.id, unrelatedB.id, "agent");

    const expectedMemberships = [
      { tenantSlug: tenantB.slug, role: "viewer" },
      { tenantSlug: tenantA.slug, role: "agent" }
    ];
    const [throughA, throughB] = await Promise.all([
      h.app.inject({ method: "GET", url: "/me", headers: auth(keyA) }),
      h.app.inject({ method: "GET", url: "/me", headers: auth(keyB) })
    ]);
    expect(throughA.statusCode).toBe(200);
    expect(throughB.statusCode).toBe(200);
    expect(throughA.json().workspace).toEqual({ id: tenantA.id, slug: tenantA.slug, role: "agent" });
    expect(throughB.json().workspace).toEqual({ id: tenantB.id, slug: tenantB.slug, role: "viewer" });
    expect(throughA.json().memberships).toEqual(expectedMemberships);
    expect(throughB.json().memberships).toEqual(expectedMemberships);

    const profileA = await h.app.inject({ method: "GET", url: `/users/${shared.id}`, headers: auth(keyA) });
    const profileB = await h.app.inject({ method: "GET", url: `/users/${shared.id}`, headers: auth(keyB) });
    expect(profileA.json().memberships).toEqual([
      { tenantId: tenantA.id, tenantSlug: tenantA.slug, role: "agent", revokedAt: null }
    ]);
    expect(profileB.json().memberships).toEqual([
      { tenantId: tenantB.id, tenantSlug: tenantB.slug, role: "viewer", revokedAt: null }
    ]);
    expect(
      (await h.app.inject({ method: "GET", url: `/users/${unrelatedB.id}`, headers: auth(keyA) })).statusCode
    ).toBe(404);

    expect((await h.ctx.app.query("SELECT tenant_id FROM memberships WHERE user_id = $1", [shared.id])).rowCount).toBe(0);
    expect((await h.ctx.app.query("SELECT id FROM tenants WHERE id = ANY($1::uuid[])", [[tenantA.id, tenantB.id]])).rowCount).toBe(0);
    // Ordinary database reads on the caller's own scoped connection stay
    // tenant-local even though `/me` returned the full cross-workspace list.
    // Observed through a real authenticated request via the transport binding,
    // not by naming the implementation's scope mechanism.
    const probeApp = buildProbeApp(h.ctx.app);
    await probeApp.ready();
    try {
      const probe = await probeApp.inject({
        method: "GET",
        url: `/__probe/scope?userId=${shared.id}&otherTenantId=${tenantB.id}`,
        headers: auth(keyA)
      });
      expect(probe.statusCode).toBe(200);
      const scoped = probe.json() as ScopeProbeResult;
      expect(scoped.visibleTenantIds).toEqual([tenantA.id]);
      expect(scoped.membershipTenantIds).toEqual([tenantA.id]);
      expect(scoped.otherTenantMembershipCount).toBe(0);
    } finally {
      await probeApp.close();
    }

    const staffWithMembership = await createUser(h.ctx.admin, { isStaff: true, displayName: "Staff Member" });
    await addMembership(h.ctx.admin, tenantB.id, staffWithMembership.id, "owner");
    const staffWithMembershipKey = await createApiKey(h.ctx.admin, {
      tenantId: null,
      userId: staffWithMembership.id
    });
    const staffResponse = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: auth(staffWithMembershipKey, { "x-ticketry-tenant": tenantA.slug })
    });
    expect(staffResponse.statusCode).toBe(200);
    expect(staffResponse.json().workspace).toEqual({ id: tenantA.id, slug: tenantA.slug, role: "staff" });
    expect(staffResponse.json().memberships).toEqual([{ tenantSlug: tenantB.slug, role: "owner" }]);

    const staffWithoutMembership = await createUser(h.ctx.admin, { isStaff: true });
    const staffWithoutMembershipKey = await createApiKey(h.ctx.admin, {
      tenantId: null,
      userId: staffWithoutMembership.id
    });
    const staffWithoutMembershipResponse = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: auth(staffWithoutMembershipKey, { "x-ticketry-tenant": tenantA.slug })
    });
    expect(staffWithoutMembershipResponse.statusCode).toBe(200);
    expect(staffWithoutMembershipResponse.json().memberships).toEqual([]);

    await revokeMembership(h.ctx.admin, tenantA.id, shared.id);
    const afterRevocation = await h.app.inject({ method: "GET", url: "/me", headers: auth(keyB) });
    expect(afterRevocation.statusCode).toBe(200);
    expect(afterRevocation.json().memberships).toEqual([{ tenantSlug: tenantB.slug, role: "viewer" }]);
  });

  it("preserves compatibility and commits bootstrap security records independently of route failures", async () => {
    const viewerWrite = await h.app.inject({
      method: "POST",
      url: "/tickets",
      headers: auth(h.viewer.apiKey),
      payload: { subject: "forbidden" }
    });
    expect(viewerWrite.statusCode).toBe(403);
    expect(viewerWrite.json()).toEqual({ error: { code: "forbidden", message: "viewers cannot modify tickets" } });
    const appliedVersion = (await h.ctx.admin.query<{ v: number }>("SELECT max(version)::int AS v FROM schema_migrations")).rows[0]?.v ?? 0;
    expect((await h.app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", schemaVersion: appliedVersion });
    expect((await h.app.inject({ method: "GET", url: "/missing", headers: auth(h.owner.apiKey) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/search?q=x", headers: auth(h.owner.apiKey) })).statusCode).toBe(400);

    const other = await createTenant(h.ctx.admin);
    const staff = await createUser(h.ctx.admin, { isStaff: true });
    const staffKey = await createApiKey(h.ctx.admin, { tenantId: null, userId: staff.id });
    for (const tenant of [h.tenant, other]) {
      const response = await h.app.inject({
        method: "GET",
        url: "/me",
        headers: auth(staffKey, { "x-ticketry-tenant": tenant.slug })
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().workspace.id).toBe(tenant.id);
    }
    const laterFailure = await h.app.inject({
      method: "GET",
      url: "/missing-after-staff-resolution",
      headers: auth(staffKey, { "x-ticketry-tenant": h.tenant.slug })
    });
    expect(laterFailure.statusCode).toBe(404);
    const beforeResolution = await h.app.inject({ method: "GET", url: "/me", headers: auth(staffKey) });
    expect(beforeResolution.statusCode).toBe(403);
    const staffAudit = await h.ctx.admin.query<{ tenant_id: string; count: number }>(
      `SELECT tenant_id, count(*)::int AS count FROM audit_log
       WHERE actor_id = $1 AND action = 'staff.workspace_access' GROUP BY tenant_id ORDER BY tenant_id`,
      [staff.id]
    );
    expect(new Map(staffAudit.rows.map((row) => [row.tenant_id, row.count]))).toEqual(
      new Map([
        [h.tenant.id, 2],
        [other.id, 1]
      ])
    );

    const noMembership = await createUser(h.ctx.admin);
    const recognizedKey = await createApiKey(h.ctx.admin, { tenantId: h.tenant.id, userId: noMembership.id });
    const rejected = await h.app.inject({ method: "GET", url: "/me", headers: auth(recognizedKey) });
    expect(rejected.statusCode).toBe(403);
    const used = await h.ctx.admin.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM api_keys WHERE key_hash = $1",
      [hashApiKey(recognizedKey)]
    );
    expect(used.rows[0]?.last_used_at).toBeInstanceOf(Date);

    const headerIgnored = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: auth(h.owner.apiKey, { "x-ticketry-tenant": other.slug })
    });
    expect(headerIgnored.statusCode).toBe(200);
    expect(headerIgnored.json().workspace.id).toBe(h.tenant.id);
  });
});

describe("API pre-commit abort acceptance", () => {
  it("rolls back route mutations and releases a size-one pool client", async () => {
    const ctx = await createTestContext({ appPoolMax: 1 });
    const tenant = await createTenant(ctx.admin);
    const member = await createMember(ctx.admin, tenant.id, "agent");
    // Inject a deterministic pre-commit failure through an owner-installed
    // fixture trigger tied to the actual inserted row, rather than counting
    // COMMIT round-trips or matching the route's private SQL.
    await ctx.admin.query(`
      CREATE FUNCTION fail_precommit_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.subject = 'PRECOMMIT_ABORT' THEN RAISE EXCEPTION 'controlled pre-commit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_precommit_ticket BEFORE INSERT ON tickets
      FOR EACH ROW EXECUTE FUNCTION fail_precommit_ticket();
    `);
    const app = buildApp({ pool: ctx.app });
    await app.ready();
    try {
      const aborted = await app.inject({
        method: "POST",
        url: "/tickets",
        headers: auth(member.apiKey),
        payload: { subject: "PRECOMMIT_ABORT" }
      });
      expect(aborted.statusCode).toBe(500);
      expect((await ctx.admin.query("SELECT 1 FROM tickets WHERE tenant_id = $1", [tenant.id])).rowCount).toBe(0);
      expect((await ctx.admin.query("SELECT 1 FROM audit_log WHERE tenant_id = $1", [tenant.id])).rowCount).toBe(0);

      // The size-one pool must recover: the next request reuses the same client
      // with no residual transaction or scope.
      const recovered = await app.inject({ method: "GET", url: "/me", headers: auth(member.apiKey) });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().workspace.id).toBe(tenant.id);
    } finally {
      await app.close();
      await ctx.admin.query("DROP TRIGGER fail_precommit_ticket ON tickets; DROP FUNCTION fail_precommit_ticket()");
      await ctx.close();
    }
  });
});

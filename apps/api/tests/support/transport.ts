/**
 * Private, reviewer-inspected transport binding for the API acceptance suite.
 *
 * A raw scoped probe must observe what the runtime connection sees *after* the
 * implementation has authenticated the caller and established its workspace
 * scope. Instead of reaching into a particular scope mechanism (a GUC, a
 * helper, a decoration name), we ride a real authenticated request: a test-only
 * route runs oracle-supplied base-table reads on the same connection the
 * implementation already scoped for that request.
 *
 * The ONLY implementation-specific glue is `scopedConnection` — how to obtain
 * the request's runtime query connection. Freeze it when comparing
 * implementations. It must not establish scope, authenticate, add a
 * transaction, or filter results; it only hands back the connection the
 * implementation itself prepared.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Pool, Queryable } from "@ticketry/db";

import { buildApp } from "../../src/app.js";

/** Gold binding: the request's scoped connection is its decorated client. */
function scopedConnection(request: FastifyRequest): Queryable {
  return request.db;
}

export interface ScopeProbeResult {
  visibleTenantIds: string[];
  membershipTenantIds: string[];
  otherTenantMembershipCount: number;
}

/**
 * Build the app under test and attach a test-only probe route that runs on the
 * implementation's normal authentication/scope lifecycle. The route reads only
 * base identity tables, so the same assertions hold for any implementation.
 */
export function buildProbeApp(pool: Pool): FastifyInstance {
  const app = buildApp({ pool });
  app.get("/__probe/scope", async (request) => {
    const query = request.query as { userId?: string; otherTenantId?: string };
    const db = scopedConnection(request);
    const tenants = await db.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
    const memberships = await db.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM memberships WHERE user_id = $1 ORDER BY tenant_id",
      [query.userId]
    );
    const other = await db.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM memberships WHERE tenant_id = $1",
      [query.otherTenantId]
    );
    return {
      visibleTenantIds: tenants.rows.map((row) => row.id),
      membershipTenantIds: memberships.rows.map((row) => row.tenant_id),
      otherTenantMembershipCount: Number(other.rows[0]?.count ?? 0)
    } satisfies ScopeProbeResult;
  });
  return app;
}

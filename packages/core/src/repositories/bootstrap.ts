import type { Queryable } from "@ticketry/db";

import type { MembershipRole } from "../domain/types.js";

export interface SelfMembership {
  tenantSlug: string;
  role: MembershipRole;
}

export interface AuthenticatedApiKey {
  apiKeyId: string;
  tenantId: string | null;
  userId: string;
  email: string;
  displayName: string;
  isStaff: boolean;
  memberships: SelfMembership[];
}

interface AuthenticatedApiKeyRow {
  api_key_id: string;
  tenant_id: string | null;
  user_id: string;
  email: string;
  display_name: string;
  is_staff: boolean;
  memberships: SelfMembership[];
}

export interface StaffTenant {
  tenantId: string;
  tenantSlug: string;
}

interface StaffTenantRow {
  tenant_id: string;
  tenant_slug: string;
}

/** Authenticate an already-hashed API key through the controlled database entry point. */
export async function authenticateApiKey(
  db: Queryable,
  keyHash: string
): Promise<AuthenticatedApiKey | null> {
  const result = await db.query<AuthenticatedApiKeyRow>(
    "SELECT * FROM ticketry.authenticate_api_key($1)",
    [keyHash]
  );
  const row = result.rows[0];
  return row
    ? {
        apiKeyId: row.api_key_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        isStaff: row.is_staff,
        memberships: row.memberships
      }
    : null;
}

/** Resolve only the tenant identity needed to scope a staff request. */
export async function resolveStaffTenant(db: Queryable, slug: string): Promise<StaffTenant | null> {
  const result = await db.query<StaffTenantRow>("SELECT * FROM ticketry.resolve_staff_tenant($1)", [slug]);
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, tenantSlug: row.tenant_slug } : null;
}

/** Enumerate tenant scopes for worker fan-out in a stable order. */
export async function listWorkerTenantIds(db: Queryable): Promise<string[]> {
  const result = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM ticketry.worker_tenant_ids()");
  return result.rows.map((row) => row.tenant_id);
}

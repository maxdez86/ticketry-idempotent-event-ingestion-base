import type { Queryable } from "@ticketry/db";

import type { Membership, MembershipRole, UserProfile } from "../domain/types.js";
import { NotFoundError } from "../lib/errors.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  is_staff: boolean;
  disabled_at: Date | null;
}

interface MembershipRow {
  tenant_id: string;
  tenant_slug: string;
  user_id: string;
  role: MembershipRole;
  revoked_at: Date | null;
}

function userFromRow(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isStaff: row.is_staff,
    disabledAt: row.disabled_at
  };
}

function membershipFromRow(row: MembershipRow): Membership {
  return {
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    userId: row.user_id,
    role: row.role,
    revokedAt: row.revoked_at
  };
}

export interface TenantMember extends UserProfile {
  role: MembershipRole;
}

export async function getTenantMember(db: Queryable, tenantId: string, userId: string): Promise<TenantMember> {
  const result = await db.query<UserRow & { role: MembershipRole }>(
    `SELECT u.id, u.email, u.display_name, u.is_staff, u.disabled_at, m.role
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.user_id = $2
       AND m.revoked_at IS NULL AND u.disabled_at IS NULL`,
    [tenantId, userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("user", userId);
  }
  return { ...userFromRow(row), role: row.role };
}

/** Every workspace the user belongs to, active or revoked. */
export async function listMemberships(db: Queryable, userId: string): Promise<Membership[]> {
  const result = await db.query<MembershipRow>(
    `SELECT m.tenant_id, t.slug AS tenant_slug, m.user_id, m.role, m.revoked_at
     FROM memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1
     ORDER BY t.slug`,
    [userId]
  );
  return result.rows.map(membershipFromRow);
}

export async function findMembership(db: Queryable, tenantId: string, userId: string): Promise<Membership | null> {
  const result = await db.query<MembershipRow>(
    `SELECT m.tenant_id, t.slug AS tenant_slug, m.user_id, m.role, m.revoked_at
     FROM memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.tenant_id = $1 AND m.user_id = $2`,
    [tenantId, userId]
  );
  const row = result.rows[0];
  return row ? membershipFromRow(row) : null;
}

export async function listTenantMembers(db: Queryable, tenantId: string): Promise<TenantMember[]> {
  const result = await db.query<UserRow & { role: MembershipRole }>(
    `SELECT u.id, u.email, u.display_name, u.is_staff, u.disabled_at, m.role
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL
     ORDER BY u.display_name`,
    [tenantId]
  );
  return result.rows.map((row) => ({ ...userFromRow(row), role: row.role }));
}

/** Enabled users who currently hold an active membership in this tenant. */
export async function listActiveMemberUserIds(db: Queryable, tenantId: string): Promise<string[]> {
  const result = await db.query<{ user_id: string }>(
    `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL
     ORDER BY m.user_id`,
    [tenantId]
  );
  return result.rows.map((row) => row.user_id);
}

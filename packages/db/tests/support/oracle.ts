/**
 * Private, reviewer-inspected oracle bindings for the database acceptance
 * suite. These transport the behavioral tests onto a concrete implementation
 * WITHOUT supplying the isolation solution: `withScope`/`setScope` forward to
 * the implementation's own scope primitive, and the schema adapter reads the
 * live catalog instead of assuming a particular column layout.
 *
 * Freeze this file when comparing implementations. Swapping it for an
 * alternate's binding must not add a transaction, establish scope by itself,
 * filter results, grant privileges, or otherwise repair behavior.
 */
import { setLocalTenant, withTenantTransaction } from "../../src/index.js";
import type { Pool, PoolClient } from "../../src/index.js";

/** Run `fn` on a connection the implementation has scoped to `tenantId`. */
export function withScope<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, tenantId, fn);
}

/** Establish the implementation's tenant scope on an already-open transaction. */
export function setScope(client: PoolClient, tenantId: string): Promise<void> {
  return setLocalTenant(client, tenantId);
}

export interface Queryer {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** True when the live schema carries a tenant discriminator on `ticket_tags`. */
export async function ticketTagsHasTenantColumn(owner: Queryer): Promise<boolean> {
  const result = await owner.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ticket_tags' AND column_name = 'tenant_id'`
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Insert a ticket/tag link through whichever representation the live schema
 * uses. Base `(ticket_id, tag_id)` where supported; the known tenant is added
 * only when the implementation requires the column. Owner-side setup only.
 */
export async function insertTicketTag(
  owner: Queryer,
  link: { ticketId: string; tagId: string; tenantId: string }
): Promise<void> {
  if (await ticketTagsHasTenantColumn(owner)) {
    await owner.query("INSERT INTO ticket_tags (ticket_id, tag_id, tenant_id) VALUES ($1, $2, $3)", [
      link.ticketId,
      link.tagId,
      link.tenantId
    ]);
    return;
  }
  await owner.query("INSERT INTO ticket_tags (ticket_id, tag_id) VALUES ($1, $2)", [link.ticketId, link.tagId]);
}

export interface PrivilegedFunction {
  schema: string;
  name: string;
  owner: string;
  publicExecute: boolean;
  appExecute: boolean;
}

/**
 * Every SECURITY DEFINER function reachable outside the system schemas,
 * discovered from the catalog rather than a fixed name list. Used to assert
 * the security *properties* of privileged entry points regardless of how many
 * there are or what they are called.
 */
export async function privilegedFunctions(owner: Queryer, appRole: string): Promise<PrivilegedFunction[]> {
  const result = await owner.query<{
    schema: string;
    name: string;
    owner: string;
    public_execute: boolean;
    app_execute: boolean;
  }>(
    `SELECT n.nspname AS schema, p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
            has_function_privilege($1, p.oid, 'EXECUTE') AS app_execute
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef = true AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY n.nspname, p.proname`,
    [appRole]
  );
  return result.rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    owner: row.owner,
    publicExecute: row.public_execute,
    appExecute: row.app_execute
  }));
}

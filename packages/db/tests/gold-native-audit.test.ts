/**
 * GOLD-NATIVE DATABASE AUDIT — private, NOT transferable acceptance.
 *
 * These checks are bound to *this* gold's chosen mechanism: the `ticketry`
 * schema, its definer function names and fixed `search_path`, the RLS policy
 * expressions, and the composite tenant keys. They exist to catch regressions
 * in the gold itself and must never be copied into candidate acceptance or
 * presented as implementation-agnostic evidence. An alternate implementation
 * is judged only by the behavioral suite in security-acceptance.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "../src/index.js";
import type { Pool } from "../src/index.js";
import { APP_ROLE, adminUrlFromEnv, createEphemeralDatabase } from "../src/testing.js";
import type { EphemeralDatabase } from "../src/testing.js";

const GOLD_FUNCTIONS = ["authenticate_api_key", "current_tenant_id", "resolve_staff_tenant", "worker_tenant_ids"];
const GOLD_POLICY_TABLES = [
  "tenants",
  "memberships",
  "api_keys",
  "ticket_counters",
  "tickets",
  "comments",
  "tags",
  "ticket_tags",
  "audit_log",
  "saved_views",
  "export_jobs",
  "notification_outbox",
  "lifecycle_events"
].sort();

const REAL_KEY_HASH = "opaque-gold-hash";
const SENTINEL_EMAIL = "shadow-attacker@evil.test";

describe("gold-native database audit", () => {
  let db: EphemeralDatabase;
  let admin: Pool;
  let app: Pool;
  let tenantA: string;
  let tenantB: string;
  let userA: string;

  beforeAll(async () => {
    db = await createEphemeralDatabase(adminUrlFromEnv());
    admin = createPool({ connectionString: db.adminUrl, max: 2 });
    app = createPool({ connectionString: db.appUrl, max: 1 });
    const tenants = await admin.query<{ id: string }>(
      "INSERT INTO tenants (slug, name) VALUES ('alpha-security', 'A'), ('beta-security', 'B') RETURNING id"
    );
    tenantA = tenants.rows[0]!.id;
    tenantB = tenants.rows[1]!.id;
    const users = await admin.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('real@example.test', 'Real User') RETURNING id"
    );
    userA = users.rows[0]!.id;
    await admin.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $3, 'agent'), ($2, $3, 'viewer')", [
      tenantA,
      tenantB,
      userA
    ]);
    await admin.query("INSERT INTO api_keys (tenant_id, user_id, key_hash, label) VALUES ($1, $2, $3, 'k')", [
      tenantA,
      userA,
      REAL_KEY_HASH
    ]);
    await admin.query("INSERT INTO tags (tenant_id, name) VALUES ($1, 'shared'), ($2, 'shared')", [tenantA, tenantB]);
    await admin.query("INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 2), ($2, 2)", [tenantA, tenantB]);
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
    await db.drop();
  });

  it("locks down the gold's controlled functions and search_path", async () => {
    const functions = await admin.query<{
      name: string;
      owner: string;
      security_definer: boolean;
      config: string[] | null;
      public_execute: boolean;
      app_execute: boolean;
    }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS security_definer, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
              has_function_privilege($1, p.oid, 'EXECUTE') AS app_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ticketry' AND p.prorettype <> 'trigger'::regtype ORDER BY p.proname`,
      [APP_ROLE]
    );
    expect(functions.rows.map((row) => row.name)).toEqual(GOLD_FUNCTIONS);
    // The workspace-immutability trigger function is not an entry point: nobody may call it.
    const triggerFunctions = await admin.query<{ name: string; public_execute: boolean; app_execute: boolean }>(
      `SELECT p.proname AS name,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
              has_function_privilege($1, p.oid, 'EXECUTE') AS app_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ticketry' AND p.prorettype = 'trigger'::regtype ORDER BY p.proname`,
      [APP_ROLE]
    );
    expect(triggerFunctions.rows).toEqual([{ name: "reject_workspace_change", public_execute: false, app_execute: false }]);
    for (const fn of functions.rows) {
      expect(fn.owner).not.toBe(APP_ROLE);
      expect(fn.config).toContain("search_path=pg_catalog");
      expect(fn.public_execute).toBe(false);
      expect(fn.app_execute).toBe(true);
    }
    expect(functions.rows.find((row) => row.name === "current_tenant_id")?.security_definer).toBe(false);
    expect(functions.rows.filter((row) => row.name !== "current_tenant_id").every((row) => row.security_definer)).toBe(true);
  });

  it("defines an isolation policy driven by the tenant accessor on every protected table", async () => {
    const policies = await admin.query<{ tablename: string; cmd: string; qual: string; with_check: string }>(
      `SELECT tablename, cmd, qual, with_check FROM pg_policies
       WHERE schemaname = 'public' AND roles @> ARRAY[$1]::name[] ORDER BY tablename`,
      [APP_ROLE]
    );
    expect(policies.rows.map((row) => row.tablename)).toEqual(GOLD_POLICY_TABLES);
    for (const policy of policies.rows) {
      expect(policy.cmd).toBe("ALL");
      expect(policy.qual).toContain("ticketry.current_tenant_id()");
      expect(policy.with_check).toContain("ticketry.current_tenant_id()");
    }
  });

  it("retains only the least runtime grants after replacing the migration-0003 grants", async () => {
    const obsolete = await admin.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = $1
         AND ((table_name IN ('tenants', 'memberships', 'api_keys') AND privilege_type <> 'SELECT')
           OR (table_name = 'users' AND privilege_type <> 'SELECT')
           OR (privilege_type = 'DELETE' AND table_name NOT IN ('ticket_tags', 'saved_views'))
           -- Nothing truncates, references or adds triggers from the runtime; TRUNCATE in
           -- particular ignores row-level security altogether.
           OR privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER'))`,
      [APP_ROLE]
    );
    expect(obsolete.rowCount).toBe(0);
  });

  it("enforces the composite tenant keys so a cross-tenant tag link cannot be inserted", async () => {
    const tags = await admin.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM tags");
    const tagB = tags.rows.find((row) => row.tenant_id === tenantB)!.id;
    const ticket = await admin.query<{ id: string }>(
      "INSERT INTO tickets (tenant_id, number, subject, requester_id) VALUES ($1, 1, 'A', $2) RETURNING id",
      [tenantA, userA]
    );
    const ticketA = ticket.rows[0]!.id;
    // Even the owner cannot bypass the composite foreign key that ties a link's
    // tenant to both endpoints.
    await expect(
      admin.query("INSERT INTO ticket_tags (ticket_id, tag_id, tenant_id) VALUES ($1, $2, $3)", [ticketA, tagB, tenantA])
    ).rejects.toThrow();
  });

  it("resists search-path shadowing of the identity tables during authentication", async () => {
    const client = await app.connect();
    try {
      const created = await client
        .query("CREATE TEMP TABLE users (id uuid, email text, display_name text, is_staff boolean, disabled_at timestamptz)")
        .then(() => true, () => false);
      if (!created) {
        // Denied temp creation is itself containment evidence; nothing to shadow.
        expect(created).toBe(false);
        return;
      }
      await client.query(
        "INSERT INTO users (id, email, display_name, is_staff, disabled_at) VALUES (gen_random_uuid(), $1, 'Attacker', true, NULL)",
        [SENTINEL_EMAIL]
      );
      await client.query("CREATE TEMP TABLE api_keys (id uuid, tenant_id uuid, user_id uuid, key_hash text, revoked_at timestamptz, last_used_at timestamptz)");
      await client.query("CREATE TEMP TABLE memberships (tenant_id uuid, user_id uuid, role text, revoked_at timestamptz)");
      await client.query("CREATE TEMP TABLE tenants (id uuid, slug text)");
      await client.query("SET search_path = pg_temp, public, pg_catalog");

      const authed = await client.query<{ user_id: string; email: string; memberships: { tenantSlug: string }[] }>(
        "SELECT user_id, email, memberships FROM ticketry.authenticate_api_key($1)",
        [REAL_KEY_HASH]
      );
      // The definer's fixed search_path and qualified references defeat the
      // shadow tables: the real principal is returned, the sentinel never is.
      expect(authed.rows[0]?.user_id).toBe(userA);
      expect(authed.rows[0]?.email).toBe("real@example.test");
      expect(authed.rows.some((row) => row.email === SENTINEL_EMAIL)).toBe(false);
      expect(authed.rows[0]?.memberships.map((m) => m.tenantSlug).sort()).toEqual(["alpha-security", "beta-security"]);

      const invalid = await client.query("SELECT user_id FROM ticketry.authenticate_api_key($1)", ["no-such-hash"]);
      expect(invalid.rowCount).toBe(0);
    } finally {
      client.release();
    }
    // The real identity data is unchanged apart from documented last_used_at usage.
    const real = await admin.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userA]);
    expect(real.rows[0]?.email).toBe("real@example.test");
    expect((await admin.query("SELECT 1 FROM users WHERE email = $1", [SENTINEL_EMAIL])).rowCount).toBe(0);
  });
});

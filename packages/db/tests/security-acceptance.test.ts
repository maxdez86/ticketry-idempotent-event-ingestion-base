/**
 * Database tenant-isolation acceptance oracle.
 *
 * This suite asserts the *observable* database boundary: what the non-owning
 * runtime role can and cannot read or change with and without workspace
 * context. It deliberately avoids naming policies, functions, GUCs, schemas,
 * or column layouts so an alternate correct implementation passes the same
 * assertions by swapping only the private bindings in ./support/oracle.ts.
 *
 * Gold-specific structural checks (function names, search_path, policy
 * expressions, composite keys, search-path shadowing) live in the separate,
 * non-transferable gold-native audit suite.
 */
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS_DIR, createPool, loadMigrations, migrate } from "../src/index.js";
import type { Pool } from "../src/index.js";
import { APP_ROLE, adminUrlFromEnv, createEphemeralDatabase } from "../src/testing.js";
import type { EphemeralDatabase } from "../src/testing.js";
import { insertTicketTag, privilegedFunctions, setScope, withScope } from "./support/oracle.js";

/** Tenant-owned runtime tables that must isolate by workspace. */
const TENANT_TABLES = [
  "tenants",
  "memberships",
  "ticket_counters",
  "tickets",
  "comments",
  "tags",
  "ticket_tags",
  "audit_log",
  "saved_views",
  "export_jobs",
  "notification_outbox"
] as const;

/** Credential store: never disclosed to the runtime role, with or without context. */
const CREDENTIAL_TABLE = "api_keys";

interface SecurityFixtures {
  tenantA: string;
  tenantB: string;
  userA: string;
  userB: string;
  ticketA: string;
  ticketB: string;
  tagA: string;
  tagB: string;
  viewA: string;
  viewB: string;
}

async function seedFixtures(admin: Pool): Promise<SecurityFixtures> {
  const tenants = await admin.query<{ id: string }>(
    `INSERT INTO tenants (slug, name)
     VALUES ('alpha-security', 'Confusable Workspace'), ('beta-security', 'Confusable Workspace')
     RETURNING id`
  );
  const users = await admin.query<{ id: string }>(
    `INSERT INTO users (email, display_name)
     VALUES ('alpha-security@example.test', 'Same Name'), ('beta-security@example.test', 'Same Name')
     RETURNING id`
  );
  const tenantA = tenants.rows[0]!.id;
  const tenantB = tenants.rows[1]!.id;
  const userA = users.rows[0]!.id;
  const userB = users.rows[1]!.id;
  await admin.query(
    "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $3, 'agent'), ($2, $4, 'agent')",
    [tenantA, tenantB, userA, userB]
  );
  await admin.query(
    "INSERT INTO api_keys (tenant_id, user_id, key_hash, label) VALUES ($1, $3, 'opaque-alpha-hash', 'same'), ($2, $4, 'opaque-beta-hash', 'same')",
    [tenantA, tenantB, userA, userB]
  );
  await admin.query("INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 2), ($2, 2)", [
    tenantA,
    tenantB
  ]);
  const tickets = await admin.query<{ id: string }>(
    `INSERT INTO tickets (tenant_id, number, subject, body, requester_id)
     VALUES ($1, 1, 'Identical subject', 'Identical body', $3),
            ($2, 1, 'Identical subject', 'Identical body', $4)
     RETURNING id`,
    [tenantA, tenantB, userA, userB]
  );
  const ticketA = tickets.rows[0]!.id;
  const ticketB = tickets.rows[1]!.id;
  await admin.query(
    "INSERT INTO comments (tenant_id, ticket_id, author_id, body) VALUES ($1, $3, $5, 'same comment'), ($2, $4, $6, 'same comment')",
    [tenantA, tenantB, ticketA, ticketB, userA, userB]
  );
  await admin.query(
    "INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id) VALUES ($1, $5, 'same.action', 'ticket', $3), ($2, $6, 'same.action', 'ticket', $4)",
    [tenantA, tenantB, ticketA, ticketB, userA, userB]
  );
  await admin.query(
    "INSERT INTO notification_outbox (tenant_id, user_id, kind, payload) VALUES ($1, $3, 'same', '{}'), ($2, $4, 'same', '{}')",
    [tenantA, tenantB, userA, userB]
  );
  const tags = await admin.query<{ id: string }>(
    "INSERT INTO tags (tenant_id, name) VALUES ($1, 'same-tag'), ($2, 'same-tag') RETURNING id",
    [tenantA, tenantB]
  );
  const views = await admin.query<{ id: string }>(
    `INSERT INTO saved_views (tenant_id, owner_id, name, filters)
     VALUES ($1, $3, 'Same view', '{}'), ($2, $4, 'Same view', '{}') RETURNING id`,
    [tenantA, tenantB, userA, userB]
  );
  const tagA = tags.rows[0]!.id;
  const tagB = tags.rows[1]!.id;
  const viewA = views.rows[0]!.id;
  const viewB = views.rows[1]!.id;
  // Schema-independent fixture setup: base columns where supported, the known
  // tenant supplied only when the live schema requires the discriminator.
  await insertTicketTag(admin, { ticketId: ticketA, tagId: tagA, tenantId: tenantA });
  await insertTicketTag(admin, { ticketId: ticketB, tagId: tagB, tenantId: tenantB });
  await admin.query(
    "INSERT INTO export_jobs (tenant_id, requested_by, view_id) VALUES ($1, $3, $5), ($2, $4, $6)",
    [tenantA, tenantB, userA, userB, viewA, viewB]
  );
  return { tenantA, tenantB, userA, userB, ticketA, ticketB, tagA, tagB, viewA, viewB };
}

describe("database tenant-isolation acceptance", () => {
  let db: EphemeralDatabase;
  let admin: Pool;
  let app: Pool;
  let f: SecurityFixtures;

  beforeAll(async () => {
    db = await createEphemeralDatabase(adminUrlFromEnv());
    admin = createPool({ connectionString: db.adminUrl, max: 2 });
    app = createPool({ connectionString: db.appUrl, max: 1 });
    f = await seedFixtures(admin);
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
    await db.drop();
  });

  it("keeps the runtime role non-owning, non-superuser, and non-bypassrls", async () => {
    const role = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [APP_ROLE]
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await admin.query(
      `SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION ALL
       SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [APP_ROLE]
    );
    expect(owned.rowCount).toBe(0);
  });

  it("exposes no privileged definer function to PUBLIC and none owned by the runtime role", async () => {
    const fns = await privilegedFunctions(admin, APP_ROLE);
    // The implementation may use any number of definer functions under any name;
    // every one it exposes must be owner-owned and closed to PUBLIC execution.
    for (const fn of fns) {
      expect(fn.owner, `${fn.schema}.${fn.name} is owned by the runtime role`).not.toBe(APP_ROLE);
      expect(fn.publicExecute, `${fn.schema}.${fn.name} is PUBLIC-executable`).toBe(false);
    }
  });

  it("enables row-level security on every tenant-owned runtime table", async () => {
    const rls = await admin.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [[...TENANT_TABLES]]
    );
    expect(rls.rows.map((row) => row.relname)).toEqual([...TENANT_TABLES].sort());
    expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
  });

  it("returns nothing without context and cannot mutate protected data", async () => {
    // Credential material must never be disclosed to the runtime role.
    const credential = await app.query(`SELECT * FROM ${CREDENTIAL_TABLE}`).then(
      (result) => ({ ok: true as const, rowCount: result.rowCount }),
      (error) => ({ ok: false as const, error })
    );
    if (credential.ok) {
      expect(credential.rowCount, "credential rows leaked without context").toBe(0);
    } else {
      expect(String((credential.error as Error).message)).toMatch(/permission denied/);
    }

    for (const table of TENANT_TABLES) {
      const rows = await app.query(`SELECT * FROM ${table}`);
      expect(rows.rowCount, `${table} leaked rows without tenant context`).toBe(0);
    }
    await expect(
      app.query(
        `INSERT INTO tickets (tenant_id, number, subject, requester_id)
         VALUES ($1, 99, 'unauthorized', $2)`,
        [f.tenantA, f.userA]
      )
    ).rejects.toThrow();
    expect((await app.query("UPDATE tickets SET subject = 'changed' WHERE id = $1", [f.ticketA])).rowCount).toBe(0);
    await expect(app.query("DELETE FROM saved_views WHERE id = $1", [f.viewA])).resolves.toMatchObject({ rowCount: 0 });
    const unchanged = await admin.query<{ subject: string }>("SELECT subject FROM tickets WHERE id = $1", [f.ticketA]);
    expect(unchanged.rows[0]?.subject).toBe("Identical subject");
    expect((await admin.query("SELECT 1 FROM saved_views WHERE id = $1", [f.viewA])).rowCount).toBe(1);
  });

  it("never discloses the credential store even with workspace context", async () => {
    const disclosed = await withScope(app, f.tenantA, (client) =>
      client
        .query(`SELECT key_hash FROM ${CREDENTIAL_TABLE}`)
        .then((result) => ({ ok: true as const, rowCount: result.rowCount }), (error) => ({ ok: false as const, error }))
    );
    if (disclosed.ok) {
      expect(disclosed.rowCount, "credential verifiers disclosed under context").toBe(0);
    } else {
      expect(String((disclosed.error as Error).message)).toMatch(/permission denied/);
    }
  });

  it("shows only the selected tenant and rejects foreign IDs, rewrites, and cross-tenant links", async () => {
    const scopeColumn = new Map<string, string>([["tenants", "id"]]);
    await withScope(app, f.tenantA, async (client) => {
      for (const table of TENANT_TABLES) {
        const column = scopeColumn.get(table) ?? "tenant_id";
        const rows = await client.query<{ scope: string }>(`SELECT ${column} AS scope FROM ${table}`);
        expect(rows.rows.length, `${table} had no tenant A fixture`).toBeGreaterThan(0);
        expect(rows.rows.every((row) => row.scope === f.tenantA), `${table} crossed tenant scope`).toBe(true);
      }
      // Positive control: an own-tenant write succeeds so the denials below
      // cannot pass merely because every write is blocked.
      expect(
        (await client.query("UPDATE tickets SET subject = 'own update' WHERE id = $1", [f.ticketA])).rowCount
      ).toBe(1);
      expect((await client.query("UPDATE tickets SET subject = 'foreign update' WHERE id = $1", [f.ticketB])).rowCount).toBe(0);
      expect((await client.query("DELETE FROM saved_views WHERE id = $1", [f.viewB])).rowCount).toBe(0);
    });

    await expect(
      withScope(app, f.tenantA, (client) =>
        client.query("UPDATE tickets SET tenant_id = $1 WHERE id = $2", [f.tenantB, f.ticketA])
      )
    ).rejects.toThrow();
    await expect(
      withScope(app, f.tenantA, (client) =>
        client.query(
          "INSERT INTO tickets (tenant_id, number, subject, requester_id) VALUES ($1, 88, 'foreign insert', $2)",
          [f.tenantB, f.userA]
        )
      )
    ).rejects.toThrow();
    await expect(
      withScope(app, f.tenantA, (client) =>
        client.query(
          "INSERT INTO comments (tenant_id, ticket_id, author_id, body) VALUES ($1, $2, $3, 'cross')",
          [f.tenantA, f.ticketB, f.userA]
        )
      )
    ).rejects.toThrow();
    await expect(
      withScope(app, f.tenantA, (client) =>
        client.query(
          "INSERT INTO export_jobs (tenant_id, requested_by, view_id) VALUES ($1, $2, $3)",
          [f.tenantA, f.userA, f.viewB]
        )
      )
    ).rejects.toThrow();
    expect((await admin.query("SELECT 1 FROM comments WHERE body = 'cross'")).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM tickets WHERE id = $1 AND subject = 'foreign update'", [f.ticketB])).rowCount).toBe(0);
    // Restore the fixture value mutated by the positive control above.
    await admin.query("UPDATE tickets SET subject = 'Identical subject' WHERE id = $1", [f.ticketA]);
  });

  it("keeps tenant context transaction-local across commit, rollback, failure, and pool reuse", async () => {
    expect(await withScope(app, f.tenantA, async (client) => (await client.query("SELECT id FROM tenants")).rows.map((row) => row.id))).toEqual([f.tenantA]);
    expect((await app.query("SELECT id FROM tenants")).rowCount).toBe(0);

    const client = await app.connect();
    await client.query("BEGIN");
    await setScope(client, f.tenantB);
    expect((await client.query("SELECT id FROM tenants")).rows.map((row) => row.id)).toEqual([f.tenantB]);
    await client.query("ROLLBACK");
    client.release();
    expect((await app.query("SELECT id FROM tenants")).rowCount).toBe(0);

    await expect(
      withScope(app, f.tenantA, async (scoped) => {
        expect((await scoped.query("SELECT id FROM tenants")).rowCount).toBe(1);
        throw new Error("controlled callback failure");
      })
    ).rejects.toThrow("controlled callback failure");
    // A failed scope must not poison the next borrower: reborrow and prove the
    // pooled connection carries no residual visibility.
    const reborrowed = await app.connect();
    try {
      expect((await reborrowed.query("SELECT id FROM tenants")).rowCount).toBe(0);
      await reborrowed.query("BEGIN");
      await setScope(reborrowed, f.tenantB);
      expect((await reborrowed.query("SELECT id FROM tenants")).rows[0]?.id).toBe(f.tenantB);
      await reborrowed.query("COMMIT");
    } finally {
      reborrowed.release();
    }
    expect((await app.query("SELECT id FROM tenants")).rowCount).toBe(0);
  });

  it("preserves historical migration checksums and validates an unchanged rerun", async () => {
    const recorded = await admin.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations WHERE version <= 3 ORDER BY version"
    );
    expect(recorded.rows).toEqual([
      { version: 1, checksum: "e736de2ab1065f952b55d07511ab5a5f36e6a09a1bf3a658a28a4a364283d2e0" },
      { version: 2, checksum: "2683226dab2509a6094b5ddbc47d1fe3336f7290908ab285a8d269145ea623a5" },
      { version: 3, checksum: "db7ee4f64272b0c1a825f276d1dcd673281ba5e9b68bc9f0864ae38d3e0740bc" }
    ]);
    const unchanged = await migrate(admin);
    expect(unchanged.applied).toEqual([]);
    expect(unchanged.alreadyApplied).toBe((await loadMigrations()).length);
  });
});


/**
 * The isolation migrations must refuse to apply on top of legacy data that
 * already violates tenant consistency, roll back cleanly, and — once only the
 * bad data is corrected — apply and re-validate. Asserted behaviorally: which
 * migration version carries the constraints, and how the schema is shaped, are
 * the implementation's business.
 */
describe("migration consistency enforcement", () => {
  it("rejects legacy cross-tenant data, preserves valid rows, and reruns after a data fix", async () => {
    const scratch = await createEphemeralDatabase(adminUrlFromEnv(), { migrate: false });
    const scratchAdmin = createPool({ connectionString: scratch.adminUrl, max: 1 });
    // Seed against the immutable base only, then let the full set try to apply.
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "ticketry-base-migrations-"));
    for (const filename of (await readdir(MIGRATIONS_DIR)).filter((name) => /^000[1-3]_.*\.sql$/.test(name))) {
      await copyFile(path.join(MIGRATIONS_DIR, filename), path.join(baseDir, filename));
    }
    try {
      const base = await migrate(scratchAdmin, { dir: baseDir });
      expect(base.applied).toHaveLength(3);
      const total = (await loadMigrations()).length;

      const tenants = await scratchAdmin.query<{ id: string }>(
        "INSERT INTO tenants (slug, name) VALUES ('legacy-a', 'Same'), ('legacy-b', 'Same') RETURNING id"
      );
      const users = await scratchAdmin.query<{ id: string }>(
        "INSERT INTO users (email, display_name) VALUES ('legacy-a@example.test', 'Same'), ('legacy-b@example.test', 'Same') RETURNING id"
      );
      const tickets = await scratchAdmin.query<{ id: string }>(
        `INSERT INTO tickets (tenant_id, number, subject, requester_id)
         VALUES ($1, 1, 'Same', $3), ($2, 1, 'Same', $4) RETURNING id`,
        [tenants.rows[0]!.id, tenants.rows[1]!.id, users.rows[0]!.id, users.rows[1]!.id]
      );
      // A comment whose tenant contradicts its ticket's tenant.
      const badComment = await scratchAdmin.query<{ id: string }>(
        "INSERT INTO comments (tenant_id, ticket_id, author_id, body) VALUES ($1, $2, $3, 'legacy mismatch') RETURNING id",
        [tenants.rows[0]!.id, tickets.rows[1]!.id, users.rows[0]!.id]
      );

      await expect(migrate(scratchAdmin)).rejects.toThrow();
      // The consistency migrations did not all record, and no valid row was
      // silently deleted or reassigned to make the data pass.
      const applied = await scratchAdmin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM schema_migrations"
      );
      expect(applied.rows[0]!.count).toBeLessThan(total);
      expect((await scratchAdmin.query("SELECT 1 FROM tickets")).rowCount).toBe(2);
      expect((await scratchAdmin.query("SELECT tenant_id FROM comments WHERE id = $1", [badComment.rows[0]!.id])).rows[0])
        .toEqual({ tenant_id: tenants.rows[0]!.id });

      // Correcting only the offending row permits a checksum-consistent rerun.
      await scratchAdmin.query("DELETE FROM comments WHERE id = $1", [badComment.rows[0]!.id]);
      const repaired = await migrate(scratchAdmin);
      expect(repaired.applied.length).toBeGreaterThan(0);
      const rerun = await migrate(scratchAdmin);
      expect(rerun.applied).toEqual([]);
      expect(rerun.alreadyApplied).toBe(total);
    } finally {
      await scratchAdmin.end();
      await scratch.drop();
    }
  });
});

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MigrationDriftError, MigrationError, createPool, loadMigrations, migrate } from "../src/index.js";
import type { Pool } from "../src/index.js";
import { adminUrlFromEnv, createEphemeralDatabase } from "../src/testing.js";
import type { EphemeralDatabase } from "../src/testing.js";

describe("migration runner", () => {
  let db: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createEphemeralDatabase(adminUrlFromEnv());
    pool = createPool({ connectionString: db.adminUrl, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it("applies the repository migrations exactly once", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(3);

    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(migrations.length);

    const recorded = await pool.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version"
    );
    expect(recorded.rows.map((row) => row.version)).toEqual(migrations.map((m) => m.version));
    expect(recorded.rows.map((row) => row.checksum)).toEqual(migrations.map((m) => m.checksum));
  });

  it("creates the runtime role without ownership of any table", async () => {
    const owners = await pool.query<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public'"
    );
    expect(owners.rows.length).toBeGreaterThan(0);
    for (const row of owners.rows) {
      expect(row.tableowner).not.toBe("ticketry_app");
    }
    const grants = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'ticketry_app' AND privilege_type = 'INSERT'`
    );
    expect(grants.rows.map((row) => row.table_name)).toContain("tickets");
  });

  it("refuses to continue when an applied migration file changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ticketry-migrations-"));
    await writeFile(path.join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id int PRIMARY KEY);");

    const scratch = await createEphemeralDatabase(adminUrlFromEnv(), { migrate: false });
    const scratchPool = createPool({ connectionString: scratch.adminUrl, max: 2 });
    try {
      const first = await migrate(scratchPool, { dir });
      expect(first.applied).toEqual(["0001_widgets.sql"]);

      await writeFile(path.join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id bigint PRIMARY KEY);");
      await expect(migrate(scratchPool, { dir })).rejects.toBeInstanceOf(MigrationDriftError);

      await writeFile(path.join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id int PRIMARY KEY);");
      await writeFile(path.join(dir, "0002_gadgets.sql"), "CREATE TABLE gadgets (id int PRIMARY KEY);");
      const second = await migrate(scratchPool, { dir });
      expect(second.applied).toEqual(["0002_gadgets.sql"]);
      expect(second.alreadyApplied).toBe(1);
    } finally {
      await scratchPool.end();
      await scratch.drop();
    }
  });

  it("rolls back a failing migration and leaves it unapplied", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ticketry-migrations-"));
    await writeFile(
      path.join(dir, "0001_broken.sql"),
      "CREATE TABLE half (id int PRIMARY KEY); CREATE TABLE half (id int PRIMARY KEY);"
    );

    const scratch = await createEphemeralDatabase(adminUrlFromEnv(), { migrate: false });
    const scratchPool = createPool({ connectionString: scratch.adminUrl, max: 2 });
    try {
      await expect(migrate(scratchPool, { dir })).rejects.toBeInstanceOf(MigrationError);
      const tables = await scratchPool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'half'"
      );
      expect(tables.rowCount).toBe(0);
      const recorded = await scratchPool.query("SELECT 1 FROM schema_migrations WHERE version = 1");
      expect(recorded.rowCount).toBe(0);
    } finally {
      await scratchPool.end();
      await scratch.drop();
    }
  });

  it("rejects files that do not follow the naming convention", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ticketry-migrations-"));
    await writeFile(path.join(dir, "initial.sql"), "SELECT 1;");
    await expect(loadMigrations(dir)).rejects.toBeInstanceOf(MigrationError);
  });
});

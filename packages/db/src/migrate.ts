import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "./pool.js";

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

/** Cluster-wide advisory lock so two migrators never race on the same database. */
const MIGRATION_LOCK_KEY = 7_420_119;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  /** Directory holding `NNNN_name.sql` files. Defaults to the package's `migrations/`. */
  dir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export class MigrationDriftError extends MigrationError {
  constructor(
    readonly filename: string,
    readonly expectedChecksum: string,
    readonly actualChecksum: string
  ) {
    super(
      `Migration ${filename} was applied with checksum ${expectedChecksum} but the file now hashes to ${actualChecksum}. Applied migrations are immutable; add a new migration instead.`
    );
    this.name = "MigrationDriftError";
  }
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const migrations: Migration[] = [];
  for (const filename of entries) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      if (filename.endsWith(".sql")) {
        throw new MigrationError(
          `Migration file ${filename} does not match NNNN_snake_case_name.sql`
        );
      }
      continue;
    }
    const sql = await readFile(path.join(dir, filename), "utf8");
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? "",
      filename,
      sql,
      checksum: checksumOf(sql)
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i += 1) {
    const previous = migrations[i - 1];
    const current = migrations[i];
    if (previous && current && previous.version === current.version) {
      throw new MigrationError(
        `Migrations ${previous.filename} and ${current.filename} share version ${current.version}`
      );
    }
  }
  return migrations;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * Apply every pending migration in version order. Safe to run repeatedly and
 * concurrently: an advisory lock serialises migrators, each file runs in its
 * own transaction, and a file that was already applied is verified against the
 * recorded checksum instead of being re-run.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const migrations = await loadMigrations(options.dir);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query<AppliedRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    );
    const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row]));

    const result: MigrateResult = { applied: [], alreadyApplied: 0 };
    for (const migration of migrations) {
      const existing = appliedByVersion.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationDriftError(migration.filename, existing.checksum, migration.checksum);
        }
        result.alreadyApplied += 1;
        continue;
      }
      log(`applying ${migration.filename}`);
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new MigrationError(
          `Migration ${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      result.applied.push(migration.filename);
    }
    return result;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      // Releasing the client drops the session lock anyway.
    }
    client.release();
  }
}

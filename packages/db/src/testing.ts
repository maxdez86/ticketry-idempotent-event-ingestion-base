/**
 * Throwaway databases for integration tests.
 *
 * Every caller gets its own database on the server behind `DATABASE_URL`
 * (a superuser or owner connection), fully migrated, plus a connection string
 * for the non-owning runtime role `ticketry_app`. Drop it when the suite ends.
 */
import { randomBytes } from "node:crypto";

import pg from "pg";

import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";
import { withCredentials, withDatabase } from "./url.js";

export const DEFAULT_ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5434/postgres";
export const APP_ROLE = "ticketry_app";
export const APP_ROLE_PASSWORD = "ticketry_app";

/**
 * Roles are cluster-wide. Parallel suites each migrate their own database and
 * then alter the same role, which PostgreSQL rejects with "tuple concurrently
 * updated"; a server-level advisory lock serialises that phase.
 */
const ROLE_SETUP_LOCK_KEY = 7_420_120;

export function adminUrlFromEnv(): string {
  return process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
}

export interface EphemeralDatabase {
  name: string;
  /** Owner connection to the new database: migrations, fixtures, assertions. */
  adminUrl: string;
  /** `ticketry_app` connection to the new database: what the API and worker use. */
  appUrl: string;
  drop(): Promise<void>;
}

export interface EphemeralDatabaseOptions {
  /** Apply the repository migrations. Defaults to true; pass false for a pristine database. */
  migrate?: boolean;
}

export async function createEphemeralDatabase(
  adminServerUrl: string = adminUrlFromEnv(),
  options: EphemeralDatabaseOptions = {}
): Promise<EphemeralDatabase> {
  const name = `ticketry_test_${process.pid}_${randomBytes(4).toString("hex")}`;

  const adminUrl = withDatabase(adminServerUrl, name);
  const admin = new pg.Client({ connectionString: adminServerUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    if (options.migrate !== false) {
      await admin.query("SELECT pg_advisory_lock($1)", [ROLE_SETUP_LOCK_KEY]);
      const pool = createPool({ connectionString: adminUrl, max: 2, applicationName: "ticketry-test-setup" });
      try {
        await migrate(pool);
        // The migrations create the role as NOLOGIN when it is missing; tests need to log in as it.
        await pool.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
      } finally {
        await pool.end();
        await admin.query("SELECT pg_advisory_unlock($1)", [ROLE_SETUP_LOCK_KEY]).catch(() => undefined);
      }
    }
  } finally {
    await admin.end();
  }

  return {
    name,
    adminUrl,
    appUrl: withCredentials(adminUrl, APP_ROLE, APP_ROLE_PASSWORD),
    async drop() {
      const client = new pg.Client({ connectionString: adminServerUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    }
  };
}

/**
 * Vitest global setup: make sure a PostgreSQL server is reachable before any
 * suite creates its throwaway database. Honors DATABASE_URL; without it, falls
 * back to the repository's Docker Compose service and starts it when needed.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type pgTypes from "pg";

// This file runs in vitest's global-setup context, outside the project root of
// the package under test, where the bundler does not resolve bare imports.
const require = createRequire(import.meta.url);
const pg = require("pg") as typeof pgTypes;

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5434/postgres";

function adminUrlFromEnv(): string {
  return process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
}

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function startComposeDatabase(): Promise<void> {
  await execFileAsync("docker", ["compose", "up", "-d", "--wait", "db"], { cwd: REPO_ROOT });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Drop throwaway databases left behind by suites that crashed before their teardown. */
async function pruneOrphanedDatabases(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'ticketry\\_test\\_%'"
    );
    for (const { datname } of result.rows) {
      const pid = Number(datname.split("_")[2]);
      if (Number.isInteger(pid) && !processIsAlive(pid)) {
        await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    }
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  const url = adminUrlFromEnv();
  if (await canConnect(url)) {
    await pruneOrphanedDatabases(url);
    return;
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== DEFAULT_ADMIN_URL) {
    throw new Error(`Cannot connect to DATABASE_URL (${redact(url)}). Is the database running?`);
  }
  try {
    await startComposeDatabase();
  } catch (error) {
    throw new Error(
      `No PostgreSQL server at ${redact(url)} and \`docker compose up db\` failed: ${
        error instanceof Error ? error.message : String(error)
      }. Start a server and set DATABASE_URL, or install Docker.`
    );
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await canConnect(url)) {
      await pruneOrphanedDatabases(url);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`PostgreSQL at ${redact(url)} did not become reachable within 60s`);
}

function redact(url: string): string {
  const parsed = new URL(url);
  parsed.password = parsed.password ? "***" : "";
  return parsed.toString();
}

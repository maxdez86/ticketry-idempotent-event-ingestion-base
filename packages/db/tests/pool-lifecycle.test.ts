/**
 * GOLD-NATIVE TRANSACTION LIFECYCLE AUDIT — private, NOT transferable acceptance.
 *
 * These checks exercise this gold's own transaction helper with controlled
 * completion barriers on the pg client. They pin two cleanup properties:
 *
 *   1. cleanup order — a failed transaction's ROLLBACK settles before its
 *      connection can be handed to the next borrower;
 *   2. disposal — a connection whose rollback failed (connection loss) is
 *      discarded rather than returned to the pool, without an unhandled
 *      client/pool error, and a size-one pool recovers with a fresh backend.
 *
 * They call the private helper directly and instrument the client, so they
 * must never be copied into candidate acceptance. Candidate suites observe the
 * same outcomes only through public entry points and pool reuse.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withTenantTransaction } from "../src/index.js";
import type { Pool, PoolClient } from "../src/index.js";
import { adminUrlFromEnv, createEphemeralDatabase } from "../src/testing.js";
import type { EphemeralDatabase } from "../src/testing.js";

const TIMEOUT_MS = 10_000;

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(20);
  }
  throw new Error(`${label} did not happen within ${TIMEOUT_MS}ms`);
}

type AnyQuery = (...args: unknown[]) => unknown;

function queryText(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") {
    return first;
  }
  return (first as { text?: string } | undefined)?.text;
}

/**
 * Completion barrier: ROLLBACK is sent to the server as usual, but its
 * completion is not reported to the caller until `gate` resolves — exactly as
 * if the round trip were slow. Observes when the statement was issued and when
 * its completion was delivered.
 */
function holdRollbackCompletion(pool: Pool, gate: Deferred): { issued: () => boolean; settled: () => boolean } {
  let issued = false;
  let settled = false;
  pool.on("connect", (client: PoolClient) => {
    const original = client.query.bind(client) as AnyQuery;
    const instrumented: AnyQuery = (...args) => {
      if (queryText(args) !== "ROLLBACK") {
        return original(...args);
      }
      issued = true;
      return (async () => {
        const result = await original(...args);
        await gate.promise;
        settled = true;
        return result;
      })();
    };
    (client as unknown as { query: AnyQuery }).query = instrumented;
  });
  return { issued: () => issued, settled: () => settled };
}

describe("gold-native transaction lifecycle audit", () => {
  let db: EphemeralDatabase;
  let admin: Pool;
  let tenantA: string;

  beforeAll(async () => {
    db = await createEphemeralDatabase(adminUrlFromEnv());
    admin = createPool({ connectionString: db.adminUrl, max: 2 });
    const tenants = await admin.query<{ id: string }>(
      "INSERT INTO tenants (slug, name) VALUES ('lifecycle-alpha', 'Alpha') RETURNING id"
    );
    tenantA = tenants.rows[0]!.id;
  });

  afterAll(async () => {
    await admin.end();
    await db.drop();
  });

  it("settles a failed transaction's rollback before the connection can be reborrowed", async () => {
    const pool = createPool({ connectionString: db.appUrl, max: 1 });
    const gate = deferred();
    const rollback = holdRollbackCompletion(pool, gate);
    try {
      const failing = withTenantTransaction(pool, tenantA, async () => {
        throw new Error("controlled callback failure");
      });
      const failure = failing.then(
        () => null,
        (error: unknown) => error as Error
      );
      await waitUntil(() => rollback.issued(), "rollback issue");

      // Cleanup is still unsettled: the connection must remain checked out and
      // a competing borrower must keep waiting.
      expect(pool.idleCount, "connection returned to the pool before its rollback settled").toBe(0);
      const reborrow = pool.connect();
      const reborrowedEarly = await Promise.race([reborrow.then(() => true), delay(300).then(() => false)]);
      expect(reborrowedEarly, "connection handed to the next borrower before its rollback settled").toBe(false);
      expect(rollback.settled()).toBe(false);

      gate.resolve();
      const client = await reborrow;
      try {
        expect(rollback.settled(), "reborrow completed before rollback settlement").toBe(true);
        const visible = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM tenants");
        expect(visible.rows[0]?.count, "reborrowed connection carried residual scope").toBe(0);
      } finally {
        client.release();
      }
      // The operation's own error is what the caller sees; cleanup evidence is not substituted for it.
      expect(await failure).toMatchObject({ message: "controlled callback failure" });
      expect(pool.totalCount - pool.idleCount).toBe(0);
    } finally {
      gate.resolve();
      await pool.end();
    }
  });

  it("reuses the connection after application and database errors but discards it after connection loss", async () => {
    const pool = createPool({ connectionString: db.appUrl, max: 1 });
    const poolErrors: Error[] = [];
    const removed: number[] = [];
    pool.on("error", (error: Error) => poolErrors.push(error));
    pool.on("remove", () => removed.push(removed.length + 1));
    const backendPid = (): Promise<number> =>
      withTenantTransaction(
        pool,
        tenantA,
        async (client) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid
      );
    try {
      const originalPid = await backendPid();

      // Application error: the callback throws; the healthy connection is reused.
      await expect(
        withTenantTransaction(pool, tenantA, async () => {
          throw new Error("application failure");
        })
      ).rejects.toThrow("application failure");
      expect(await backendPid()).toBe(originalPid);

      // Real database error: the statement fails and leaves the transaction
      // aborted; rollback succeeds and the connection is reused.
      await expect(
        withTenantTransaction(pool, tenantA, async (client) => {
          await client.query("SELECT 1/0");
        })
      ).rejects.toThrow(/division by zero/);
      expect(await backendPid()).toBe(originalPid);
      expect(removed).toEqual([]);

      // Connection loss during an active statement: rollback cannot succeed,
      // so the connection must be discarded — never parked for the next borrower.
      const lost = withTenantTransaction(pool, tenantA, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        expect(pid).toBe(originalPid);
        const busy = client.query("SELECT pg_sleep(30)");
        // The termination may reject `busy` before the owner's own statement
        // returns; mark it handled now and observe its rejection below.
        busy.catch(() => undefined);
        await waitUntil(
          async () =>
            ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active'", [pid])).rowCount ?? 0) >
            0,
          "busy statement to become active"
        );
        await admin.query("SELECT pg_terminate_backend($1)", [pid]);
        await busy;
      });
      await expect(lost).rejects.toThrow(/terminat/i);
      expect(removed, "dead connection was not discarded on release").toEqual([1]);
      expect(pool.totalCount, "dead connection remained in the pool").toBe(0);

      // Size-one pool recovery: a fresh backend, no residual scope, scope works.
      const recoveredPid = await backendPid();
      expect(recoveredPid).not.toBe(originalPid);
      expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM tenants")).rows[0]?.count).toBe(0);
      expect(
        await withTenantTransaction(pool, tenantA, async (client) =>
          (await client.query<{ id: string }>("SELECT id FROM tenants")).rows.map((row) => row.id)
        )
      ).toEqual([tenantA]);
      expect(pool.totalCount - pool.idleCount).toBe(0);
      // No connection error escaped to the pool: the checked-out client observed it.
      expect(poolErrors.map((error) => error.message)).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});

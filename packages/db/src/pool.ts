import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResult<T extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<T>;

export type TransactionCallback<T> = (client: PoolClient) => Promise<T>;

/** Anything that can run a query: a pool, or a checked-out client inside a transaction. */
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface PoolOptions {
  connectionString: string;
  /** Maximum number of clients in the pool. Defaults to 10. */
  max?: number;
  applicationName?: string;
}

export function createPool(options: PoolOptions): Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "ticketry",
    idleTimeoutMillis: 10_000
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function runTransaction<T>(
  pool: Pool,
  initialize: ((client: PoolClient) => Promise<void>) | undefined,
  callback: TransactionCallback<T>
): Promise<T> {
  const client = await pool.connect();
  // A connection error that arrives between statements has no active query to
  // reject and would otherwise be an unhandled 'error' event. Remember it so the
  // connection is discarded instead of being parked for the next borrower.
  let unusable: Error | undefined;
  const onConnectionError = (error: Error): void => {
    unusable ??= error;
  };
  client.on("error", onConnectionError);
  try {
    await client.query("BEGIN");
    if (initialize) {
      await initialize(client);
    }
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Cleanup settles here, before `finally` can return the connection to the
    // pool; the operation's own error is the one the caller sees.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      unusable ??= asError(rollbackError);
    }
    throw error;
  } finally {
    client.off("error", onConnectionError);
    // Releasing with an error makes the pool destroy the connection rather than reuse it.
    client.release(unusable);
  }
}

/** Establish transaction-local tenant scope on an already-open transaction. */
export async function setLocalTenant(
  client: Pick<PoolClient, "query" | "getTransactionStatus">,
  tenantId: string
): Promise<void> {
  if (client.getTransactionStatus() !== "T") {
    throw new Error("setLocalTenant requires an open transaction");
  }
  await client.query("SELECT pg_catalog.set_config('ticketry.tenant_id', $1, true)", [tenantId]);
}

/**
 * Run `fn` inside a single transaction. Commits when `fn` resolves, rolls back
 * when it throws, and always returns the client to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: TransactionCallback<T>
): Promise<T> {
  return runTransaction(pool, undefined, fn);
}

/** Run a callback in one transaction after establishing its tenant scope. */
export async function withTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  fn: TransactionCallback<T>
): Promise<T> {
  return runTransaction(pool, (client) => setLocalTenant(client, tenantId), fn);
}

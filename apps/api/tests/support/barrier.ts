/**
 * Owner-installed fixture barrier for deterministic pre/post-commit timing.
 *
 * Rather than matching the route's private SQL text (which breaks under
 * qualified names, CTEs, or a different write strategy), the barrier is a
 * BEFORE INSERT trigger tied to the actual fixture row: when a ticket whose
 * subject carries the sentinel is inserted, the runtime backend blocks on an
 * advisory lock the test holds. The test observes "reached" through the lock
 * wait (a protocol boundary) and observes the outcome through persisted
 * effects, never through the implementation's statements.
 */
import type { Pool, PoolClient } from "@ticketry/db";

const BARRIER_CLASSID = 424_242;

export async function installTicketInsertBarrier(owner: Pool): Promise<void> {
  await owner.query(`
    CREATE FUNCTION ticketry_test_ticket_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.subject LIKE 'BARRIER::%' THEN
        PERFORM pg_advisory_xact_lock(${BARRIER_CLASSID}, split_part(NEW.subject, '::', 2)::int);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ticketry_test_ticket_barrier BEFORE INSERT ON tickets
    FOR EACH ROW EXECUTE FUNCTION ticketry_test_ticket_barrier();
  `);
}

export async function removeTicketInsertBarrier(owner: Pool): Promise<void> {
  await owner.query(
    "DROP TRIGGER IF EXISTS ticketry_test_ticket_barrier ON tickets; DROP FUNCTION IF EXISTS ticketry_test_ticket_barrier()"
  );
}

/**
 * Same barrier for the authentication phase: recording a recognized key's usage
 * updates its `api_keys` row, so a BEFORE UPDATE trigger tied to a key whose
 * label carries the sentinel blocks the backend inside authentication itself.
 */
export async function installApiKeyUsageBarrier(owner: Pool): Promise<void> {
  await owner.query(`
    CREATE FUNCTION ticketry_test_api_key_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.label LIKE 'BARRIER::%' THEN
        PERFORM pg_advisory_xact_lock(${BARRIER_CLASSID}, split_part(NEW.label, '::', 2)::int);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ticketry_test_api_key_barrier BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION ticketry_test_api_key_barrier();
  `);
}

export async function removeApiKeyUsageBarrier(owner: Pool): Promise<void> {
  await owner.query(
    "DROP TRIGGER IF EXISTS ticketry_test_api_key_barrier ON api_keys; DROP FUNCTION IF EXISTS ticketry_test_api_key_barrier()"
  );
}

/**
 * Same barrier for a staff request's access record: a BEFORE INSERT trigger on the
 * `staff.workspace_access` audit row blocks the backend while that record is being written.
 */
export async function installStaffAccessBarrier(owner: Pool, objid: number): Promise<void> {
  await owner.query(`
    CREATE FUNCTION ticketry_test_staff_access_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'staff.workspace_access' THEN
        PERFORM pg_advisory_xact_lock(${BARRIER_CLASSID}, ${objid});
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ticketry_test_staff_access_barrier BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION ticketry_test_staff_access_barrier();
  `);
}

export async function removeStaffAccessBarrier(owner: Pool): Promise<void> {
  await owner.query(
    "DROP TRIGGER IF EXISTS ticketry_test_staff_access_barrier ON audit_log; DROP FUNCTION IF EXISTS ticketry_test_staff_access_barrier()"
  );
}

/** The ticket subject (or API-key label) a request must carry to trip the barrier at `objid`. */
export function barrierSubject(objid: number): string {
  return `BARRIER::${objid}`;
}

export class TicketBarrier {
  private holder: PoolClient | null = null;

  constructor(
    private readonly owner: Pool,
    private readonly objid: number
  ) {}

  /** Take the advisory lock so the next barrier insert blocks. */
  async hold(): Promise<void> {
    this.holder = await this.owner.connect();
    await this.holder.query("SELECT pg_advisory_lock($1, $2)", [BARRIER_CLASSID, this.objid]);
  }

  /** Resolve once a backend is blocked inside the trigger for this barrier. */
  async awaitReached(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const waiting = await this.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted`,
        [BARRIER_CLASSID, this.objid]
      );
      if ((waiting.rows[0]?.n ?? 0) >= 1) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`barrier ${this.objid} was not reached within ${timeoutMs}ms`);
  }

  /** Release the lock so the blocked backend proceeds, and free the holder. */
  async release(): Promise<void> {
    if (!this.holder) {
      return;
    }
    await this.holder.query("SELECT pg_advisory_unlock($1, $2)", [BARRIER_CLASSID, this.objid]);
    this.holder.release();
    this.holder = null;
  }
}

/** Poll a condition to a deadline; the barrier makes the transition definite. */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not settle within ${timeoutMs}ms`);
}

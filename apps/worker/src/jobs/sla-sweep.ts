import { listWorkerTenantIds, recordAudit } from "@ticketry/core";
import type { Pool } from "@ticketry/db";
import { withTenantTransaction } from "@ticketry/db";

export interface SlaSweepResult {
  breached: number;
}

interface BreachedRow {
  id: string;
  number: number;
}

/**
 * Flag every active ticket whose SLA due time has passed. Idempotent: a
 * ticket is flagged once, and re-running the sweep finds nothing new.
 */
export async function runSlaSweep(pool: Pool, now: Date = new Date()): Promise<SlaSweepResult> {
  const tenantIds = await listWorkerTenantIds(pool);
  const failures: unknown[] = [];
  let breached = 0;

  for (const tenantId of tenantIds) {
    try {
      breached += await withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<BreachedRow>(
          `UPDATE tickets
           SET sla_breached = true, updated_at = $1
           WHERE tenant_id = $2
             AND sla_due_at IS NOT NULL
             AND sla_due_at < $1
             AND status IN ('open', 'pending')
             AND sla_breached = false
           RETURNING id, number`,
          [now, tenantId]
        );
        for (const row of result.rows) {
          await recordAudit(client, {
            tenantId,
            actorId: null,
            action: "ticket.sla_breached",
            targetType: "ticket",
            targetId: row.id,
            metadata: { number: row.number }
          });
        }
        return result.rows.length;
      });
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `SLA sweep failed for ${failures.length} tenant(s)`);
  }
  return { breached };
}

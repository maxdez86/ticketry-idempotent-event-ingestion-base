import { listWorkerTenantIds } from "@ticketry/core";
import type { Pool } from "@ticketry/db";
import { withTenantTransaction } from "@ticketry/db";

export interface DigestResult {
  usersProcessed: number;
  notificationsQueued: number;
}

/**
 * Queue one "what is on my plate" digest per active workspace membership,
 * listing the user's open and pending assignments ordered by SLA urgency.
 */
export async function runDigest(pool: Pool, now: Date = new Date()): Promise<DigestResult> {
  const tenantIds = await listWorkerTenantIds(pool);
  const processedUserIds = new Set<string>();
  const failures: unknown[] = [];
  let notificationsQueued = 0;

  for (const tenantId of tenantIds) {
    try {
      const tenantResult = await withTenantTransaction(pool, tenantId, async (client) => {
        const query = `
          WITH target_members AS (
            SELECT m.user_id
            FROM memberships m
            JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = $1
              AND m.revoked_at IS NULL
              AND u.disabled_at IS NULL
          ),
          user_tickets AS (
            SELECT
              t.assignee_id,
              jsonb_agg(
                jsonb_build_object(
                  'id', t.id,
                  'number', t.number,
                  'subject', t.subject,
                  'priority', t.priority,
                  'slaDueAt', CASE
                                WHEN t.sla_due_at IS NULL THEN null
                                ELSE to_char(t.sla_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                              END,
                  'slaBreached', t.sla_breached
                ) ORDER BY t.sla_breached DESC, t.sla_due_at ASC NULLS LAST, t.number ASC
              ) AS tickets
            FROM tickets t
            JOIN target_members tm ON tm.user_id = t.assignee_id
            WHERE t.tenant_id = $1
              AND t.status IN ('open', 'pending')
            GROUP BY t.assignee_id
          ),
          queued AS (
          INSERT INTO notification_outbox (tenant_id, user_id, kind, payload)
          SELECT
            $1,
            ut.assignee_id,
            'daily_digest',
            jsonb_build_object(
              'generatedAt', $2::text,
              'tickets', ut.tickets
            )
          FROM user_tickets ut
          RETURNING user_id
          )
          SELECT
            coalesce((SELECT array_agg(user_id) FROM target_members), '{}'::uuid[]) AS eligible_user_ids,
            (SELECT count(*) FROM queued)::int AS queued_count;
        `;
        const result = await client.query<{ eligible_user_ids: string[]; queued_count: number }>(query, [
          tenantId,
          now.toISOString()
        ]);
        const row = result.rows[0];
        return { userIds: row?.eligible_user_ids ?? [], queued: row?.queued_count ?? 0 };
      });
      tenantResult.userIds.forEach((userId) => processedUserIds.add(userId));
      notificationsQueued += tenantResult.queued;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Digest failed for ${failures.length} tenant(s)`);
  }
  // Preserve the original meaning: distinct enabled users with at least one
  // active membership - whether or not they had anything to digest - even though
  // each workspace is now processed separately.
  return { usersProcessed: processedUserIds.size, notificationsQueued };
}

import type { Queryable } from "@ticketry/db";

import { NotFoundError } from "../lib/errors.js";

export interface OutboxMessage {
  id: string;
  tenantId: string;
  userId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  sentAt: Date | null;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: Date;
  sent_at: Date | null;
}

export async function enqueueNotification(
  db: Queryable,
  input: { tenantId: string; userId: string; kind: string; payload: Record<string, unknown> }
): Promise<void> {
  const result = await db.query(
    `INSERT INTO notification_outbox (tenant_id, user_id, kind, payload)
     SELECT m.tenant_id, m.user_id, $3, $4
     FROM memberships m
     WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
    [input.tenantId, input.userId, input.kind, JSON.stringify(input.payload)]
  );
  if (result.rowCount === 0) {
    throw new NotFoundError("membership", `${input.tenantId}:${input.userId}`);
  }
}

export async function listPendingNotifications(db: Queryable, tenantId: string): Promise<OutboxMessage[]> {
  const result = await db.query<OutboxRow>(
    `SELECT id, tenant_id, user_id, kind, payload, created_at, sent_at
     FROM notification_outbox WHERE tenant_id = $1 AND sent_at IS NULL
     ORDER BY created_at, id`,
    [tenantId]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    tenantId: row.tenant_id,
    userId: row.user_id,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.created_at,
    sentAt: row.sent_at
  }));
}

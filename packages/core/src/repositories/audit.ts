import type { Queryable } from "@ticketry/db";

import type { AuditEntry, Page } from "../domain/types.js";
import { AUDIT_COLUMNS, auditFromRow } from "./rows.js";
import type { AuditRow } from "./rows.js";

export interface AuditInput {
  tenantId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(db: Queryable, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.tenantId,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function listAudit(db: Queryable, tenantId: string, page: Page): Promise<AuditEntry[]> {
  const result = await db.query<AuditRow>(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log
     WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, page.limit, page.offset]
  );
  return result.rows.map(auditFromRow);
}

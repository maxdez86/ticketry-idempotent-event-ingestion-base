import type { Pool, Queryable } from "@ticketry/db";
import { withTenantTransaction } from "@ticketry/db";

import type { ExportJob, Page } from "../domain/types.js";
import { toCsv } from "../lib/csv.js";
import { NotFoundError } from "../lib/errors.js";
import { listWorkerTenantIds } from "./bootstrap.js";
import { recordAudit } from "./audit.js";
import { EXPORT_JOB_COLUMNS, exportJobFromRow } from "./rows.js";
import type { ExportJobRow } from "./rows.js";
import { listTickets } from "./tickets.js";
import { findSavedView } from "./views.js";

export const EXPORT_PAGE_SIZE = 500;

export async function enqueueExport(
  db: Queryable,
  tenantId: string,
  requestedBy: string,
  viewId: string | null
): Promise<ExportJob> {
  if (viewId) {
    const view = await findSavedView(db, tenantId, viewId);
    if (!view) {
      throw new NotFoundError("view", viewId);
    }
  }
  const result = await db.query<ExportJobRow>(
    `INSERT INTO export_jobs (tenant_id, requested_by, view_id)
     VALUES ($1, $2, $3)
     RETURNING ${EXPORT_JOB_COLUMNS}`,
    [tenantId, requestedBy, viewId]
  );
  return exportJobFromRow(result.rows[0] as ExportJobRow);
}

export async function getExportJob(db: Queryable, tenantId: string, jobId: string): Promise<ExportJob> {
  const result = await db.query<ExportJobRow>(
    `SELECT ${EXPORT_JOB_COLUMNS} FROM export_jobs WHERE tenant_id = $1 AND id = $2`,
    [tenantId, jobId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("export", jobId);
  }
  return exportJobFromRow(row);
}

export async function listExportJobs(db: Queryable, tenantId: string, page: Page): Promise<ExportJob[]> {
  const result = await db.query<ExportJobRow>(
    `SELECT ${EXPORT_JOB_COLUMNS} FROM export_jobs
     WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, page.limit, page.offset]
  );
  return result.rows.map(exportJobFromRow);
}

/**
 * Claim the oldest queued job in one tenant, build its CSV, and mark it done or failed.
 * Returns null when the queue is empty. Two workers never process the same
 * job: the claim uses SKIP LOCKED under a row lock.
 */

export async function peekOldestQueuedExport(pool: Pool, tenantId: string): Promise<{ id: string; createdAt: number } | null> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const res = await client.query<{ id: string; created_at: Date }>(
      // Skip rows another worker holds: a locked head must not hide the rest of its workspace's
      // queue, and it must never become a candidate the caller would spin on.
      `SELECT id, created_at FROM export_jobs WHERE tenant_id = $1 AND status = 'queued'
       ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [tenantId]
    );
    const row = res.rows[0];
    return row ? { id: row.id, createdAt: row.created_at.getTime() } : null;
  });
}

export async function processNextTenantExport(
  pool: Pool,
  tenantId: string,
  now: Date = new Date(),
  jobId?: string
): Promise<ExportJob | null> {
  const claimed = await withTenantTransaction(pool, tenantId, async (client) => {
    const query = jobId
      ? `UPDATE export_jobs SET status = 'running', started_at = $1
         WHERE id = (
           SELECT id FROM export_jobs WHERE tenant_id = $2 AND status = 'queued' AND id = $3
           FOR UPDATE SKIP LOCKED
         )
           AND tenant_id = $2
         RETURNING ${EXPORT_JOB_COLUMNS}`
      : `UPDATE export_jobs SET status = 'running', started_at = $1
         WHERE id = (
           SELECT id FROM export_jobs WHERE tenant_id = $2 AND status = 'queued'
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
         )
           AND tenant_id = $2
         RETURNING ${EXPORT_JOB_COLUMNS}`;
    const params = jobId ? [now, tenantId, jobId] : [now, tenantId];
    const result = await client.query<ExportJobRow>(query, params);
    const row = result.rows[0];
    return row ? exportJobFromRow(row) : null;
  });
  if (!claimed) {
    return null;
  }

  try {
    const { csv, rowCount } = await withTenantTransaction(pool, claimed.tenantId, async (client) => {
      let filters = {};
      if (claimed.viewId) {
        const view = await findSavedView(client, claimed.tenantId, claimed.viewId);
        if (!view) {
          throw new NotFoundError("view", claimed.viewId);
        }
        filters = view.filters;
      }
      const rows: (string | number | boolean | Date | null)[][] = [];
      for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
        const batch = await listTickets(client, claimed.tenantId, filters, {
          limit: EXPORT_PAGE_SIZE,
          offset
        });
        for (const ticket of batch) {
          rows.push([
            ticket.number,
            ticket.subject,
            ticket.status,
            ticket.priority,
            ticket.assigneeId,
            ticket.slaDueAt,
            ticket.slaBreached,
            ticket.createdAt
          ]);
        }
        if (batch.length < EXPORT_PAGE_SIZE) {
          break;
        }
      }
      return {
        csv: toCsv(
          ["number", "subject", "status", "priority", "assignee_id", "sla_due_at", "sla_breached", "created_at"],
          rows
        ),
        rowCount: rows.length
      };
    });
    return withTenantTransaction(pool, claimed.tenantId, async (client) => {
      const result = await client.query<ExportJobRow>(
        `UPDATE export_jobs SET status = 'done', csv = $2, row_count = $3, finished_at = $4
         WHERE id = $1 AND tenant_id = $5 RETURNING ${EXPORT_JOB_COLUMNS}`,
        [claimed.id, csv, rowCount, now, claimed.tenantId]
      );
      await recordAudit(client, {
        tenantId: claimed.tenantId,
        actorId: null,
        action: "export.completed",
        targetType: "export",
        targetId: claimed.id,
        metadata: { rowCount }
      });
      return exportJobFromRow(result.rows[0] as ExportJobRow);
    });
  } catch (error) {
    return withTenantTransaction(pool, claimed.tenantId, async (client) => {
      const result = await client.query<ExportJobRow>(
        `UPDATE export_jobs SET status = 'failed', error = $2, finished_at = $3
         WHERE id = $1 AND tenant_id = $4 RETURNING ${EXPORT_JOB_COLUMNS}`,
        [claimed.id, error instanceof Error ? error.message : String(error), now, claimed.tenantId]
      );
      await recordAudit(client, {
        tenantId: claimed.tenantId,
        actorId: null,
        action: "export.failed",
        targetType: "export",
        targetId: claimed.id
      });
      return exportJobFromRow(result.rows[0] as ExportJobRow);
    });
  }
}

/**
 * Compatibility entry point: find the next job through controlled tenant
 * enumeration, while keeping every business-table query tenant-local.
 */
export async function processNextExport(pool: Pool, now: Date = new Date()): Promise<ExportJob | null> {
  const tenantIds = await listWorkerTenantIds(pool);
  const candidates: { tenantId: string; id: string; createdAt: number }[] = [];

  for (const tenantId of tenantIds) {
    const oldest = await peekOldestQueuedExport(pool, tenantId);
    if (oldest) {
      candidates.push({ tenantId, ...oldest });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  for (const candidate of candidates) {
    const job = await processNextTenantExport(pool, candidate.tenantId, now, candidate.id);
    if (job) return job;
  }
  return null;
}

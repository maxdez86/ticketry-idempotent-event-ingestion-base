import { listWorkerTenantIds, processNextTenantExport, peekOldestQueuedExport } from "@ticketry/core";
import type { ExportJob } from "@ticketry/core";
import type { Pool } from "@ticketry/db";

export interface ExportRunResult {
  processed: ExportJob[];
}

/** Drain the export queue, at most `maxJobs` at a time. */
export async function runExports(pool: Pool, maxJobs = 20, now: Date = new Date()): Promise<ExportRunResult> {
  const processed: ExportJob[] = [];
  const tenantIds = await listWorkerTenantIds(pool);
  const failures: unknown[] = [];
  const skippedTenants = new Set<string>();
  let stalls = 0;

  while (processed.length < maxJobs) {
    const candidates: { tenantId: string; id: string; createdAt: number }[] = [];

    for (const tenantId of tenantIds) {
      if (skippedTenants.has(tenantId)) continue;
      try {
        const oldest = await peekOldestQueuedExport(pool, tenantId);
        if (oldest) {
          candidates.push({ tenantId, ...oldest });
        }
      } catch (error) {
        failures.push(error);
        skippedTenants.add(tenantId);
      }
    }

    if (candidates.length === 0) {
      break;
    }

    candidates.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });

    let claimed = false;
    for (const candidate of candidates) {
      try {
        const job = await processNextTenantExport(pool, candidate.tenantId, now, candidate.id);
        if (job) {
          processed.push(job);
          claimed = true;
          break;
        }
      } catch (error) {
        failures.push(error);
        skippedTenants.add(candidate.tenantId);
      }
    }

    if (!claimed) {
      // Every candidate was taken by a concurrent worker or failed. Sniped jobs are no longer
      // queued and failing workspaces are skipped from now on, so a re-scan makes progress; a
      // run that still claims nothing after a few re-scans stops instead of spinning.
      stalls += 1;
      if (stalls >= 3) {
        break;
      }
    } else {
      stalls = 0;
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Export processing failed for ${failures.length} tenant(s)`);
  }
  return { processed };
}

import type { Pool } from "@ticketry/db";
import { withTenantTransaction } from "@ticketry/db";

import { providerEventSchema } from "../domain/lifecycle-events.js";
import { deriveStatusChange } from "../domain/transitions.js";
import type { TicketPriority, TicketStatus } from "../domain/types.js";
import { slaDueAt } from "../domain/sla.js";
import type { ProviderEvent } from "../domain/lifecycle-events.js";
import { recordAudit } from "../repositories/audit.js";
import { listWorkerTenantIds, resolveStaffTenant } from "../repositories/bootstrap.js";

export interface LifecycleIngestionResult {
  processed: string[];
}

interface TicketState {
  id: string;
  number: number;
  status: TicketStatus;
  priority: TicketPriority;
  created_at: Date;
  sla_due_at: Date | null;
  sla_breached: boolean;
}

async function applyEvent(pool: Pool, tenantId: string, event: ProviderEvent, now: Date): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    const ticket = await client.query<{ id: string; number: number }>(
      "SELECT id, number FROM tickets WHERE tenant_id = $1 AND id = $2",
      [tenantId, event.ticket_id]
    );
    if (!ticket.rows[0]) {
      throw new Error(`ticket ${event.ticket_id} not found`);
    }

    const payload = JSON.stringify(event.event);
    const recorded = await client.query<{ id: string }>(
      `SELECT id FROM lifecycle_events
       WHERE tenant_id = $1 AND ticket_id = $2 AND kind = $3
         AND occurred_at = $4 AND payload = $5::jsonb
       LIMIT 1`,
      [tenantId, event.ticket_id, event.event.kind, event.occurred_at, payload]
    );
    if (recorded.rows[0]) {
      return;
    }

    await client.query(
      `INSERT INTO lifecycle_events
       (tenant_id, ticket_id, event_id, ticket_sequence, kind, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [tenantId, event.ticket_id, event.event_id, event.ticket_sequence, event.event.kind, payload, event.occurred_at]
    );
    await recordAudit(client, {
      tenantId,
      actorId: null,
      action: "ticket.lifecycle_applied",
      targetType: "ticket",
      targetId: event.ticket_id,
      metadata: { number: ticket.rows[0].number, eventId: event.event_id, ticketSequence: event.ticket_sequence }
    });
  });

  await withTenantTransaction(pool, tenantId, async (client) => {
    const current = await client.query<TicketState>(
      `SELECT id, number, status, priority, created_at, sla_due_at, sla_breached
       FROM tickets WHERE tenant_id = $1 AND id = $2`,
      [tenantId, event.ticket_id]
    );
    const ticket = current.rows[0];
    if (!ticket) {
      throw new Error(`ticket ${event.ticket_id} not found`);
    }

    let status = ticket.status;
    let priority = ticket.priority;
    let dueAt = ticket.sla_due_at;
    let breached = ticket.sla_breached;
    if (event.event.kind === "status_changed") {
      status = event.event.target_status;
      const derived = deriveStatusChange(
        { status: ticket.status, priority: ticket.priority, createdAt: ticket.created_at, slaDueAt: ticket.sla_due_at, slaBreached: ticket.sla_breached },
        status,
        priority,
        now
      );
      dueAt = derived.slaDueAt;
      breached = derived.slaBreached;
    } else {
      priority = event.event.target_priority;
      dueAt = slaDueAt(priority, ticket.created_at);
    }
    await client.query(
      `UPDATE tickets SET status = $3, priority = $4, sla_due_at = $5, sla_breached = $6, updated_at = $7
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, event.ticket_id, status, priority, dueAt, breached, now]
    );
  });
}

export async function runLifecycleIngestion(
  pool: Pool,
  feed: Iterable<ProviderEvent> | AsyncIterable<ProviderEvent>,
  now: Date = new Date()
): Promise<LifecycleIngestionResult> {
  const tenantIds = new Set(await listWorkerTenantIds(pool));
  const failures: unknown[] = [];
  const processed: string[] = [];
  for await (const input of feed) {
    const parsed = providerEventSchema.safeParse(input);
    if (!parsed.success) {
      failures.push(new Error("invalid provider lifecycle event"));
      continue;
    }
    const event = parsed.data;
    const tenant = await resolveStaffTenant(pool, event.workspace_slug);
    if (!tenant || !tenantIds.has(tenant.tenantId)) {
      failures.push(new Error(`workspace ${event.workspace_slug} not found`));
      continue;
    }
    try {
      await applyEvent(pool, tenant.tenantId, event, now);
      processed.push(event.event_id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `lifecycle ingestion failed for ${failures.length} event(s)`);
  }
  return { processed };
}

import type { Queryable } from "@ticketry/db";

import { slaDueAt } from "../domain/sla.js";
import type { Page, Ticket, TicketFilters, TicketPriority, TicketStatus } from "../domain/types.js";
import { NotFoundError } from "../lib/errors.js";
import { assertTransition, deriveStatusChange } from "../domain/transitions.js";
import { recordAudit } from "./audit.js";
import { TICKET_COLUMNS, ticketColumns, ticketFromRow } from "./rows.js";
import type { TicketRow } from "./rows.js";

export interface CreateTicketInput {
  subject: string;
  body: string;
  priority: TicketPriority;
  requesterId: string;
  assigneeId: string | null;
  now?: Date;
}

export interface UpdateTicketInput {
  subject?: string;
  body?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  now?: Date;
}

export async function createTicket(
  db: Queryable,
  tenantId: string,
  actorId: string,
  input: CreateTicketInput
): Promise<Ticket> {
  const now = input.now ?? new Date();
  const counter = await db.query<{ number: number }>(
    `INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 2)
     ON CONFLICT (tenant_id) DO UPDATE SET next_number = ticket_counters.next_number + 1
     RETURNING next_number - 1 AS number`,
    [tenantId]
  );
  const number = counter.rows[0]?.number;
  if (number === undefined) {
    throw new Error("ticket counter did not return a number");
  }
  const inserted = await db.query<TicketRow>(
    `INSERT INTO tickets (tenant_id, number, subject, body, priority, requester_id, assignee_id,
                          sla_due_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING ${TICKET_COLUMNS}`,
    [
      tenantId,
      number,
      input.subject,
      input.body,
      input.priority,
      input.requesterId,
      input.assigneeId,
      slaDueAt(input.priority, now),
      now
    ]
  );
  const ticket = ticketFromRow(inserted.rows[0] as TicketRow);
  await recordAudit(db, {
    tenantId,
    actorId,
    action: "ticket.created",
    targetType: "ticket",
    targetId: ticket.id,
    metadata: { number: ticket.number }
  });
  return ticket;
}

export async function findTicket(db: Queryable, tenantId: string, ticketId: string): Promise<Ticket | null> {
  const result = await db.query<TicketRow>(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE tenant_id = $1 AND id = $2`,
    [tenantId, ticketId]
  );
  const row = result.rows[0];
  return row ? ticketFromRow(row) : null;
}

export async function getTicket(db: Queryable, tenantId: string, ticketId: string): Promise<Ticket> {
  const ticket = await findTicket(db, tenantId, ticketId);
  if (!ticket) {
    throw new NotFoundError("ticket", ticketId);
  }
  return ticket;
}

function buildFilterClauses(filters: TicketFilters, params: unknown[]): string[] {
  const clauses: string[] = [];
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`t.status = $${params.length}`);
  }
  if (filters.priority) {
    params.push(filters.priority);
    clauses.push(`t.priority = $${params.length}`);
  }
  if (filters.assigneeId) {
    params.push(filters.assigneeId);
    clauses.push(`t.assignee_id = $${params.length}`);
  }
  if (filters.slaBreached !== undefined) {
    params.push(filters.slaBreached);
    clauses.push(`t.sla_breached = $${params.length}`);
  }
  if (filters.tag) {
    params.push(filters.tag);
    clauses.push(
      `EXISTS (SELECT 1 FROM ticket_tags tt
               JOIN tags g ON g.id = tt.tag_id AND g.tenant_id = t.tenant_id
               WHERE tt.ticket_id = t.id AND g.name = $${params.length})`
    );
  }
  return clauses;
}

export async function listTickets(
  db: Queryable,
  tenantId: string,
  filters: TicketFilters,
  page: Page
): Promise<Ticket[]> {
  const params: unknown[] = [tenantId];
  const clauses = ["t.tenant_id = $1", ...buildFilterClauses(filters, params)];
  params.push(page.limit, page.offset);
  const result = await db.query<TicketRow>(
    `SELECT ${ticketColumns("t")} FROM tickets t
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.created_at DESC, t.number DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows.map(ticketFromRow);
}

export async function updateTicket(
  db: Queryable,
  tenantId: string,
  actorId: string,
  ticketId: string,
  input: UpdateTicketInput
): Promise<Ticket> {
  const now = input.now ?? new Date();
  const current = await getTicket(db, tenantId, ticketId);
  const next = {
    subject: input.subject ?? current.subject,
    body: input.body ?? current.body,
    status: input.status ?? current.status,
    priority: input.priority ?? current.priority,
    assigneeId: input.assigneeId === undefined ? current.assigneeId : input.assigneeId
  };
  assertTransition(current.status, next.status);
  const derived =
    next.status !== current.status
      ? deriveStatusChange(current, next.status, next.priority, now)
      : {
          slaDueAt: next.priority === current.priority ? current.slaDueAt : slaDueAt(next.priority, current.createdAt),
          slaBreached: current.slaBreached
        };
  const updated = await db.query<TicketRow>(
    `UPDATE tickets
     SET subject = $3, body = $4, status = $5, priority = $6, assignee_id = $7,
         sla_due_at = $8, updated_at = $9
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${TICKET_COLUMNS}`,
    [
      tenantId,
      ticketId,
      next.subject,
      next.body,
      next.status,
      next.priority,
      next.assigneeId,
      derived.slaDueAt,
      now
    ]
  );
  const ticket = ticketFromRow(updated.rows[0] as TicketRow);
  const changed = Object.entries(input)
    .filter(([key, value]) => key !== "now" && value !== undefined)
    .map(([key]) => key);
  await recordAudit(db, {
    tenantId,
    actorId,
    action: "ticket.updated",
    targetType: "ticket",
    targetId: ticket.id,
    metadata: { number: ticket.number, changed }
  });
  return ticket;
}

export async function countTickets(db: Queryable, tenantId: string, filters: TicketFilters): Promise<number> {
  const params: unknown[] = [tenantId];
  const clauses = ["t.tenant_id = $1", ...buildFilterClauses(filters, params)];
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tickets t WHERE ${clauses.join(" AND ")}`,
    params
  );
  return Number(result.rows[0]?.count ?? 0);
}

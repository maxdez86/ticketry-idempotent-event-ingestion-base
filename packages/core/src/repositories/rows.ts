import type {
  AuditEntry,
  Comment,
  ExportJob,
  SavedView,
  Tag,
  Ticket,
  TicketPriority,
  TicketStatus
} from "../domain/types.js";
import { parseTicketFilters } from "../domain/filters.js";

export interface TicketRow {
  id: string;
  tenant_id: string;
  number: number;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  requester_id: string;
  assignee_id: string | null;
  sla_due_at: Date | null;
  sla_breached: boolean;
  created_at: Date;
  updated_at: Date;
}

const TICKET_COLUMN_NAMES = [
  "id",
  "tenant_id",
  "number",
  "subject",
  "body",
  "status",
  "priority",
  "requester_id",
  "assignee_id",
  "sla_due_at",
  "sla_breached",
  "created_at",
  "updated_at"
] as const;

/** Column list for `SELECT`, optionally qualified with a table alias. */
export function ticketColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return TICKET_COLUMN_NAMES.map((column) => `${prefix}${column}`).join(", ");
}

export const TICKET_COLUMNS = ticketColumns();

export function ticketFromRow(row: TicketRow): Ticket {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    number: row.number,
    subject: row.subject,
    body: row.body,
    status: row.status,
    priority: row.priority,
    requesterId: row.requester_id,
    assigneeId: row.assignee_id,
    slaDueAt: row.sla_due_at,
    slaBreached: row.sla_breached,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface CommentRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  author_id: string;
  body: string;
  is_internal: boolean;
  created_at: Date;
}

export const COMMENT_COLUMNS = "id, tenant_id, ticket_id, author_id, body, is_internal, created_at";

export function commentFromRow(row: CommentRow): Comment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    authorId: row.author_id,
    body: row.body,
    isInternal: row.is_internal,
    createdAt: row.created_at
  };
}

export interface TagRow {
  id: string;
  tenant_id: string;
  name: string;
}

export function tagFromRow(row: TagRow): Tag {
  return { id: row.id, tenantId: row.tenant_id, name: row.name };
}

export interface SavedViewRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  name: string;
  filters: unknown;
  created_at: Date;
}

export const SAVED_VIEW_COLUMNS = "id, tenant_id, owner_id, name, filters, created_at";

export function savedViewFromRow(row: SavedViewRow): SavedView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    name: row.name,
    filters: parseTicketFilters(row.filters),
    createdAt: row.created_at
  };
}

export interface ExportJobRow {
  id: string;
  tenant_id: string;
  requested_by: string;
  view_id: string | null;
  status: ExportJob["status"];
  row_count: number | null;
  csv: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export const EXPORT_JOB_COLUMNS = `
  id, tenant_id, requested_by, view_id, status, row_count, csv, error, created_at, started_at, finished_at
`;

export function exportJobFromRow(row: ExportJobRow): ExportJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestedBy: row.requested_by,
    viewId: row.view_id,
    status: row.status,
    rowCount: row.row_count,
    csv: row.csv,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export interface AuditRow {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export const AUDIT_COLUMNS = "id, tenant_id, actor_id, action, target_type, target_id, metadata, created_at";

export function auditFromRow(row: AuditRow): AuditEntry {
  return {
    id: String(row.id),
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata,
    createdAt: row.created_at
  };
}

export const TICKET_STATUSES = ["open", "pending", "solved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const MEMBERSHIP_ROLES = ["owner", "agent", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** Statuses in which the SLA clock is still running. */
export const ACTIVE_STATUSES: readonly TicketStatus[] = ["open", "pending"];

export interface Ticket {
  id: string;
  tenantId: string;
  number: number;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterId: string;
  assigneeId: string | null;
  slaDueAt: Date | null;
  slaBreached: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Comment {
  id: string;
  tenantId: string;
  ticketId: string;
  authorId: string;
  body: string;
  isInternal: boolean;
  createdAt: Date;
}

export interface Tag {
  id: string;
  tenantId: string;
  name: string;
}

export interface SavedView {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  filters: TicketFilters;
  createdAt: Date;
}

export interface ExportJob {
  id: string;
  tenantId: string;
  requestedBy: string;
  viewId: string | null;
  status: "queued" | "running" | "done" | "failed";
  rowCount: number | null;
  csv: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface AuditEntry {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  isStaff: boolean;
  disabledAt: Date | null;
}

export interface Membership {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  role: MembershipRole;
  revokedAt: Date | null;
}

export interface TicketFilters {
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string;
  tag?: string;
  slaBreached?: boolean;
}

export interface Page {
  limit: number;
  offset: number;
}

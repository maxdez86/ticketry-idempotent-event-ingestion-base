export * from "./domain/types.js";
export { SLA_HOURS, isBreached, isSlaRunning, slaDueAt } from "./domain/sla.js";
export { InvalidFiltersError, parseTicketFilters } from "./domain/filters.js";
export { toCsv } from "./lib/csv.js";
export type { CsvCell } from "./lib/csv.js";
export { ConflictError, NotFoundError, ValidationError } from "./lib/errors.js";
export { InvalidTransitionError } from "./lib/errors.js";
export { generateApiKey, hashApiKey, looksLikeApiKey } from "./lib/api-keys.js";
export { providerEventSchema } from "./domain/lifecycle-events.js";
export type { LifecycleEvent, ProviderEvent } from "./domain/lifecycle-events.js";
export { assertTransition, canTransition, deriveStatusChange } from "./domain/transitions.js";
export type { DerivedStatusState } from "./domain/transitions.js";
export { runLifecycleIngestion } from "./services/lifecycle-ingestion.js";
export type { LifecycleIngestionResult } from "./services/lifecycle-ingestion.js";

export { authenticateApiKey, listWorkerTenantIds, resolveStaffTenant } from "./repositories/bootstrap.js";
export type { AuthenticatedApiKey, SelfMembership, StaffTenant } from "./repositories/bootstrap.js";

export { listAudit, recordAudit } from "./repositories/audit.js";
export type { AuditInput } from "./repositories/audit.js";
export {
  countTickets,
  createTicket,
  findTicket,
  getTicket,
  listTickets,
  updateTicket
} from "./repositories/tickets.js";
export type { CreateTicketInput, UpdateTicketInput } from "./repositories/tickets.js";
export { createComment, listComments } from "./repositories/comments.js";
export type { CreateCommentInput } from "./repositories/comments.js";
export { listTags, listTicketTags, tagTicket, untagTicket } from "./repositories/tags.js";
export type { TagCount } from "./repositories/tags.js";
export {
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews
} from "./repositories/views.js";
export {
  EXPORT_PAGE_SIZE,
  enqueueExport,
  getExportJob,
  listExportJobs,
  processNextExport,
  processNextTenantExport,
  peekOldestQueuedExport
} from "./repositories/exports.js";
export {
  findMembership,
  getTenantMember,
  listActiveMemberUserIds,
  listMemberships,
  listTenantMembers
} from "./repositories/users.js";
export type { TenantMember } from "./repositories/users.js";
export { searchTickets } from "./repositories/search.js";
export type { SearchHit } from "./repositories/search.js";
export { enqueueNotification, listPendingNotifications } from "./repositories/outbox.js";
export type { OutboxMessage } from "./repositories/outbox.js";

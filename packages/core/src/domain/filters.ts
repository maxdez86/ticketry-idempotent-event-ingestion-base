import type { TicketFilters } from "./types.js";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class InvalidFiltersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFiltersError";
  }
}

/**
 * Validate a loosely typed filter object (query string or stored JSON) into
 * the filters the ticket repository understands. Unknown keys are rejected so
 * a typo never silently widens a saved view.
 */
export function parseTicketFilters(input: unknown): TicketFilters {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidFiltersError("filters must be an object");
  }
  const raw = input as Record<string, unknown>;
  const filters: TicketFilters = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    switch (key) {
      case "status":
        if (typeof value !== "string" || !(TICKET_STATUSES as readonly string[]).includes(value)) {
          throw new InvalidFiltersError(`status must be one of ${TICKET_STATUSES.join(", ")}`);
        }
        filters.status = value as TicketFilters["status"];
        break;
      case "priority":
        if (typeof value !== "string" || !(TICKET_PRIORITIES as readonly string[]).includes(value)) {
          throw new InvalidFiltersError(`priority must be one of ${TICKET_PRIORITIES.join(", ")}`);
        }
        filters.priority = value as TicketFilters["priority"];
        break;
      case "assigneeId":
        if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
          throw new InvalidFiltersError("assigneeId must be a UUID");
        }
        filters.assigneeId = value;
        break;
      case "tag":
        if (typeof value !== "string" || !TAG_PATTERN.test(value)) {
          throw new InvalidFiltersError("tag must be a lowercase slug");
        }
        filters.tag = value;
        break;
      case "slaBreached":
        if (value === true || value === "true") {
          filters.slaBreached = true;
        } else if (value === false || value === "false") {
          filters.slaBreached = false;
        } else {
          throw new InvalidFiltersError("slaBreached must be true or false");
        }
        break;
      default:
        throw new InvalidFiltersError(`unknown filter: ${key}`);
    }
  }
  return filters;
}

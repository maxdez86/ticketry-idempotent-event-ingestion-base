import type { TicketPriority, TicketStatus } from "./types.js";
import { ACTIVE_STATUSES } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;

/** First-response target per priority, in hours. */
export const SLA_HOURS: Record<TicketPriority, number> = {
  urgent: 4,
  high: 8,
  normal: 24,
  low: 72
};

export function slaDueAt(priority: TicketPriority, createdAt: Date): Date {
  return new Date(createdAt.getTime() + SLA_HOURS[priority] * HOUR_MS);
}

/** The SLA clock only runs while a ticket is open or pending. */
export function isSlaRunning(status: TicketStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isBreached(input: {
  status: TicketStatus;
  slaDueAt: Date | null;
  now: Date;
}): boolean {
  if (!input.slaDueAt || !isSlaRunning(input.status)) {
    return false;
  }
  return input.slaDueAt.getTime() < input.now.getTime();
}

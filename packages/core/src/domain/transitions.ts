import { isBreached, isSlaRunning, slaDueAt } from "./sla.js";
import { ACTIVE_STATUSES } from "./types.js";
import type { Ticket, TicketPriority, TicketStatus } from "./types.js";
import { InvalidTransitionError } from "../lib/errors.js";

const LEGAL_MOVES: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["open", "pending", "solved"],
  pending: ["open", "pending", "solved"],
  solved: ["solved", "closed"],
  closed: ["closed"]
};

export function canTransition(current: TicketStatus, next: TicketStatus): boolean {
  return LEGAL_MOVES[current].includes(next);
}

export function assertTransition(current: TicketStatus, next: TicketStatus): void {
  if (!canTransition(current, next)) {
    throw new InvalidTransitionError(current, next);
  }
}

export interface DerivedStatusState {
  slaDueAt: Date | null;
  slaBreached: boolean;
}

export function deriveStatusChange(
  current: Pick<Ticket, "status" | "priority" | "createdAt" | "slaDueAt" | "slaBreached">,
  nextStatus: TicketStatus,
  nextPriority: TicketPriority,
  now: Date
): DerivedStatusState {
  if (nextStatus === current.status) {
    return { slaDueAt: current.slaDueAt, slaBreached: current.slaBreached };
  }
  if (!isSlaRunning(nextStatus) || !ACTIVE_STATUSES.includes(nextStatus)) {
    return { slaDueAt: null, slaBreached: false };
  }
  const nextDueAt = slaDueAt(nextPriority, current.createdAt);
  return { slaDueAt: nextDueAt, slaBreached: isBreached({ status: nextStatus, slaDueAt: nextDueAt, now }) };
}


import { z } from "zod";

import { TICKET_PRIORITIES, TICKET_STATUSES } from "./types.js";

const statusChangedSchema = z.object({
  kind: z.literal("status_changed"),
  target_status: z.enum(TICKET_STATUSES)
});

const priorityChangedSchema = z.object({
  kind: z.literal("priority_changed"),
  target_priority: z.enum(TICKET_PRIORITIES)
});

const lifecycleEventSchema = z.discriminatedUnion("kind", [statusChangedSchema, priorityChangedSchema]);

export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export interface ProviderEvent {
  /** Globally unique per provider event; establishes identity, not order. */
  event_id: string;
  /** Per ticket, starts at 1, is contiguous, increases by exactly 1 for every provider lifecycle event concerning that ticket, and is unique within that ticket. It is the ordering authority; event_id and occurred_at are not ordering authorities. */
  ticket_sequence: number;
  /** Provider-facing workspace slug used for routing. */
  workspace_slug: string;
  ticket_id: string;
  occurred_at: Date;
  event: LifecycleEvent;
}

export const providerEventSchema = z.object({
  event_id: z.string(),
  ticket_sequence: z.number().int().positive(),
  workspace_slug: z.string(),
  ticket_id: z.string(),
  occurred_at: z.coerce.date(),
  event: lifecycleEventSchema
});


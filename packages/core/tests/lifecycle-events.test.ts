import { describe, expect, it } from "vitest";

import { providerEventSchema } from "../src/index.js";

describe("provider lifecycle events", () => {
  it("accepts the two supported event kinds", () => {
    expect(providerEventSchema.safeParse({
      event_id: "evt-status",
      ticket_sequence: 1,
      workspace_slug: "acme",
      ticket_id: "ticket-1",
      occurred_at: "2026-09-01T00:00:00Z",
      event: { kind: "status_changed", target_status: "pending" }
    }).success).toBe(true);
    expect(providerEventSchema.safeParse({
      event_id: "evt-priority",
      ticket_sequence: 2,
      workspace_slug: "acme",
      ticket_id: "ticket-1",
      occurred_at: new Date(),
      event: { kind: "priority_changed", target_priority: "urgent" }
    }).success).toBe(true);
  });

  it("rejects malformed and unknown events", () => {
    expect(providerEventSchema.safeParse({ event_id: "bad", ticket_sequence: 0, event: { kind: "assigned" } }).success).toBe(false);
  });
});


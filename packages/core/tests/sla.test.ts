import { describe, expect, it } from "vitest";

import { SLA_HOURS, isBreached, isSlaRunning, slaDueAt } from "../src/index.js";

describe("SLA rules", () => {
  const createdAt = new Date("2026-03-01T10:00:00Z");

  it("derives the due time from priority", () => {
    expect(slaDueAt("urgent", createdAt).toISOString()).toBe("2026-03-01T14:00:00.000Z");
    expect(slaDueAt("high", createdAt).toISOString()).toBe("2026-03-01T18:00:00.000Z");
    expect(slaDueAt("normal", createdAt).toISOString()).toBe("2026-03-02T10:00:00.000Z");
    expect(slaDueAt("low", createdAt).toISOString()).toBe("2026-03-04T10:00:00.000Z");
    expect(Object.keys(SLA_HOURS).sort()).toEqual(["high", "low", "normal", "urgent"]);
  });

  it("only runs the clock for open and pending tickets", () => {
    expect(isSlaRunning("open")).toBe(true);
    expect(isSlaRunning("pending")).toBe(true);
    expect(isSlaRunning("solved")).toBe(false);
    expect(isSlaRunning("closed")).toBe(false);
  });

  it("reports a breach only after the due time on an active ticket", () => {
    const slaDue = new Date("2026-03-01T14:00:00Z");
    expect(isBreached({ status: "open", slaDueAt: slaDue, now: new Date("2026-03-01T13:59:59Z") })).toBe(false);
    expect(isBreached({ status: "open", slaDueAt: slaDue, now: new Date("2026-03-01T14:00:00Z") })).toBe(false);
    expect(isBreached({ status: "open", slaDueAt: slaDue, now: new Date("2026-03-01T14:00:01Z") })).toBe(true);
    expect(isBreached({ status: "solved", slaDueAt: slaDue, now: new Date("2026-03-02T00:00:00Z") })).toBe(false);
    expect(isBreached({ status: "open", slaDueAt: null, now: new Date("2026-03-02T00:00:00Z") })).toBe(false);
  });
});

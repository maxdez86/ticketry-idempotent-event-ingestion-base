import { describe, expect, it } from "vitest";

import { InvalidFiltersError, parseTicketFilters } from "../src/index.js";

describe("parseTicketFilters", () => {
  it("accepts an empty or absent filter set", () => {
    expect(parseTicketFilters(undefined)).toEqual({});
    expect(parseTicketFilters({})).toEqual({});
    expect(parseTicketFilters({ status: "" })).toEqual({});
  });

  it("keeps known keys and coerces booleans from query strings", () => {
    expect(
      parseTicketFilters({
        status: "open",
        priority: "high",
        assigneeId: "aaaaaaaa-0002-4000-8000-000000000002",
        tag: "billing",
        slaBreached: "true"
      })
    ).toEqual({
      status: "open",
      priority: "high",
      assigneeId: "aaaaaaaa-0002-4000-8000-000000000002",
      tag: "billing",
      slaBreached: true
    });
    expect(parseTicketFilters({ slaBreached: false })).toEqual({ slaBreached: false });
  });

  it("rejects unknown keys and invalid values", () => {
    expect(() => parseTicketFilters({ owner: "me" })).toThrow(InvalidFiltersError);
    expect(() => parseTicketFilters({ status: "archived" })).toThrow(InvalidFiltersError);
    expect(() => parseTicketFilters({ priority: "p0" })).toThrow(InvalidFiltersError);
    expect(() => parseTicketFilters({ assigneeId: "not-a-uuid" })).toThrow(InvalidFiltersError);
    expect(() => parseTicketFilters({ tag: "Billing Team" })).toThrow(InvalidFiltersError);
    expect(() => parseTicketFilters({ slaBreached: "maybe" })).toThrow(InvalidFiltersError);
    expect(() => parseTicketFilters([])).toThrow(InvalidFiltersError);
  });
});

import { describe, expect, it } from "vitest";

import { toCsv } from "../src/index.js";

describe("toCsv", () => {
  it("quotes only cells that need it and uses CRLF", () => {
    const csv = toCsv(
      ["number", "subject", "when"],
      [
        [1, "plain", new Date("2026-03-01T10:00:00Z")],
        [2, 'has "quotes", commas\nand newlines', null]
      ]
    );
    expect(csv).toBe(
      'number,subject,when\r\n1,plain,2026-03-01T10:00:00.000Z\r\n2,"has ""quotes"", commas\nand newlines",\r\n'
    );
  });

  it("rejects rows that do not match the header width", () => {
    expect(() => toCsv(["a", "b"], [[1]])).toThrow(/1 cells, header has 2/);
  });
});

import { describe, expect, it } from "vitest";

import { generateApiKey, hashApiKey, looksLikeApiKey } from "../src/index.js";

describe("API keys", () => {
  it("generates prefixed keys that hash deterministically", () => {
    const key = generateApiKey();
    expect(looksLikeApiKey(key)).toBe(true);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toHaveLength(64);
    expect(generateApiKey()).not.toBe(key);
  });

  it("rejects values that are not keys", () => {
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("Bearer tk_x")).toBe(false);
    expect(looksLikeApiKey("tk_short")).toBe(false);
  });
});

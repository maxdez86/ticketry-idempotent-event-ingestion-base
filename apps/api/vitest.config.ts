import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["../../packages/test-support/src/global-setup.ts"],
    testTimeout: 20000,
    hookTimeout: 30000
  }
});

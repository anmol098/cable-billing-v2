import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // DB suites create and drop a scratch database; the machine may be busy.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

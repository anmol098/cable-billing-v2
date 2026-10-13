import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // DB suites clone a template database per file (see @cb/db/testing); give setup some headroom.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

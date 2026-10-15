import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The runner tests start a local fake server and run short timed scenarios; the machine may be busy.
    testTimeout: 60_000,
  },
});

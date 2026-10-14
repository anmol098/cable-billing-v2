import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // fast-check property tests (allocation, billing, netting) take a second or two when idle but
    // were seen at 6+ s on a busy machine, past Vitest's 5 s default; a pure package has no I/O to
    // hang on, so a generous budget only absorbs CPU contention.
    testTimeout: 60_000,
  },
});

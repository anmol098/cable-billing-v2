import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Component tests (*.test.tsx) opt into jsdom with a `// @vitest-environment jsdom` docblock;
    // the rest run in Node.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/primitives/test-setup.ts"],
    // jsdom renders of composites and overlays exceed Vitest's 5 s default on a busy machine or CI
    // runner; same budget as @cb/core and @cb/db.
    testTimeout: 30_000,
  },
});

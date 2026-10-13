import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Component tests (*.test.tsx) opt into jsdom with a `// @vitest-environment jsdom` docblock;
    // the rest run in Node.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/primitives/test-setup.ts"],
  },
});

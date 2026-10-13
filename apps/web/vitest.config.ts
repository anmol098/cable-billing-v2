import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Unit and component tests only; Playwright specs live in e2e/ and run with `pnpm test:e2e`.
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // jsdom renders of big trees (the /dev/ui showcase, forms) exceed Vitest's 5 s default on a busy
    // machine or CI runner; same budget as @cb/core and @cb/db.
    testTimeout: 30_000,
  },
});

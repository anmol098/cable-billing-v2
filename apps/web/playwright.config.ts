import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the production build (`next start`). Run `pnpm --filter web build`
 * first, then `pnpm --filter web test:e2e`. Set `E2E_BASE_URL` to test a deployed URL instead
 * (CI against a Vercel preview, PLAN §17); the local server is then not started.
 *
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` points Playwright at a pre-installed Chromium when the
 * pinned Playwright version's own browser is not installed (e.g. sandboxed containers).
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const externalBaseUrl = process.env.E2E_BASE_URL;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `pnpm exec next start --port ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});

import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Where the local server writes the emails it would send (`EMAIL_OUTBOX_DIR`, local only), so the
 * sign-up test can read its link (T-027). Set here so the server and the tests agree on it.
 */
if (!externalBaseUrl) {
  process.env.EMAIL_OUTBOX_DIR ??= join(tmpdir(), `cb-e2e-outbox-${PORT}`);
}

/**
 * Razorpay in the e2e suite (T-085): test-mode-shaped fake keys and a local mock of the
 * Subscriptions API (`e2e/support/razorpay-mock.mjs`), so the subscription page's checkout runs
 * end to end without ever calling Razorpay. `RAZORPAY_API_BASE_URL` is refused on Vercel.
 */
const RAZORPAY_MOCK_PORT = Number(process.env.E2E_RAZORPAY_MOCK_PORT ?? PORT + 1000);
if (!externalBaseUrl) {
  process.env.RAZORPAY_KEY_ID ??= "rzp_test_E2eMock0001";
  process.env.RAZORPAY_KEY_SECRET ??= "e2e-key-secret-not-a-real-secret";
  process.env.RAZORPAY_WEBHOOK_SECRET ??= "e2e-webhook-secret-not-a-real-one";
  process.env.RAZORPAY_PLAN_ID ??= "plan_E2eMonthly472";
  process.env.RAZORPAY_API_BASE_URL ??= `http://localhost:${RAZORPAY_MOCK_PORT}/v1`;
  process.env.E2E_RAZORPAY_MOCK_URL ??= `http://localhost:${RAZORPAY_MOCK_PORT}`;
}

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
    : [
        {
          command: `pnpm exec next start --port ${PORT}`,
          env: { ...(process.env as Record<string, string>) },
          url: `http://localhost:${PORT}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: "node e2e/support/razorpay-mock.mjs",
          env: {
            ...(process.env as Record<string, string>),
            RAZORPAY_MOCK_PORT: String(RAZORPAY_MOCK_PORT),
          },
          url: `http://localhost:${RAZORPAY_MOCK_PORT}/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 20_000,
        },
      ],
});

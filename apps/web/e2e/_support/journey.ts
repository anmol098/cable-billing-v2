/**
 * Helpers for the cross-feature journeys (T-088, `journey-*.spec.ts`).
 *
 * - `words(locale)`: the app's own translator over the generated messages (`apps/web/messages`), so
 *   a journey finds buttons and checks sentences in Hindi without copying Hindi into the test.
 * - `runJobs(db)`: the job-worker cron, run here with the real worker (as bills.spec.ts does). The
 *   worker takes any tenant's due job; that is fine, every spec waits for its own result.
 * - `phoneDevice()` / `apiHeaders(ip)`: what the lineman app sends to `/api/mobile/v1`.
 * - `journeyIp(seedId)`: a documentation-range IP per seed. Journeys send it as `x-real-ip` (web
 *   and API), so their sign-ins never use up the per-IP sign-in limit the rest of the suite shares
 *   on one server (100 per 15 minutes, `AUTH_RATE_LIMITS.signInPerIp`).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { billingRunJob, createJobRegistry, runJobWorker, silentLogger } from "@cb/core";
import type { DbClient } from "@cb/db";
import { expect, type Page } from "@playwright/test";
import { createTranslator } from "next-intl";

export type JourneyLocale = "en" | "hi";

type Messages = Record<string, unknown>;

const loaded = new Map<JourneyLocale, Messages>();

function messages(locale: JourneyLocale): Messages {
  let found = loaded.get(locale);
  if (!found) {
    const file = new URL(`../../messages/${locale}.json`, import.meta.url);
    found = JSON.parse(readFileSync(file, "utf8")) as Messages;
    loaded.set(locale, found);
  }
  return found;
}

/** `t("home.today.cash")` → the words the app shows in `locale` (ICU plurals and values work). */
export type Words = (key: string, values?: Record<string, string | number>) => string;

export function words(locale: JourneyLocale): Words {
  const t = createTranslator({ locale, messages: messages(locale) });
  return (key, values) => (t as unknown as Words)(key, values);
}

/** Runs the queued jobs once (e.g. the `billing.run` job "Make bills now" queues). */
export async function runJobs(db: DbClient): Promise<void> {
  const report = await runJobWorker({
    db,
    registry: createJobRegistry([billingRunJob]),
    logger: silentLogger,
  });
  expect(report.failed).toBe(0);
}

/** An IP in TEST-NET-2 (198.51.100.0/24) picked from the seed id. */
export function journeyIp(seedId: string): string {
  return `198.51.100.${(Number.parseInt(seedId.slice(0, 2), 16) % 250) + 1}`;
}

/** The lineman app's headers: its version code and the phone's IP. */
export function apiHeaders(ip: string): Record<string, string> {
  return { "x-app-version-code": "5", "x-real-ip": ip };
}

/** A phone as the lineman app describes it at sign-in. */
export function phoneDevice() {
  return {
    install_id: randomUUID(),
    model: "Xiaomi Redmi 9A",
    os: "Android 13 (API 33)",
    app_version: "1.0.3",
    app_version_code: 5,
  };
}

/** Nothing scrolls sideways (the 360px phone rule). */
export async function expectNoSideways(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, page.url()).toBeLessThanOrEqual(0);
}

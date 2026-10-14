/**
 * Home views shaped like `@cb/core`'s `dashboard.home` returns them (T-083 component tests).
 */
import type { BillingRunView, HomeDashboard } from "@cb/core";
import { businessDate, type Paise, period } from "@cb/domain";

const p = (value: number) => value as Paise;

export const TODAY = businessDate("2026-10-14");
export const OCT = period("2026-10-01");

export function runView(overrides: Partial<BillingRunView> = {}): BillingRunView {
  return {
    id: "0193a000-0000-7000-8000-000000000083",
    period: OCT,
    trigger: "cron",
    status: "completed",
    skipReason: null,
    customerCount: 3,
    createdCount: 3,
    alreadyExistsCount: 0,
    skippedCount: 0,
    failedCount: 0,
    totalChargesPaise: p(90_000),
    startedAt: new Date("2026-09-30T18:31:00Z"),
    finishedAt: new Date("2026-09-30T18:35:00Z"),
    actorId: null,
    createdAt: new Date("2026-09-30T18:31:00Z"),
    updatedAt: new Date("2026-09-30T18:35:00Z"),
    ...overrides,
  };
}

/** A business with a full day: every tile has a number and every alert is on. */
export function busyView(overrides: Partial<HomeDashboard> = {}): HomeDashboard {
  return {
    today: TODAY,
    period: OCT,
    collectedToday: { cashPaise: p(104_000), upiPaise: p(15_000), paymentCount: 5 },
    collectedThisMonth: { cashPaise: p(1_234_500), upiPaise: p(65_500), paymentCount: 42 },
    billedThisMonth: { billCount: 3, totalPaise: p(90_000) },
    due: { duePaise: p(11_000), customerCount: 2 },
    latestRun: runView(),
    missedRuns: { count: 2, oldestPeriod: period("2026-07-01") },
    handoversWaiting: { count: 2, oldestDate: businessDate("2026-10-12") },
    paymentsToCheck: 1,
    subscription: {
      status: "active",
      mode: "normal",
      trialEndsOn: null,
      trialDaysLeft: null,
      graceEndsOn: null,
    },
    setup: { plans: true, customers: true, linemen: true, app: true },
    ...overrides,
  };
}

/** A business that has just signed up: zeros, no run, a 30-day trial, nothing set up. */
export function newView(overrides: Partial<HomeDashboard> = {}): HomeDashboard {
  return {
    today: TODAY,
    period: OCT,
    collectedToday: { cashPaise: p(0), upiPaise: p(0), paymentCount: 0 },
    collectedThisMonth: { cashPaise: p(0), upiPaise: p(0), paymentCount: 0 },
    billedThisMonth: { billCount: 0, totalPaise: p(0) },
    due: { duePaise: p(0), customerCount: 0 },
    latestRun: null,
    missedRuns: { count: 0, oldestPeriod: null },
    handoversWaiting: { count: 0, oldestDate: null },
    paymentsToCheck: 0,
    subscription: {
      status: "trialing",
      mode: "normal",
      trialEndsOn: businessDate("2026-11-13"),
      trialDaysLeft: 30,
      graceEndsOn: null,
    },
    setup: { plans: false, customers: false, linemen: false, app: false },
    ...overrides,
  };
}

/**
 * Fixtures for the T-081 report component tests: real translators over the generated messages
 * (any namespace), and report rows shaped like the `@cb/core` operations reports return them.
 */
import type {
  BillingRunReportRow,
  BillingRunReportRun,
  CollectionDayRow,
  ConnectionReportRow,
  HandoverReportRow,
} from "@cb/core";
import { businessDate, type Paise, period } from "@cb/domain";
import { createTranslator } from "next-intl";
import type { Translate } from "@/components/reports/format";
import en from "../../../../../../messages/en.json";
import hi from "../../../../../../messages/hi.json";

export function nsT(
  namespace: "reports" | "linemen" | "connections" | "bills",
  locale: "en" | "hi" = "en",
): Translate {
  return createTranslator({
    locale,
    messages: locale === "en" ? en : hi,
    namespace,
  }) as unknown as Translate;
}

export const p = (value: number) => value as Paise;

export function dayRow(overrides: Partial<CollectionDayRow> = {}): CollectionDayRow {
  return {
    businessDate: businessDate("2026-10-31"),
    collectorId: "0190a000-0000-7000-8000-00000000000a",
    name: "Ravi Kumar",
    role: "lineman",
    active: true,
    cashPaise: p(55_000),
    upiPaise: p(30_000),
    count: 3,
    cancelledCount: 0,
    cancelledPaise: p(0),
    ...overrides,
  };
}

export function handoverRow(overrides: Partial<HandoverReportRow> = {}): HandoverReportRow {
  return {
    sessionId: "0190a000-0000-7000-8000-0000000000b1",
    linemanId: "0190a000-0000-7000-8000-00000000000b",
    linemanName: "Suresh Pal",
    linemanActive: true,
    businessDate: businessDate("2026-10-31"),
    status: "submitted",
    cashExpectedPaise: p(30_000),
    upiTotalPaise: p(20_000),
    paymentCount: 2,
    handover: {
      cashExpectedPaise: p(60_000),
      cashHandedOverPaise: p(55_000),
      discrepancyPaise: -5_000,
      discrepancyReason: "short",
      note: null,
      submittedAt: new Date("2026-10-31T14:30:00Z"),
      reviewedAt: null,
      reviewedByName: null,
      reviewNote: null,
    },
    changedSinceHandover: true,
    history: [
      {
        id: "0190a000-0000-7000-8000-0000000000e1",
        type: "submitted",
        submissionId: "0190a000-0000-7000-8000-0000000000f1",
        at: new Date("2026-10-31T14:30:00Z"),
        actorId: "0190a000-0000-7000-8000-00000000000b",
        actorName: "Suresh Pal",
        cashExpectedPaise: 60_000,
        cashHandedOverPaise: 55_000,
        discrepancyPaise: -5_000,
        discrepancyReason: "short",
        unsyncedPaymentCount: 0,
        unsyncedCashPaise: 0,
        note: "One note was torn",
      },
      {
        id: "0190a000-0000-7000-8000-0000000000e2",
        type: "returned",
        submissionId: "0190a000-0000-7000-8000-0000000000f1",
        at: new Date("2026-11-01T03:30:00Z"),
        actorId: "0190a000-0000-7000-8000-00000000000c",
        actorName: "Owner Om",
        cashExpectedPaise: null,
        cashHandedOverPaise: null,
        discrepancyPaise: null,
        discrepancyReason: null,
        unsyncedPaymentCount: null,
        unsyncedCashPaise: null,
        note: "Count again",
      },
    ],
    ...overrides,
  };
}

export function connectionRow(overrides: Partial<ConnectionReportRow> = {}): ConnectionReportRow {
  return {
    assignmentId: "0190a000-0000-7000-8000-0000000000c1",
    customerId: "0190a000-0000-7000-8000-0000000000d1",
    customerCode: "C-3",
    customerName: "Chandu",
    areaId: null,
    areaName: "South",
    vcNumber: "000123456789",
    status: "suspended",
    since: businessDate("2026-10-16"),
    startDate: businessDate("2026-10-01"),
    endDate: null,
    planId: null,
    planName: null,
    rentPaise: p(25_000),
    ...overrides,
  };
}

export function runRow(overrides: Partial<BillingRunReportRow> = {}): BillingRunReportRow {
  return {
    itemId: "0190a000-0000-7000-8000-0000000000a1",
    customerId: "0190a000-0000-7000-8000-0000000000d7",
    customerCode: "G-7",
    customerName: "Gopal",
    areaName: "North",
    outcome: "failed",
    reason: "balance_mismatch",
    invoiceId: null,
    invoiceNumber: null,
    chargesPaise: null,
    attempts: 2,
    lastTriedAt: new Date("2026-11-01T03:00:00Z"),
    ...overrides,
  };
}

export function run(overrides: Partial<BillingRunReportRun> = {}): BillingRunReportRun {
  return {
    id: "0190a000-0000-7000-8000-0000000000aa",
    period: period("2026-11-01"),
    status: "completed_with_errors",
    trigger: "manual",
    skipReason: null,
    startedAt: new Date("2026-11-01T03:00:00Z"),
    finishedAt: new Date("2026-11-01T03:05:00Z"),
    createdAt: new Date("2026-11-01T03:00:00Z"),
    startedByName: "Owner Om",
    customerCount: 6,
    createdCount: 4,
    alreadyExistsCount: 0,
    skippedCount: 1,
    failedCount: 1,
    totalChargesPaise: p(130_000),
    ...overrides,
  };
}

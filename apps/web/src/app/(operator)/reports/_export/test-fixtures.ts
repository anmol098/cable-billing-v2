/**
 * Fixtures for the export tests (T-082): a strict translator over the generated messages (a missing
 * word fails the test instead of printing its key) and one row of every export kind, shaped like
 * the `@cb/core` services return them.
 */
import type { ExportKind, ExportRowTypes } from "@cb/core";
import { createTranslator } from "next-intl";
import en from "../../../../../messages/en.json";
import hi from "../../../../../messages/hi.json";
import type { Words } from "./columns";

export function allWords(locale: "en" | "hi" = "en"): Words {
  const t = createTranslator({
    locale,
    messages: locale === "en" ? en : hi,
    onError: (error) => {
      throw error;
    },
  });
  return t as unknown as Words;
}

const at = (iso: string) => new Date(iso);

/** One row per kind; values chosen to exercise every cell (credit, paise, formulas, Hindi). */
export const SAMPLE_ROWS: { readonly [K in ExportKind]: ExportRowTypes[K] } = {
  customers: {
    id: "0199c4f6-0000-7000-8000-000000000001",
    customerCode: "A-1",
    name: '=HYPERLINK("http://x")',
    phone: "9876543210",
    areaId: null,
    areaName: "उत्तर",
    status: "active",
    balancePaise: -12_550,
    creditPaise: 12_550,
    match: "all",
    matchedVcNumber: null,
  },
  bills: {
    id: "0199c4f6-0000-7000-8000-000000000002",
    invoiceNumber: "B-2610-00001",
    period: "2026-10-01",
    kind: "opening_balance",
    status: "issued",
    customer: { id: "c", code: "A-1", name: "Asha, Devi", areaName: null },
    chargesPaise: 40_000,
    paidPaise: 10_000,
    outstandingPaise: 30_000,
    payState: "part_paid",
  } as unknown as ExportRowTypes["bills"],
  payments: {
    id: "0199c4f6-0000-7000-8000-000000000003",
    customerId: "c",
    customerCode: "A-1",
    customerName: "Asha",
    amountPaise: 20_000,
    method: "upi",
    source: "android",
    collectorId: null,
    collectorName: null,
    recordedAt: at("2026-10-31T18:20:00Z"),
    postedAt: at("2026-10-31T18:45:00Z"),
    businessDate: "2026-11-01",
    receiptNumber: null,
    provisionalRef: "P-ABC-0001",
    reviewStatus: "needs_review",
    reviewReason: "device_mismatch",
    cancelled: true,
  } as unknown as ExportRowTypes["payments"],
  dues: {
    customerId: "c",
    customerCode: "G-6",
    customerName: "Gopal",
    phone: null,
    customerStatus: "inactive",
    areaId: null,
    areaName: null,
    balancePaise: 80_000,
    duePaise: 80_000,
    advancePaise: 0,
    buckets: { d0_30: 30_000, d31_60: 0, d61_90: 0, d90_plus: 50_000 },
    oldestDuePeriod: "2026-06-01",
    oldestBucket: "d90_plus",
  } as unknown as ExportRowTypes["dues"],
  collections: {
    businessDate: "2026-11-01",
    collectorId: null,
    name: null,
    role: null,
    active: true,
    cashPaise: 50_000,
    upiPaise: 10_000,
    count: 3,
    cancelledCount: 1,
    cancelledPaise: 30_000,
  } as unknown as ExportRowTypes["collections"],
  handover: {
    sessionId: "s",
    linemanId: "l",
    linemanName: "Ravi",
    linemanActive: true,
    businessDate: "2026-11-01",
    status: "returned",
    cashExpectedPaise: 30_000,
    upiTotalPaise: 10_000,
    paymentCount: 2,
    handover: {
      cashExpectedPaise: 30_000,
      cashHandedOverPaise: 25_000,
      discrepancyPaise: -5_000,
      discrepancyReason: "short",
      note: "-1 note lost",
      submittedAt: at("2026-11-01T12:00:00Z"),
      reviewedAt: at("2026-11-01T13:00:00Z"),
      reviewedByName: "Owner",
      reviewNote: "Count again",
    },
    changedSinceHandover: false,
    history: [],
  } as unknown as ExportRowTypes["handover"],
  connections: {
    assignmentId: "a",
    customerId: "c",
    customerCode: "A-1",
    customerName: "Asha",
    areaId: null,
    areaName: null,
    vcNumber: "001234567890",
    status: "suspended",
    since: "2026-10-15",
    startDate: "2026-07-01",
    endDate: null,
    planId: null,
    planName: null,
    rentPaise: 25_050,
  } as unknown as ExportRowTypes["connections"],
  billing_runs: {
    itemId: "i",
    customerId: "c",
    customerCode: "A-1",
    customerName: "Asha",
    areaName: null,
    outcome: "failed",
    reason: "balance_mismatch",
    invoiceId: null,
    invoiceNumber: null,
    chargesPaise: null,
    attempts: 2,
    lastTriedAt: at("2026-11-01T03:00:00Z"),
  } as unknown as ExportRowTypes["billing_runs"],
};

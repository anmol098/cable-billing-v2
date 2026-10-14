/**
 * Fixtures for the Bills component tests (T-047): real translators over the generated messages,
 * and view objects shaped like the `@cb/core` Bills services return them.
 */
import type { BillDetailView, BillingPreview, BillingRunView } from "@cb/core";
import { type Paise, type Period, period } from "@cb/domain";
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";
import type { Translate } from "./format";

export function billsT(locale: "en" | "hi" = "en"): Translate {
  const t = createTranslator({ locale, messages: locale === "en" ? en : hi, namespace: "bills" });
  return t as unknown as Translate;
}

export const NOV: Period = period("2026-11-01");
const p = (value: number) => value as Paise;

export function runView(overrides: Partial<BillingRunView> = {}): BillingRunView {
  return {
    id: "0193a000-0000-7000-8000-000000000001",
    period: NOV,
    trigger: "cron",
    status: "completed",
    skipReason: null,
    customerCount: 4,
    createdCount: 3,
    alreadyExistsCount: 0,
    skippedCount: 1,
    failedCount: 0,
    totalChargesPaise: p(85_000),
    startedAt: new Date("2026-11-01T00:00:00Z"),
    finishedAt: new Date("2026-11-01T00:05:00Z"),
    actorId: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:05:00Z"),
    ...overrides,
  };
}

export function previewView(overrides: Partial<BillingPreview> = {}): BillingPreview {
  return {
    period: NOV,
    tenantMode: "normal",
    run: null,
    customerCount: 131,
    willBillCount: 128,
    totalChargesPaise: p(5_760_000),
    alreadyBilledCount: 0,
    nothingToBillCount: 0,
    problems: [
      { customerId: "c1", reason: "balance_mismatch", details: {} },
      { customerId: "c2", reason: "event_before_start", details: {} },
      { customerId: "c3", reason: "internal_error", details: {} },
    ],
    ...overrides,
  };
}

export function billView(overrides: Partial<BillDetailView> = {}): BillDetailView {
  return {
    bill: {
      id: "0193a000-0000-7000-8000-0000000000b1",
      invoiceNumber: "INV-2611-00001",
      period: NOV,
      kind: "regular",
      status: "issued",
      issuedAt: new Date("2026-11-01T00:05:00Z"),
      openingBalancePaise: p(20_000),
      chargesPaise: p(57_500),
      totalDuePaise: p(77_500),
      paidPaise: p(40_000),
      outstandingPaise: p(17_500),
      payState: "part_paid",
      voidedAt: null,
      voidReason: null,
    },
    customer: {
      id: "0193a000-0000-7000-8000-0000000000c1",
      code: "A-1",
      name: "Asha Devi",
      areaName: "North",
      phone: "9876543210",
      address: "Gali 4",
    },
    operator: {
      name: "Sharma Cable",
      phone: "9811111111",
      address: "Main Road",
      language: "hi",
      footer: "Thank you <3",
    },
    connections: [
      {
        assignmentId: "a1",
        vcNumber: "VC1001",
        totalPaise: p(35_000),
        lines: [
          { id: "l1", type: "rent", amountPaise: p(30_000), adjustment: null, description: null },
          {
            id: "l2",
            type: "adjustment",
            amountPaise: p(5_000),
            description: null,
            adjustment: {
              id: "adj1",
              source: "plan_change",
              direction: "debit",
              period: NOV,
              reason: null,
              createdAt: new Date("2026-11-01T00:00:00Z"),
            },
          },
        ],
      },
      {
        assignmentId: "a2",
        vcNumber: "VC1002",
        totalPaise: p(20_000),
        lines: [
          { id: "l3", type: "rent", amountPaise: p(20_000), adjustment: null, description: null },
        ],
      },
    ],
    otherLines: [
      {
        id: "l4",
        type: "adjustment",
        amountPaise: p(2_500),
        description: null,
        adjustment: {
          id: "adj2",
          source: "manual",
          direction: "debit",
          period: null,
          reason: "Repair visit",
          createdAt: new Date("2026-10-20T00:00:00Z"),
        },
      },
    ],
    payments: [
      {
        sourceType: "payment",
        sourceId: "pay1",
        amountPaise: p(40_000),
        undonePaise: p(0),
        appliedAt: new Date("2026-11-05T06:00:00Z"),
        payment: {
          receiptNumber: "R-2611-00001",
          method: "cash",
          amountPaise: p(40_000),
          recordedAt: new Date("2026-11-05T06:00:00Z"),
          reversed: false,
        },
        creditAdjustment: null,
      },
      {
        sourceType: "payment",
        sourceId: "pay2",
        amountPaise: p(10_000),
        undonePaise: p(10_000),
        appliedAt: new Date("2026-11-05T07:00:00Z"),
        payment: {
          receiptNumber: "R-2611-00002",
          method: "upi",
          amountPaise: p(10_000),
          recordedAt: new Date("2026-11-05T07:00:00Z"),
          reversed: true,
        },
        creditAdjustment: null,
      },
    ],
    balance: { balancePaise: p(37_500), creditPaise: p(0) },
    ...overrides,
  };
}

/**
 * Fixtures for the History / Bills tab tests (T-049): real translators over the generated
 * messages, and views shaped like `@cb/core` `customerStatement` / `customerBills` return them
 * (Asha's November: a payment taken on 31 Oct and posted after midnight, the November bill, an
 * overpayment, and the 10 Oct payment cancelled by the Owner).
 */
import type { CustomerBillsView, CustomerStatementView, StatementLine } from "@cb/core";
import { type BusinessDate, businessDate, type Paise, period } from "@cb/domain";
import { createTranslator } from "next-intl";
import type { Translate } from "@/components/bills/format";
import en from "../../../../../../../messages/en.json";
import hi from "../../../../../../../messages/hi.json";

export function translators(locale: "en" | "hi" = "en"): { t: Translate; tb: Translate } {
  const messages = locale === "en" ? en : hi;
  return {
    t: createTranslator({ locale, messages, namespace: "statements" }) as unknown as Translate,
    tb: createTranslator({ locale, messages, namespace: "bills" }) as unknown as Translate,
  };
}

const p = (value: number) => value as Paise;
export const CUSTOMER_ID = "0193a000-0000-7000-8000-0000000000c1";

function line(
  seq: number,
  fields: Partial<StatementLine> &
    Pick<StatementLine, "type" | "amountPaise" | "balanceAfterPaise">,
  at: string,
): StatementLine {
  const instant = new Date(at);
  return {
    id: `0193a000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    seq,
    at: instant,
    date: businessDate(at.slice(0, 10)) as BusinessDate,
    bill: null,
    payment: null,
    reversal: null,
    adjustment: null,
    ...fields,
  };
}

export function statementView(
  overrides: Partial<CustomerStatementView> = {},
): CustomerStatementView {
  const lines: StatementLine[] = [
    line(
      11,
      {
        type: "payment",
        amountPaise: p(-5_000),
        balanceAfterPaise: p(0),
        date: businessDate("2026-11-01"),
        payment: {
          id: "0193a000-0000-7000-8000-0000000000a3",
          method: "cash",
          source: "android",
          amountPaise: p(5_000),
          receiptNumber: "R-2610-00003",
          businessDate: businessDate("2026-10-31"),
          collectorName: "Ramu",
          reversed: false,
        },
      },
      "2026-10-31T18:45:00.000Z",
    ),
    line(
      12,
      {
        type: "invoice",
        amountPaise: p(52_500),
        balanceAfterPaise: p(52_500),
        bill: {
          id: "0193a000-0000-7000-8000-0000000000b2",
          invoiceNumber: "INV-2611-00001",
          period: period("2026-11-01"),
          kind: "regular",
          status: "issued",
        },
      },
      "2026-11-01T03:00:00.000Z",
    ),
    line(
      13,
      {
        type: "payment",
        amountPaise: p(-100_000),
        balanceAfterPaise: p(-47_500),
        payment: {
          id: "0193a000-0000-7000-8000-0000000000a4",
          method: "upi",
          source: "web",
          amountPaise: p(100_000),
          receiptNumber: "R-2611-00001",
          businessDate: businessDate("2026-11-05"),
          collectorName: "Office Owner",
          reversed: false,
        },
      },
      "2026-11-05T06:00:00.000Z",
    ),
    line(
      14,
      {
        type: "payment_reversal",
        amountPaise: p(30_000),
        balanceAfterPaise: p(-17_500),
        payment: {
          id: "0193a000-0000-7000-8000-0000000000a1",
          method: "cash",
          source: "web",
          amountPaise: p(30_000),
          receiptNumber: "R-2610-00001",
          businessDate: businessDate("2026-10-10"),
          collectorName: "Office Owner",
          reversed: true,
        },
        reversal: {
          id: "0193a000-0000-7000-8000-0000000000d1",
          reason: "Counted <twice>",
          at: new Date("2026-11-06T06:00:00.000Z"),
        },
      },
      "2026-11-06T06:00:00.000Z",
    ),
  ];
  return {
    customer: {
      id: CUSTOMER_ID,
      code: "A-1",
      name: "Asha Devi",
      areaName: "North",
      phone: "9876543210",
      address: "Gali 4",
      status: "active",
    },
    operator: { name: "Shiv Cable", phone: "9800000000", address: "Main Road", language: "hi" },
    range: {
      from: businessDate("2026-11-01"),
      to: businessDate("2026-11-30"),
      today: businessDate("2026-12-02"),
      asOfNow: false,
    },
    openingBalancePaise: p(5_000),
    lines,
    hiddenLines: 0,
    totals: {
      billedPaise: p(52_500),
      paidPaise: p(105_000),
      undonePaise: p(30_000),
      discountPaise: p(0),
    },
    closingBalancePaise: p(-17_500),
    now: {
      balancePaise: p(32_500),
      creditPaise: p(0),
      oldestDuePeriod: period("2026-12-01"),
      ledgerPaise: p(32_500),
    },
    generatedAt: new Date("2026-12-02T06:00:00.000Z"),
    ...overrides,
  };
}

export function billsView(overrides: Partial<CustomerBillsView> = {}): CustomerBillsView {
  return {
    customerId: CUSTOMER_ID,
    rows: [
      {
        id: "0193a000-0000-7000-8000-0000000000b3",
        invoiceNumber: "INV-2612-00001",
        period: period("2026-12-01"),
        kind: "regular",
        status: "issued",
        issuedAt: new Date("2026-12-01T03:00:00.000Z"),
        chargesPaise: p(50_000),
        paidPaise: p(17_500),
        outstandingPaise: p(32_500),
        payState: "part_paid",
      },
      {
        id: "0193a000-0000-7000-8000-0000000000b2",
        invoiceNumber: "INV-2611-00001",
        period: period("2026-11-01"),
        kind: "regular",
        status: "issued",
        issuedAt: new Date("2026-11-01T03:00:00.000Z"),
        chargesPaise: p(52_500),
        paidPaise: p(52_500),
        outstandingPaise: p(0),
        payState: "paid",
      },
      {
        id: "0193a000-0000-7000-8000-0000000000b0",
        invoiceNumber: "OLD-1",
        period: period("2026-09-01"),
        kind: "opening_balance",
        status: "issued",
        issuedAt: new Date("2026-09-20T06:00:00.000Z"),
        chargesPaise: p(15_000),
        paidPaise: p(0),
        outstandingPaise: p(15_000),
        payState: "unpaid",
      },
    ],
    totals: {
      count: 3,
      chargesPaise: p(117_500),
      paidPaise: p(70_000),
      outstandingPaise: p(47_500),
    },
    pendingChargesPaise: p(2_500),
    balancePaise: p(27_500),
    creditPaise: p(20_000),
    ...overrides,
  };
}

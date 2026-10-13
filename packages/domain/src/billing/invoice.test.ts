/**
 * `buildInvoice` (PLAN §8.2): consolidated lines, totals, pending adjustments, nothing-to-bill and
 * refused input. Table-driven where the cases share a shape.
 */
import { describe, expect, it } from "vitest";
import { type AdjustmentDraft, planChangeForPeriod } from "../adjustments";
import { type Paise, paise } from "../money";
import { unwrap } from "../result";
import { businessDate, type Period, period } from "../time";
import { buildInvoice } from "./invoice";
import type {
  AssignmentEvent,
  BillingAssignment,
  BuildInvoiceInput,
  InvoiceDraft,
  PendingAdjustment,
} from "./types";

const d = businessDate;
const OCT = period("2026-10-01");
const NOV = period("2026-11-01");
const DEC = period("2026-12-01");
const CUSTOMER = "cust-1";

function asg(
  id: string,
  startDate: string,
  rental: number,
  options: { events?: AssignmentEvent[]; endDate?: string; customerId?: string } = {},
): BillingAssignment {
  return {
    id,
    customerId: options.customerId ?? CUSTOMER,
    startDate: d(startDate),
    endDate: options.endDate === undefined ? null : d(options.endDate),
    events: options.events ?? [],
    initialRentalPaise: paise(rental),
  };
}

function adj(
  id: string,
  amount: number,
  options: Partial<Omit<PendingAdjustment, "id" | "amountPaise">> = {},
): PendingAdjustment {
  return {
    id,
    customerId: CUSTOMER,
    assignmentId: null,
    period: null,
    direction: "debit",
    source: "manual",
    ...options,
    amountPaise: paise(amount),
  };
}

function input(overrides: Partial<BuildInvoiceInput> = {}): BuildInvoiceInput {
  return {
    customer: { id: CUSTOMER },
    assignments: [],
    pendingAdjustments: [],
    openingBalancePaise: paise(0),
    period: NOV,
    ...overrides,
  };
}

function invoiceOf(overrides: Partial<BuildInvoiceInput>): InvoiceDraft {
  const outcome = unwrap(buildInvoice(input(overrides)));
  if (outcome.outcome !== "invoice") throw new Error(`expected an invoice, got ${outcome.outcome}`);
  return outcome;
}

function reasonOf(overrides: Partial<BuildInvoiceInput>): unknown {
  const result = buildInvoice(input(overrides));
  return result.ok ? "ok" : result.error.details?.reason;
}

/** Deep-freezes test inputs: any mutation inside the domain then throws (ES modules are strict). */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) frozen((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const disconnected20Oct = asg("vc-old", "2026-03-01", 30_000, {
  events: [{ type: "disconnected", effectiveDate: d("2026-10-20") }],
  endDate: "2026-10-20",
});

describe("buildInvoice: consolidation (PRD §15 #3, RULE-04, B-003)", () => {
  it("gives a customer with several active VCs one invoice with one line per VC at its own rental", () => {
    const invoice = invoiceOf({
      assignments: [
        asg("vc-b", "2026-02-01", 45_000),
        asg("vc-a", "2026-01-10", 30_000),
        asg("vc-c", "2026-08-01", 20_000),
      ],
    });
    expect(invoice).toEqual({
      outcome: "invoice",
      kind: "regular",
      customerId: CUSTOMER,
      period: NOV,
      lines: [
        { type: "rent", assignmentId: "vc-a", adjustmentId: null, amountPaise: 30_000 },
        { type: "rent", assignmentId: "vc-b", adjustmentId: null, amountPaise: 45_000 },
        { type: "rent", assignmentId: "vc-c", adjustmentId: null, amountPaise: 20_000 },
      ],
      chargesPaise: 95_000,
      openingBalancePaise: 0,
      totalDuePaise: 95_000,
      invoicedAdjustmentIds: [],
    });
  });

  it("bills only the VCs that are billable for the period", () => {
    const invoice = invoiceOf({
      assignments: [
        disconnected20Oct,
        asg("vc-new", "2026-11-15", 25_000), // starts mid-month: §8.3 decides, not the run
        asg("vc-live", "2026-05-01", 35_000),
        asg("vc-susp", "2026-05-01", 40_000, {
          events: [{ type: "suspended", effectiveDate: d("2026-10-10") }],
        }),
      ],
    });
    expect(invoice.lines.map((line) => line.assignmentId)).toEqual(["vc-live"]);
    expect(invoice.chargesPaise).toBe(35_000);
  });

  it("orders rent lines by start date, then id, whatever the input order", () => {
    const assignments = [
      asg("b", "2026-01-01", 1),
      asg("a", "2026-01-01", 2),
      asg("c", "2025-12-31", 3),
    ];
    const ids = (list: BillingAssignment[]) =>
      invoiceOf({ assignments: list }).lines.map((line) => line.assignmentId);
    expect(ids(assignments)).toEqual(["c", "a", "b"]);
    expect(ids([...assignments].reverse())).toEqual(["c", "a", "b"]);
  });

  it("charges the rental in effect for the period after a plan change", () => {
    const invoice = invoiceOf({
      assignments: [
        asg("vc", "2026-01-01", 30_000, {
          events: [
            { type: "plan_changed", effectiveDate: d("2026-11-20"), rentalPaise: paise(45_000) },
          ],
        }),
      ],
    });
    expect(invoice.lines).toEqual([
      { type: "rent", assignmentId: "vc", adjustmentId: null, amountPaise: 45_000 },
    ]);
  });

  it("gives a ₹0 line (and an invoice) for a billable VC with a ₹0 rental", () => {
    const invoice = invoiceOf({ assignments: [asg("free", "2026-01-01", 0)] });
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.chargesPaise).toBe(0);
  });
});

describe("buildInvoice: opening balance and total due (FR-009, FR-011)", () => {
  it.each([
    { name: "no earlier dues", opening: 0, charges: 45_000, total: 45_000 },
    {
      name: "arrears are shown separately and added",
      opening: 30_000,
      charges: 45_000,
      total: 75_000,
    },
    {
      name: "credit (negative balance) reduces the total",
      opening: -10_000,
      charges: 45_000,
      total: 35_000,
    },
    {
      name: "more credit than charges leaves a negative total",
      opening: -60_000,
      charges: 45_000,
      total: -15_000,
    },
  ])(
    "$name: opening $opening + charges $charges = total due $total",
    ({ opening, charges, total }) => {
      const invoice = invoiceOf({
        assignments: [asg("vc", "2026-01-01", charges)],
        openingBalancePaise: paise(opening),
      });
      expect(invoice.openingBalancePaise).toBe(opening);
      expect(invoice.chargesPaise).toBe(charges);
      expect(invoice.totalDuePaise).toBe(total);
    },
  );

  it('keeps arrears when a VC was disconnected (RULE-08: "arrears remain due")', () => {
    // The customer still has another VC: the old dues are carried in the opening balance.
    const invoice = invoiceOf({
      assignments: [disconnected20Oct, asg("vc-live", "2026-01-01", 35_000)],
      openingBalancePaise: paise(30_000),
    });
    expect(invoice.lines.map((line) => line.assignmentId)).toEqual(["vc-live"]);
    expect(invoice.totalDuePaise).toBe(65_000);
    // With no VC left there is nothing new to bill; the dues stay owed on the earlier invoices.
    expect(
      unwrap(
        buildInvoice(
          input({ assignments: [disconnected20Oct], openingBalancePaise: paise(30_000) }),
        ),
      ),
    ).toEqual({ outcome: "nothing_to_bill", customerId: CUSTOMER, period: NOV });
  });
});

describe("buildInvoice: pending adjustments (PLAN §8.2, §8.3)", () => {
  it("adds pending debit adjustments as lines after the rent and lists them as invoiced", () => {
    const invoice = invoiceOf({
      assignments: [asg("vc", "2026-01-01", 30_000)],
      pendingAdjustments: [
        adj("adj-2", 15_000, { assignmentId: "vc", period: OCT, source: "plan_change" }),
        adj("adj-1", 5_000),
      ],
    });
    expect(invoice.lines).toEqual([
      { type: "rent", assignmentId: "vc", adjustmentId: null, amountPaise: 30_000 },
      {
        type: "adjustment",
        assignmentId: null,
        adjustmentId: "adj-1",
        adjustmentPeriod: null,
        source: "manual",
        amountPaise: 5_000,
      },
      {
        type: "adjustment",
        assignmentId: "vc",
        adjustmentId: "adj-2",
        adjustmentPeriod: OCT,
        source: "plan_change",
        amountPaise: 15_000,
      },
    ]);
    expect(invoice.chargesPaise).toBe(50_000);
    expect(invoice.invoicedAdjustmentIds).toEqual(["adj-1", "adj-2"]);
  });

  it("bills an adjustment even when no VC is billable any more (a disconnected VC's last charge)", () => {
    const invoice = invoiceOf({
      assignments: [disconnected20Oct],
      pendingAdjustments: [
        adj("adj", 30_000, { assignmentId: "vc-old", period: OCT, source: "mid_month_start" }),
      ],
    });
    expect(invoice.lines.map((line) => line.type)).toEqual(["adjustment"]);
    expect(invoice.chargesPaise).toBe(30_000);
  });

  it("includes adjustments for this period or earlier and leaves later ones pending", () => {
    const invoice = invoiceOf({
      period: NOV,
      assignments: [asg("vc", "2026-01-01", 30_000)],
      pendingAdjustments: [
        adj("adj-oct", 1_000, { period: OCT }),
        adj("adj-nov", 2_000, { period: NOV }),
        adj("adj-dec", 4_000, { period: DEC }),
      ],
    });
    expect(invoice.invoicedAdjustmentIds).toEqual(["adj-oct", "adj-nov"]);
    expect(invoice.chargesPaise).toBe(33_000);
  });

  it("refuses a credit adjustment: it is credit applied by allocation, not a line (PLAN §8.5)", () => {
    expect(reasonOf({ pendingAdjustments: [adj("c", 1_000, { direction: "credit" })] })).toBe(
      "credit_adjustment",
    );
  });
});

describe("buildInvoice: nothing to bill (PLAN §8.2)", () => {
  it.each([
    { name: "no assignments and no adjustments", assignments: [] as BillingAssignment[] },
    { name: "only a VC disconnected before the period", assignments: [disconnected20Oct] },
    { name: "only a VC that starts after the 1st", assignments: [asg("vc", "2026-11-02", 30_000)] },
    {
      name: "only a suspended VC",
      assignments: [
        asg("vc", "2026-01-01", 30_000, {
          events: [{ type: "suspended", effectiveDate: d("2026-09-30") }],
        }),
      ],
    },
    {
      name: "only adjustments for a later period",
      assignments: [],
      adjustments: [adj("a", 1, { period: DEC })],
    },
  ])("$name", ({ assignments, adjustments }) => {
    expect(
      unwrap(
        buildInvoice(
          input({
            assignments,
            pendingAdjustments: adjustments ?? [],
            openingBalancePaise: paise(500),
          }),
        ),
      ),
    ).toEqual({ outcome: "nothing_to_bill", customerId: CUSTOMER, period: NOV });
  });
});

describe("buildInvoice: refused input", () => {
  it.each([
    ["a period that is not a 1st", { period: d("2026-11-02") as Period }, "invalid_period"],
    ["an empty customer id", { customer: { id: "" } }, "invalid_id"],
    ["a fractional opening balance", { openingBalancePaise: 1.5 as Paise }, "invalid_amount"],
    ["an empty assignment id", { assignments: [asg("", "2026-01-01", 1)] }, "invalid_id"],
    [
      "an assignment listed twice",
      { assignments: [asg("a", "2026-01-01", 1), asg("a", "2026-02-01", 2)] },
      "duplicate_id",
    ],
    [
      "another customer's assignment (RULE-07)",
      { assignments: [asg("a", "2026-01-01", 1, { customerId: "cust-2" })] },
      "other_customer",
    ],
    ["a negative rental", { assignments: [asg("a", "2026-01-01", -1)] }, "invalid_amount"],
    [
      "an impossible timeline",
      {
        assignments: [
          asg("a", "2026-01-01", 1, {
            events: [{ type: "reactivated", effectiveDate: d("2026-02-01") }],
          }),
        ],
      },
      "invalid_transition",
    ],
    ["an empty adjustment id", { pendingAdjustments: [adj("", 1)] }, "invalid_id"],
    [
      "an adjustment listed twice",
      { pendingAdjustments: [adj("x", 1), adj("x", 2)] },
      "duplicate_id",
    ],
    [
      "another customer's adjustment",
      { pendingAdjustments: [adj("x", 1, { customerId: "cust-2" })] },
      "other_customer",
    ],
    ["a zero adjustment", { pendingAdjustments: [adj("x", 0)] }, "invalid_amount"],
    ["a negative adjustment", { pendingAdjustments: [adj("x", -5)] }, "invalid_amount"],
    [
      "an adjustment period that is not a 1st",
      { pendingAdjustments: [adj("x", 5, { period: d("2026-10-02") as Period })] },
      "invalid_period",
    ],
  ] as const)("%s → %s", (_name, overrides, reason) => {
    expect(reasonOf(overrides as Partial<BuildInvoiceInput>)).toBe(reason);
  });

  it("names the assignment whose timeline is impossible", () => {
    const result = buildInvoice(
      input({
        assignments: [
          asg("bad", "2026-01-01", 1, {
            events: [{ type: "suspended", effectiveDate: d("2025-12-01") }],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { reason: "event_before_start", assignmentId: "bad" } },
    });
  });
});

describe("buildInvoice: purity", () => {
  it("does not mutate its input and gives the same answer twice", () => {
    const value = frozen(
      input({
        assignments: [asg("b", "2026-01-01", 30_000), asg("a", "2026-01-01", 20_000)],
        pendingAdjustments: [adj("y", 10), adj("x", 20)],
        openingBalancePaise: paise(-500),
      }),
    );
    const first = buildInvoice(value);
    expect(buildInvoice(value)).toEqual(first);
    expect(first.ok).toBe(true);
  });
});

describe("buildInvoice with T-042 adjustment drafts", () => {
  const novRentLine = {
    kind: "rent" as const,
    id: "line-nov",
    assignmentId: "vc",
    period: NOV,
    amountPaise: paise(30_000),
  };
  const stored = (draft: AdjustmentDraft, id: string): PendingAdjustment => ({
    id,
    customerId: CUSTOMER,
    assignmentId: draft.assignmentId,
    period: draft.period,
    direction: draft.direction,
    amountPaise: draft.amountPaise,
    source: draft.source,
  });

  it("a plan change after the Nov bill: Dec bills the new rent plus the Nov difference (PRD §15 #5)", () => {
    const decision = unwrap(
      planChangeForPeriod({
        assignmentId: "vc",
        period: NOV,
        records: [novRentLine],
        newAmountPaise: paise(45_000),
      }),
    );
    if (decision.draft === null) throw new Error("expected a draft");
    expect(decision.draft.direction).toBe("debit");

    const invoice = invoiceOf({
      period: DEC,
      assignments: [
        asg("vc", "2026-01-01", 30_000, {
          events: [
            { type: "plan_changed", effectiveDate: d("2026-11-15"), rentalPaise: paise(45_000) },
          ],
        }),
      ],
      pendingAdjustments: [stored(decision.draft, "adj-1")],
    });
    expect(invoice.lines).toEqual([
      { type: "rent", assignmentId: "vc", adjustmentId: null, amountPaise: 45_000 },
      {
        type: "adjustment",
        assignmentId: "vc",
        adjustmentId: "adj-1",
        adjustmentPeriod: NOV,
        source: "plan_change",
        amountPaise: 15_000,
      },
    ]);
    // Nov in total: 30,000 on the Nov bill + 15,000 on this one = the new rental, charged once.
    expect(novRentLine.amountPaise + decision.draft.amountPaise).toBe(45_000);
  });

  it("a plan change down gives a credit draft: it is credit, so it is refused as a line", () => {
    const decision = unwrap(
      planChangeForPeriod({
        assignmentId: "vc",
        period: NOV,
        records: [novRentLine],
        newAmountPaise: paise(20_000),
      }),
    );
    if (decision.draft === null) throw new Error("expected a draft");
    expect(decision.draft.direction).toBe("credit");
    expect(reasonOf({ period: DEC, pendingAdjustments: [stored(decision.draft, "adj-2")] })).toBe(
      "credit_adjustment",
    );
  });
});

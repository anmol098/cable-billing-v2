import { describe, expect, it } from "vitest";
import { type Paise, paise } from "../money";
import { checkLedger, LEDGER_VIOLATION_CODES, type LedgerState } from "./check-ledger";
import type { AllocationRow } from "./types";

function row(
  id: string,
  invoiceId: string,
  sourceId: string,
  amount: number,
  extra: Partial<AllocationRow> = {},
): AllocationRow {
  return {
    id,
    invoiceId,
    sourceType: "payment",
    sourceId,
    amountPaise: paise(amount),
    reversalId: null,
    ...extra,
  };
}

/**
 * A healthy account: Oct ₹450 and Nov ₹450 billed; ₹600 paid (Oct paid, ₹150 on Nov); ₹100 paid
 * and reversed; a ₹50 credit adjustment, applied to Nov. Owed: ₹250 on Nov. Credit: 0.
 */
function healthy(): LedgerState {
  return {
    invoices: [
      { id: "inv-oct", chargesPaise: paise(45_000) },
      { id: "inv-nov", chargesPaise: paise(45_000) },
    ],
    payments: [
      { id: "pay-1", amountPaise: paise(60_000), reversed: false },
      { id: "pay-2", amountPaise: paise(10_000), reversed: true },
    ],
    creditAdjustments: [{ id: "adj-1", amountPaise: paise(5_000) }],
    allocations: [
      row("al-1", "inv-oct", "pay-1", 45_000),
      row("al-2", "inv-nov", "pay-1", 15_000),
      row("al-3", "inv-nov", "pay-2", 10_000),
      row("al-4", "inv-nov", "pay-2", -10_000, { reversalId: "rev-1" }),
      row("al-5", "inv-nov", "adj-1", 5_000, { sourceType: "credit_adjustment" }),
    ],
    ledgerEntries: [
      { type: "invoice", amountPaise: paise(45_000) },
      { type: "payment", amountPaise: paise(-60_000) },
      { type: "invoice", amountPaise: paise(45_000) },
      { type: "payment", amountPaise: paise(-10_000) },
      { type: "payment_reversal", amountPaise: paise(10_000) },
      { type: "credit_adjustment", amountPaise: paise(-5_000) },
    ],
    balancePaise: paise(25_000),
    creditPaise: paise(0),
  };
}

function codes(state: LedgerState) {
  return checkLedger(state).map((v) => [v.code, v.invariant]);
}

describe("checkLedger()", () => {
  it("finds nothing wrong with a healthy account, or an empty one", () => {
    expect(checkLedger(healthy())).toEqual([]);
    expect(
      checkLedger({
        invoices: [],
        payments: [],
        creditAdjustments: [],
        allocations: [],
        ledgerEntries: [],
        balancePaise: paise(0),
        creditPaise: paise(0),
      }),
    ).toEqual([]);
  });

  it("invariant 1: Σ allocations of a payment ≤ payment amount", () => {
    const state = healthy();
    const violations = checkLedger({
      ...state,
      // pay-1 now pays ₹10 more than it had; the invoices and credit stay consistent otherwise.
      allocations: [...state.allocations, row("al-6", "inv-nov", "pay-1", 1_000)],
      creditPaise: paise(-1_000),
    });
    expect(violations).toContainEqual({
      code: "ALLOCATIONS_EXCEED_PAYMENT",
      invariant: 1,
      message: expect.any(String),
      details: { paymentId: "pay-1", allocatedPaise: 61_000, amountPaise: 60_000 },
    });
  });

  it("invariant 2: unallocated remainder = credit", () => {
    expect(codes({ ...healthy(), creditPaise: paise(1) })).toEqual([["CREDIT_MISMATCH", 2]]);
    const [violation] = checkLedger({ ...healthy(), creditPaise: paise(1) });
    expect(violation?.details).toEqual({ expectedPaise: 0, storedPaise: 1 });
  });

  it("invariant 2 ignores a reversed payment's remainder", () => {
    const state = healthy();
    // pay-3: ₹200 paid with nothing to pay, then reversed. Its ₹200 is not credit.
    const withReversedCredit: LedgerState = {
      ...state,
      payments: [...state.payments, { id: "pay-3", amountPaise: paise(20_000), reversed: true }],
      ledgerEntries: [
        ...state.ledgerEntries,
        { type: "payment", amountPaise: paise(-20_000) },
        { type: "payment_reversal", amountPaise: paise(20_000) },
      ],
    };
    expect(checkLedger(withReversedCredit)).toEqual([]);
  });

  it("invariant 3: Σ ledger = Σ charges − Σ payments − Σ credit adj + Σ reversals", () => {
    const state = healthy();
    const missingEntry = { ...state, ledgerEntries: state.ledgerEntries.slice(1) };
    const violations = checkLedger(missingEntry);
    expect(violations.map((v) => v.code)).toEqual(["LEDGER_MISMATCH", "BALANCE_MISMATCH"]);
    expect(violations[0]).toMatchObject({
      invariant: 3,
      details: {
        ledgerPaise: -20_000,
        expectedPaise: 25_000,
        invoiceChargesPaise: 90_000,
        paymentsPaise: 70_000,
        creditAdjustmentsPaise: 5_000,
        reversalsPaise: 10_000,
      },
    });
  });

  it("invariant 4: invoice outstanding never below 0", () => {
    const state = healthy();
    const violations = checkLedger({
      ...state,
      invoices: [state.invoices[0], { id: "inv-nov", chargesPaise: paise(15_000) }].filter(
        (invoice) => invoice !== undefined,
      ),
      ledgerEntries: [...state.ledgerEntries, { type: "invoice", amountPaise: paise(-30_000) }],
      balancePaise: paise(-5_000),
    });
    expect(violations).toEqual([
      {
        code: "NEGATIVE_OUTSTANDING",
        invariant: 4,
        message: expect.any(String),
        details: { invoiceId: "inv-nov", outstandingPaise: -5_000, chargesPaise: 15_000 },
      },
    ]);
  });

  it("supporting checks: credit-adjustment over-allocation and negative source totals", () => {
    const state = healthy();
    expect(
      codes({
        ...state,
        allocations: [
          ...state.allocations,
          row("al-6", "inv-nov", "adj-1", 1, { sourceType: "credit_adjustment" }),
        ],
        creditPaise: paise(-1),
      }),
    ).toEqual([["ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT", null]]);
    expect(
      codes({
        ...state,
        allocations: [...state.allocations, row("al-6", "inv-oct", "pay-1", -61_000)],
        creditPaise: paise(61_000),
      }),
    ).toEqual(
      expect.arrayContaining([
        ["NEGATIVE_SOURCE_ALLOCATIONS", null],
        ["NEGATIVE_ALLOCATION_WITHOUT_REVERSAL", null],
        ["OUTSTANDING_EXCEEDS_CHARGES", null],
      ]),
    );
  });

  it("supporting checks: reversal rows must exist, net to 0 and belong to a reversed payment", () => {
    const state = healthy();
    // The reversal's negative row is missing.
    expect(
      codes({ ...state, allocations: state.allocations.filter((r) => r.id !== "al-4") }),
    ).toEqual([["REVERSED_PAYMENT_STILL_ALLOCATED", null]]);
    // A negative row without reversal_id.
    const unlinked = state.allocations.map((r) =>
      r.id === "al-4" ? { ...r, reversalId: null } : r,
    );
    expect(codes({ ...state, allocations: unlinked })).toEqual([
      ["NEGATIVE_ALLOCATION_WITHOUT_REVERSAL", null],
    ]);
  });

  it("supporting checks: unknown references, duplicate ids, bad amounts", () => {
    const state = healthy();
    expect(
      codes({
        ...state,
        allocations: [
          ...state.allocations,
          row("al-6", "inv-gone", "pay-1", 0),
          row("al-7", "inv-oct", "pay-gone", 0),
        ],
      }),
    ).toEqual([
      ["UNKNOWN_INVOICE", null],
      ["UNKNOWN_SOURCE", null],
    ]);
    expect(
      codes({ ...state, allocations: [...state.allocations, row("al-1", "inv-oct", "pay-1", 0)] }),
    ).toEqual([["DUPLICATE_ID", null]]);
    expect(
      codes({
        ...state,
        payments: [...state.payments, { id: "pay-0", amountPaise: paise(0), reversed: false }],
      }),
    ).toEqual([["INVALID_AMOUNT", null]]);
    // A malformed amount is reported, then counted as 0 (here the expected credit is 0 anyway).
    expect(codes({ ...state, creditPaise: 0.5 as Paise })).toEqual([["INVALID_AMOUNT", null]]);
  });

  it("reports in a stable order whatever the input order", () => {
    const state = healthy();
    const broken: LedgerState = { ...state, creditPaise: paise(7), balancePaise: paise(8) };
    const reversedInputs: LedgerState = {
      ...broken,
      invoices: [...broken.invoices].reverse(),
      payments: [...broken.payments].reverse(),
      allocations: [...broken.allocations].reverse(),
    };
    expect(checkLedger(reversedInputs)).toEqual(checkLedger(broken));
    const order = checkLedger(broken).map((v) => LEDGER_VIOLATION_CODES.indexOf(v.code));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

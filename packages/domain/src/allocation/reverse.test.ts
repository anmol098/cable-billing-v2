import { describe, expect, it } from "vitest";
import { paise } from "../money";
import { unwrap } from "../result";
import { type ReversiblePayment, reverse } from "./reverse";
import type { AllocationRow } from "./types";

function payment(amount: number, reversed = false): ReversiblePayment {
  return { id: "pay-1", amountPaise: paise(amount), reversed };
}

function row(id: string, invoiceId: string, amount: number, extra: Partial<AllocationRow> = {}) {
  return {
    id,
    invoiceId,
    sourceType: "payment",
    sourceId: "pay-1",
    amountPaise: paise(amount),
    reversalId: null,
    ...extra,
  } satisfies AllocationRow;
}

describe("reverse()", () => {
  it("cancels every allocation with a negative row, ordered by the original row id", () => {
    const rows = Object.freeze([row("al-2", "inv-nov", 15_000), row("al-1", "inv-oct", 45_000)]);
    expect(unwrap(reverse(payment(60_000), rows))).toEqual({
      allocations: [
        {
          sourceType: "payment",
          sourceId: "pay-1",
          invoiceId: "inv-oct",
          amountPaise: -45_000,
          reversesAllocationId: "al-1",
        },
        {
          sourceType: "payment",
          sourceId: "pay-1",
          invoiceId: "inv-nov",
          amountPaise: -15_000,
          reversesAllocationId: "al-2",
        },
      ],
      deallocatedPaise: 60_000,
      ledgerDeltaPaise: 60_000,
      creditDeltaPaise: 0,
    });
    // The originals are untouched (append-only).
    expect(rows[0]?.amountPaise).toBe(15_000);
  });

  it("reverses a partially allocated payment: the remainder leaves the customer's credit", () => {
    const result = unwrap(reverse(payment(100_000), [row("al-1", "inv-oct", 45_000)]));
    expect(result.allocations).toHaveLength(1);
    expect(result.deallocatedPaise).toBe(45_000);
    expect(result.ledgerDeltaPaise).toBe(100_000);
    expect(result.creditDeltaPaise).toBe(-55_000);
  });

  it("reverses an all-credit payment (nothing was owed): no rows, credit falls by the amount", () => {
    expect(unwrap(reverse(payment(20_000), []))).toEqual({
      allocations: [],
      deallocatedPaise: 0,
      ledgerDeltaPaise: 20_000,
      creditDeltaPaise: -20_000,
    });
  });

  it("also cancels rows from credit application (the payment's remainder paid a later bill)", () => {
    // 500 paid with nothing owed → credit; a later 300 bill took it via applyCredit().
    const result = unwrap(reverse(payment(500), [row("al-9", "inv-later", 300)]));
    expect(result.allocations.map((a) => a.amountPaise)).toEqual([-300]);
    expect(result.creditDeltaPaise).toBe(-200);
  });

  it("ignores zero rows (nothing to cancel)", () => {
    const result = unwrap(reverse(payment(100), [row("al-0", "inv", 0), row("al-1", "inv", 100)]));
    expect(result.allocations.map((a) => a.reversesAllocationId)).toEqual(["al-1"]);
  });

  it("refuses a second reversal (CONFLICT)", () => {
    expect(reverse(payment(100, true), [])).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(
      reverse(payment(100), [
        row("al-1", "inv", 100),
        row("al-2", "inv", -100, { reversalId: "r" }),
      ]),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(reverse(payment(100), [row("al-1", "inv", 100, { reversalId: "r" })])).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
  });

  it("refuses rows of another source, repeated or malformed rows (VALIDATION)", () => {
    for (const rows of [
      [row("al-1", "inv", 10, { sourceId: "pay-2" })],
      [row("al-1", "inv", 10, { sourceType: "credit_adjustment" })],
      [row("al-1", "inv", 10), row("al-1", "inv", 10)],
      [row("", "inv", 10)],
    ]) {
      expect(reverse(payment(100), rows)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
    }
    expect(reverse({ id: "", amountPaise: paise(1), reversed: false }, [])).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(reverse(payment(0), [])).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("refuses rows adding up to more than the payment (INVARIANT_VIOLATION: invariant 1)", () => {
    expect(reverse(payment(100), [row("al-1", "a", 60), row("al-2", "b", 60)])).toMatchObject({
      ok: false,
      error: { code: "INVARIANT_VIOLATION" },
    });
  });
});

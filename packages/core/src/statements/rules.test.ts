import { businessDate, toPaise } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { resolveStatementRange, runningBalance, statementTotals } from "./rules";
import type { StatementLineType } from "./types";

const d = businessDate;
const entry = (seq: number, type: StatementLineType, amount: number) => ({
  seq,
  type,
  amountPaise: toPaise(amount),
});

describe("resolveStatementRange", () => {
  const today = d("2026-11-15");

  it("defaults to everything up to today, as of now", () => {
    expect(resolveStatementRange({}, today)).toEqual({
      from: null,
      to: today,
      today,
      asOfNow: true,
      startsAt: null,
      endsBefore: null,
    });
  });

  it("uses IST day boundaries: 00:00 IST is 18:30 UTC the day before", () => {
    const range = resolveStatementRange({ from: d("2026-10-01"), to: d("2026-10-31") }, today);
    expect(range.asOfNow).toBe(false);
    expect(range.startsAt?.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(range.endsBefore?.toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });

  it("never ends after today, and a range ending today has no upper bound", () => {
    const future = resolveStatementRange({ from: d("2026-11-01"), to: d("2027-01-31") }, today);
    expect(future.to).toBe(today);
    expect(future.asOfNow).toBe(true);
    expect(future.endsBefore).toBeNull();
    expect(future.startsAt?.toISOString()).toBe("2026-10-31T18:30:00.000Z");
    const toToday = resolveStatementRange({ to: today }, today);
    expect(toToday).toMatchObject({ asOfNow: true, endsBefore: null });
  });

  it("refuses a range that starts after it ends", () => {
    expect(() =>
      resolveStatementRange({ from: d("2026-11-02"), to: d("2026-11-01") }, today),
    ).toThrow(RangeError);
    // A from after today with no to: to becomes today, so from is after to.
    expect(() => resolveStatementRange({ from: d("2026-12-01") }, today)).toThrow(RangeError);
  });
});

describe("runningBalance", () => {
  it("adds each line to the opening balance in posting order", () => {
    const result = runningBalance(toPaise(-5_000), [
      entry(7, "payment", -30_000),
      entry(3, "invoice", 50_000),
      entry(9, "payment_reversal", 30_000),
    ]);
    expect(result.lines.map((line) => [line.seq, line.balanceAfterPaise])).toEqual([
      [3, 45_000],
      [7, 15_000],
      [9, 45_000],
    ]);
    expect(result.openingBalancePaise).toBe(-5_000);
    expect(result.closingBalancePaise).toBe(45_000);
    expect(result.hiddenLines).toBe(0);
  });

  it("closing is the opening with no lines", () => {
    const result = runningBalance(toPaise(12_300), []);
    expect(result.lines).toEqual([]);
    expect(result.closingBalancePaise).toBe(12_300);
  });

  it("folds the oldest lines into the opening balance beyond the limit, keeping the balances exact", () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(index + 1, "invoice", 1_000));
    const result = runningBalance(toPaise(500), entries, 4);
    expect(result.hiddenLines).toBe(6);
    expect(result.openingBalancePaise).toBe(500 + 6_000);
    expect(result.lines.map((line) => line.seq)).toEqual([7, 8, 9, 10]);
    expect(result.lines.map((line) => line.balanceAfterPaise)).toEqual([
      7_500, 8_500, 9_500, 10_500,
    ]);
    expect(result.closingBalancePaise).toBe(10_500);
    // Totals still cover every line of the range.
    expect(result.totals.billedPaise).toBe(10_000);
  });
});

describe("statementTotals", () => {
  it("sums each kind as a positive amount", () => {
    expect(
      statementTotals([
        entry(1, "opening_balance", 15_000),
        entry(2, "invoice", 50_000),
        entry(3, "debit_adjustment", 2_500),
        entry(4, "credit_adjustment", -5_000),
        entry(5, "payment", -30_000),
        entry(6, "payment", -10_000),
        entry(7, "payment_reversal", 30_000),
      ]),
    ).toEqual({
      billedPaise: 67_500,
      paidPaise: 40_000,
      undonePaise: 30_000,
      discountPaise: 5_000,
    });
  });
});

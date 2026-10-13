import { describe, expect, it } from "vitest";
import { type Paise, rupeesToPaise } from "../money";
import { unwrap } from "../result";
import { period } from "../time";
import { midMonthStartAdjustment, midMonthStartForPeriod } from "./mid-month-start";
import type { MidMonthStartPolicy, RentalChargeRecord } from "./types";

const OCT = period("2026-10-01");
const VC = "asg-1";
const rs = rupeesToPaise;

describe("midMonthStartAdjustment (D-18, PLAN §8.3)", () => {
  it.each([
    {
      name: "charge_full_month, started after the run → debit for the full rental",
      policy: "charge_full_month",
      startedAfterRun: true,
      rental: 450,
      expected: { kind: "debit", amountPaise: rs(450) },
    },
    {
      name: "start_next_month, started after the run → nothing now",
      policy: "start_next_month",
      startedAfterRun: true,
      rental: 450,
      expected: { kind: "none", reason: "start_next_month" },
    },
    {
      name: "charge_full_month, on the 1st before the run → the run bills it",
      policy: "charge_full_month",
      startedAfterRun: false,
      rental: 450,
      expected: { kind: "none", reason: "billed_by_run" },
    },
    {
      name: "start_next_month, on the 1st before the run → the run bills it",
      policy: "start_next_month",
      startedAfterRun: false,
      rental: 450,
      expected: { kind: "none", reason: "billed_by_run" },
    },
    {
      name: "charge_full_month with a ₹0 rental → nothing to charge",
      policy: "charge_full_month",
      startedAfterRun: true,
      rental: 0,
      expected: { kind: "none", reason: "zero_rental" },
    },
  ])("$name", ({ policy, startedAfterRun, rental, expected }) => {
    expect(
      unwrap(
        midMonthStartAdjustment({
          policy: policy as MidMonthStartPolicy,
          rentalPaise: rs(rental),
          startedAfterRun,
        }),
      ),
    ).toEqual(expected);
  });

  it("charges the full month, never a part (no proration, exact paise)", () => {
    expect(
      unwrap(
        midMonthStartAdjustment({
          policy: "charge_full_month",
          rentalPaise: 33_350 as Paise,
          startedAfterRun: true,
        }),
      ),
    ).toEqual({ kind: "debit", amountPaise: 33_350 });
  });

  it.each([
    { name: "an unknown policy", policy: "prorate", rental: 100, after: true, field: "policy" },
    {
      name: "a negative rental",
      policy: "charge_full_month",
      rental: -1,
      after: true,
      field: "rentalPaise",
    },
    {
      name: "a fractional rental",
      policy: "charge_full_month",
      rental: 0.5,
      after: true,
      field: "rentalPaise",
    },
    {
      name: "a missing flag",
      policy: "charge_full_month",
      rental: 100,
      after: undefined,
      field: "startedAfterRun",
    },
  ])("refuses $name with VALIDATION", ({ policy, rental, after, field }) => {
    const result = midMonthStartAdjustment({
      policy: policy as MidMonthStartPolicy,
      rentalPaise: rental as Paise,
      startedAfterRun: after as boolean,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.details).toMatchObject({ field });
    }
  });
});

describe("midMonthStartForPeriod", () => {
  const base = {
    assignmentId: VC,
    period: OCT,
    rentalPaise: rs(450),
    startedAfterRun: true,
  } as const;

  it("new connection on 15 Oct, charge_full_month → a mid_month_start debit for October", () => {
    expect(
      unwrap(midMonthStartForPeriod({ ...base, records: [], policy: "charge_full_month" })),
    ).toEqual({
      outcome: { kind: "debit", amountPaise: rs(450) },
      draft: {
        assignmentId: VC,
        period: OCT,
        direction: "debit",
        amountPaise: rs(450),
        source: "mid_month_start",
      },
      chargedBeforePaise: 0,
      chargedAfterPaise: rs(450),
    });
  });

  it("new connection on 15 Oct, start_next_month → nothing for October", () => {
    expect(
      unwrap(midMonthStartForPeriod({ ...base, records: [], policy: "start_next_month" })),
    ).toEqual({
      outcome: { kind: "none", reason: "start_next_month" },
      draft: null,
      chargedBeforePaise: 0,
      chargedAfterPaise: 0,
    });
  });

  it("reactivation in the month it was billed (active on the 1st, suspended, back on) → not charged twice", () => {
    const records: RentalChargeRecord[] = [
      { kind: "rent", id: "line-oct", assignmentId: VC, period: OCT, amountPaise: rs(450) },
    ];
    const decision = unwrap(
      midMonthStartForPeriod({ ...base, records, policy: "charge_full_month" }),
    );
    expect(decision.outcome).toEqual({ kind: "none", reason: "already_charged" });
    expect(decision.draft).toBeNull();
    expect(decision.chargedAfterPaise).toBe(rs(450));
  });

  it("a second reactivation (or a retry) in the same month → not charged twice", () => {
    const first = unwrap(
      midMonthStartForPeriod({ ...base, records: [], policy: "charge_full_month" }),
    );
    const records: RentalChargeRecord[] = first.draft
      ? [{ kind: "adjustment", id: "mms-1", ...first.draft }]
      : [];
    const second = unwrap(
      midMonthStartForPeriod({ ...base, records, policy: "charge_full_month" }),
    );
    expect(second.outcome).toEqual({ kind: "none", reason: "already_charged" });
  });

  it("reactivation after a plan change the same month → already charged at the new amount", () => {
    const records: RentalChargeRecord[] = [
      { kind: "rent", id: "l", assignmentId: VC, period: OCT, amountPaise: rs(400) },
      {
        kind: "adjustment",
        id: "pc",
        assignmentId: VC,
        period: OCT,
        direction: "debit",
        amountPaise: rs(50),
        source: "plan_change",
      },
    ];
    const decision = unwrap(
      midMonthStartForPeriod({ ...base, records, policy: "charge_full_month" }),
    );
    expect(decision.outcome).toEqual({ kind: "none", reason: "already_charged" });
    expect(decision.chargedAfterPaise).toBe(rs(450));
  });

  it("a manual adjustment alone does not count as rent", () => {
    const records: RentalChargeRecord[] = [
      {
        kind: "adjustment",
        id: "m",
        assignmentId: VC,
        period: OCT,
        direction: "debit",
        amountPaise: rs(100),
        source: "manual",
      },
    ];
    const decision = unwrap(
      midMonthStartForPeriod({ ...base, records, policy: "charge_full_month" }),
    );
    expect(decision.outcome).toEqual({ kind: "debit", amountPaise: rs(450) });
  });

  it("validates the policy before looking at the records", () => {
    const result = midMonthStartForPeriod({
      ...base,
      records: [],
      policy: "half" as MidMonthStartPolicy,
    });
    expect(result.ok).toBe(false);
  });

  it("reports stored records that already break the rules", () => {
    const records: RentalChargeRecord[] = [
      { kind: "rent", id: "l1", assignmentId: VC, period: OCT, amountPaise: rs(450) },
      { kind: "rent", id: "l2", assignmentId: VC, period: OCT, amountPaise: rs(450) },
    ];
    const result = midMonthStartForPeriod({ ...base, records, policy: "charge_full_month" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVARIANT_VIOLATION");
  });
});

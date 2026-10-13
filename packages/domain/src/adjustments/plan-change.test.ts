import { describe, expect, it } from "vitest";
import { type Paise, paise, rupeesToPaise, sumPaise } from "../money";
import { unwrap } from "../result";
import { period } from "../time";
import { midMonthStartForPeriod } from "./mid-month-start";
import { signedAdjustmentPaise } from "./outcome";
import { planChangeAdjustment, planChangeForPeriod } from "./plan-change";
import type { AdjustmentDraft, AdjustmentSource, RentalChargeRecord } from "./types";

const OCT = period("2026-10-01");
const VC = "asg-1";
const rs = rupeesToPaise;

function rent(id: string, amount: Paise): RentalChargeRecord {
  return { kind: "rent", id, assignmentId: VC, period: OCT, amountPaise: amount };
}

function adjustment(
  id: string,
  direction: "debit" | "credit",
  amount: Paise,
  source: AdjustmentSource = "plan_change",
): RentalChargeRecord {
  return {
    kind: "adjustment",
    id,
    assignmentId: VC,
    period: OCT,
    direction,
    amountPaise: amount,
    source,
  };
}

function stored(id: string, draft: AdjustmentDraft): RentalChargeRecord {
  return { kind: "adjustment", id, ...draft };
}

/** Σ rent line + plan_change / mid_month_start adjustments (+debit −credit): the period's rent. */
function rentFor(records: readonly RentalChargeRecord[]): Paise {
  return sumPaise(
    records.map((r) => {
      if (r.kind === "rent") return r.amountPaise;
      if (r.source === "manual" || r.source === "migration") return paise(0);
      return r.direction === "debit" ? r.amountPaise : paise(-r.amountPaise);
    }),
  );
}

/** Applies plan changes one after another, storing every draft the way T-045 will. */
function changePlan(records: RentalChargeRecord[], amounts: readonly Paise[]) {
  const outcomes = [];
  for (const [index, newAmountPaise] of amounts.entries()) {
    const decision = unwrap(
      planChangeForPeriod({ assignmentId: VC, period: OCT, records, newAmountPaise }),
    );
    outcomes.push(decision.outcome);
    if (decision.draft) records.push(stored(`pc-${index}`, decision.draft));
  }
  return outcomes;
}

describe("planChangeAdjustment (the netting rule, PLAN §8.3)", () => {
  it.each([
    {
      name: "upgrade after the bill",
      soFar: 300,
      next: 450,
      expected: { kind: "debit", amountPaise: rs(150) },
    },
    {
      name: "downgrade after the bill",
      soFar: 450,
      next: 300,
      expected: { kind: "credit", amountPaise: rs(150) },
    },
    {
      name: "same amount",
      soFar: 400,
      next: 400,
      expected: { kind: "none", reason: "same_amount" },
    },
    {
      name: "to a ₹0 plan",
      soFar: 400,
      next: 0,
      expected: { kind: "credit", amountPaise: rs(400) },
    },
    {
      name: "from ₹0 rent",
      soFar: 0,
      next: 250,
      expected: { kind: "debit", amountPaise: rs(250) },
    },
    { name: "₹0 to ₹0", soFar: 0, next: 0, expected: { kind: "none", reason: "same_amount" } },
  ])("$name: ₹$soFar → ₹$next", ({ soFar, next, expected }) => {
    expect(
      unwrap(planChangeAdjustment({ chargedSoFarPaise: rs(soFar), newAmountPaise: rs(next) })),
    ).toEqual(expected);
  });

  it("is exact in paise (no rounding anywhere)", () => {
    expect(
      unwrap(
        planChangeAdjustment({ chargedSoFarPaise: paise(40_050), newAmountPaise: paise(45_025) }),
      ),
    ).toEqual({ kind: "debit", amountPaise: 4_975 });
  });

  it.each([
    { name: "negative new amount", soFar: 0, next: -100, field: "newAmountPaise" },
    { name: "fractional new amount", soFar: 0, next: 1.5, field: "newAmountPaise" },
    { name: "negative charged so far", soFar: -100, next: 0, field: "chargedSoFarPaise" },
    { name: "NaN charged so far", soFar: Number.NaN, next: 0, field: "chargedSoFarPaise" },
  ])("refuses $name with VALIDATION", ({ soFar, next, field }) => {
    const result = planChangeAdjustment({
      chargedSoFarPaise: soFar as Paise,
      newAmountPaise: next as Paise,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.details).toEqual({ field });
    }
  });
});

describe("planChangeForPeriod: named cases (PLAN §8.3, D-14, BR-07)", () => {
  it("acceptance (PRD §15 #5): three plan changes in one month end with total charged = latest plan amount", () => {
    // Billed ₹400 on 1 Oct; the customer changes plan three times in October.
    const records = [rent("line-oct", rs(400))];
    const outcomes = changePlan(records, [rs(500), rs(300), rs(450)]);

    expect(outcomes).toEqual([
      { kind: "debit", amountPaise: rs(100) },
      { kind: "credit", amountPaise: rs(200) },
      { kind: "debit", amountPaise: rs(150) },
    ]);
    expect(rentFor(records)).toBe(rs(450));
    // The issued invoice's line is untouched: the corrections are separate adjustments.
    expect(records[0]).toEqual(rent("line-oct", rs(400)));
    expect(records.filter((r) => r.kind === "rent")).toHaveLength(1);
  });

  it("an upgrade after the bill is one debit adjustment for the difference, for this connection and month", () => {
    const decision = unwrap(
      planChangeForPeriod({
        assignmentId: VC,
        period: OCT,
        records: [rent("l", rs(300))],
        newAmountPaise: rs(450),
      }),
    );
    expect(decision).toEqual({
      outcome: { kind: "debit", amountPaise: rs(150) },
      draft: {
        assignmentId: VC,
        period: OCT,
        direction: "debit",
        amountPaise: rs(150),
        source: "plan_change",
      },
      chargedBeforePaise: rs(300),
      chargedAfterPaise: rs(450),
    });
    expect(signedAdjustmentPaise(decision.outcome)).toBe(rs(150));
  });

  it("a downgrade after the bill is a credit adjustment", () => {
    const decision = unwrap(
      planChangeForPeriod({
        assignmentId: VC,
        period: OCT,
        records: [rent("l", rs(450))],
        newAmountPaise: rs(300),
      }),
    );
    expect(decision.draft).toEqual({
      assignmentId: VC,
      period: OCT,
      direction: "credit",
      amountPaise: rs(150),
      source: "plan_change",
    });
    expect(signedAdjustmentPaise(decision.outcome)).toBe(paise(-15_000));
  });

  it("changing back to the billed plan nets to zero: no double charge", () => {
    const records = [rent("l", rs(400))];
    expect(changePlan(records, [rs(500), rs(400)])).toEqual([
      { kind: "debit", amountPaise: rs(100) },
      { kind: "credit", amountPaise: rs(100) },
    ]);
    expect(rentFor(records)).toBe(rs(400));
  });

  it("a change to the amount already charged needs nothing", () => {
    const records = [rent("l", rs(400)), adjustment("a1", "debit", rs(100))];
    const decision = unwrap(
      planChangeForPeriod({ assignmentId: VC, period: OCT, records, newAmountPaise: rs(500) }),
    );
    expect(decision.outcome).toEqual({ kind: "none", reason: "same_amount" });
    expect(decision.draft).toBeNull();
  });

  it("a retry after the adjustment was stored adds nothing (idempotent)", () => {
    const records = [rent("l", rs(400))];
    changePlan(records, [rs(550)]);
    expect(changePlan(records, [rs(550), rs(550)])).toEqual([
      { kind: "none", reason: "same_amount" },
      { kind: "none", reason: "same_amount" },
    ]);
    expect(records).toHaveLength(2);
  });

  it("before the period's bill (no rent yet) needs nothing: the next run charges the new amount", () => {
    const decision = unwrap(
      planChangeForPeriod({ assignmentId: VC, period: OCT, records: [], newAmountPaise: rs(500) }),
    );
    expect(decision).toEqual({
      outcome: { kind: "none", reason: "not_billed_this_period" },
      draft: null,
      chargedBeforePaise: 0,
      chargedAfterPaise: 0,
    });
  });

  it("a start_next_month connection that changes plan in its first month is still not charged this month", () => {
    const start = unwrap(
      midMonthStartForPeriod({
        assignmentId: VC,
        period: OCT,
        records: [],
        policy: "start_next_month",
        rentalPaise: rs(300),
        startedAfterRun: true,
      }),
    );
    expect(start.draft).toBeNull();
    const records: RentalChargeRecord[] = [];
    expect(changePlan(records, [rs(450), rs(200)])).toEqual([
      { kind: "none", reason: "not_billed_this_period" },
      { kind: "none", reason: "not_billed_this_period" },
    ]);
  });

  it("a charge_full_month connection nets plan changes against its mid-month charge", () => {
    const start = unwrap(
      midMonthStartForPeriod({
        assignmentId: VC,
        period: OCT,
        records: [],
        policy: "charge_full_month",
        rentalPaise: rs(300),
        startedAfterRun: true,
      }),
    );
    expect(start.draft).not.toBeNull();
    const records = start.draft ? [stored("mms", start.draft)] : [];
    expect(changePlan(records, [rs(450), rs(350)])).toEqual([
      { kind: "debit", amountPaise: rs(150) },
      { kind: "credit", amountPaise: rs(100) },
    ]);
    expect(rentFor(records)).toBe(rs(350));
  });

  it("counts earlier adjustments whether they are still pending or already billed", () => {
    // a1 was billed on November's invoice, a2 is still pending: both are rent for October.
    const records = [
      rent("l", rs(400)),
      adjustment("a1", "debit", rs(200)),
      adjustment("a2", "credit", rs(50)),
    ];
    const decision = unwrap(
      planChangeForPeriod({ assignmentId: VC, period: OCT, records, newAmountPaise: rs(600) }),
    );
    expect(decision.chargedBeforePaise).toBe(rs(550));
    expect(decision.outcome).toEqual({ kind: "debit", amountPaise: rs(50) });
  });

  it("leaves manual and migration adjustments standing (interpretation: they are not rent)", () => {
    // The Owner gave ₹50 off October for an outage, then the customer upgraded ₹400 → ₹500.
    const records = [
      rent("l", rs(400)),
      adjustment("discount", "credit", rs(50), "manual"),
      adjustment("legacy", "debit", rs(30), "migration"),
    ];
    const decision = unwrap(
      planChangeForPeriod({ assignmentId: VC, period: OCT, records, newAmountPaise: rs(500) }),
    );
    expect(decision.outcome).toEqual({ kind: "debit", amountPaise: rs(100) });
    expect(decision.chargedBeforePaise).toBe(rs(400));
  });

  it("goes to a ₹0 plan and back", () => {
    const records = [rent("l", rs(400))];
    expect(changePlan(records, [rs(0), rs(250)])).toEqual([
      { kind: "credit", amountPaise: rs(400) },
      { kind: "debit", amountPaise: rs(250) },
    ]);
    expect(rentFor(records)).toBe(rs(250));
  });

  it("does not depend on the order of the records", () => {
    const records = [
      rent("l", rs(400)),
      adjustment("a1", "debit", rs(100)),
      adjustment("a2", "credit", rs(300)),
    ];
    const forward = planChangeForPeriod({
      assignmentId: VC,
      period: OCT,
      records,
      newAmountPaise: rs(350),
    });
    const backward = planChangeForPeriod({
      assignmentId: VC,
      period: OCT,
      records: [...records].reverse(),
      newAmountPaise: rs(350),
    });
    expect(backward).toEqual(forward);
    expect(unwrap(forward).outcome).toEqual({ kind: "debit", amountPaise: rs(150) });
  });

  it("does not mutate its input", () => {
    const records = Object.freeze([Object.freeze(rent("l", rs(400)))]);
    expect(() =>
      planChangeForPeriod({ assignmentId: VC, period: OCT, records, newAmountPaise: rs(500) }),
    ).not.toThrow();
  });
});

describe("planChangeForPeriod: errors", () => {
  const cases: { name: string; records: RentalChargeRecord[]; newAmount?: number; code: string }[] =
    [
      {
        name: "negative new amount",
        records: [rent("l", rs(400))],
        newAmount: -1,
        code: "VALIDATION",
      },
      {
        name: "a record of another assignment",
        records: [{ ...rent("l", rs(400)), assignmentId: "asg-2" }],
        code: "VALIDATION",
      },
      {
        name: "a record of another period",
        records: [{ ...rent("l", rs(400)), period: period("2026-11-01") }],
        code: "VALIDATION",
      },
      {
        name: "a repeated id",
        records: [rent("l", rs(400)), adjustment("l", "debit", rs(1))],
        code: "VALIDATION",
      },
      { name: "an empty id", records: [rent("", rs(400))], code: "VALIDATION" },
      { name: "a negative rent line", records: [rent("l", paise(-1))], code: "VALIDATION" },
      {
        name: "a zero adjustment",
        records: [rent("l", rs(400)), adjustment("a", "debit", rs(0))],
        code: "VALIDATION",
      },
      {
        name: "an unknown source",
        records: [rent("l", rs(400)), adjustment("a", "debit", rs(1), "gift" as AdjustmentSource)],
        code: "VALIDATION",
      },
      {
        name: "an unknown direction",
        records: [
          rent("l", rs(400)),
          { ...adjustment("a", "debit", rs(1)), direction: "up" as "debit" } as RentalChargeRecord,
        ],
        code: "VALIDATION",
      },
      {
        name: "two rent lines",
        records: [rent("l1", rs(400)), rent("l2", rs(400))],
        code: "INVARIANT_VIOLATION",
      },
      {
        name: "a rent line and a mid-month charge (charged twice)",
        records: [rent("l", rs(400)), adjustment("m", "debit", rs(400), "mid_month_start")],
        code: "INVARIANT_VIOLATION",
      },
      {
        name: "a mid-month credit",
        records: [adjustment("m", "credit", rs(400), "mid_month_start")],
        code: "INVARIANT_VIOLATION",
      },
      {
        name: "plan-change adjustments without rent",
        records: [adjustment("a", "debit", rs(100))],
        code: "INVARIANT_VIOLATION",
      },
      {
        name: "rent that nets below zero",
        records: [rent("l", rs(400)), adjustment("a", "credit", rs(401))],
        code: "INVARIANT_VIOLATION",
      },
    ];

  it.each(cases)("$name → $code", ({ records, newAmount, code }) => {
    const result = planChangeForPeriod({
      assignmentId: VC,
      period: OCT,
      records,
      newAmountPaise: (newAmount ?? rs(500)) as Paise,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

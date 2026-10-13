/**
 * Acceptance (T-042, PRD §15 #5): any sequence of plan changes in one month ends with the
 * connection's rent for that month equal to the latest plan amount, never more (no double
 * charge), and the issued bill is never touched.
 *
 * A small model of one connection's month drives the functions the way T-045 / T-044 will: every
 * adjustment it stores is a draft returned by `planChangeForPeriod` or `midMonthStartForPeriod`,
 * and the billing run (T-044) writes one rent line at the then-current rental. The records are
 * handed to the functions in a random order each time.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { absPaise, isWholeRupees, type Paise, paise, subtractPaise, sumPaise } from "../money";
import { unwrap } from "../result";
import { period } from "../time";
import { rentalChargedSoFar } from "./charged-so-far";
import { midMonthStartForPeriod } from "./mid-month-start";
import { signedAdjustmentPaise } from "./outcome";
import { planChangeForPeriod } from "./plan-change";
import type { AdjustmentDirection, MidMonthStartPolicy, RentalChargeRecord } from "./types";

const OCT = period("2026-10-01");
const VC = "asg-1";

type Step =
  | { readonly type: "plan"; readonly amountPaise: Paise }
  | { readonly type: "retry" }
  | {
      readonly type: "manual";
      readonly direction: AdjustmentDirection;
      readonly amountPaise: Paise;
    }
  | { readonly type: "run" }
  /** Suspended and switched back on (or a retried start) later in the same month. */
  | { readonly type: "reactivate" };

type Scenario =
  /** Active on 1 Oct: the October run bills it (the run may come before, between or after changes). */
  | {
      readonly kind: "active_on_first";
      readonly rentalPaise: Paise;
      readonly steps: readonly Step[];
    }
  /** Starts (or reactivates) mid-October, after the run, under the operator's policy. */
  | {
      readonly kind: "mid_month";
      readonly policy: MidMonthStartPolicy;
      readonly rentalPaise: Paise;
      readonly steps: readonly Step[];
    }
  /** Not billable in October (suspended on the 1st, or no start at all yet). */
  | { readonly kind: "not_billable"; readonly rentalPaise: Paise; readonly steps: readonly Step[] };

// Mostly whole rupees (D-17), sometimes raw paise, with many repeats so "same amount" happens.
const amount = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(0, 200, 300, 350, 400, 450, 500).map((r) => paise(r * 100)),
  },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 5_000 }).map((r) => paise(r * 100)) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 500_000 }).map(paise) },
);

const changeSteps = fc.array(
  fc.oneof(
    { weight: 8, arbitrary: amount.map((a): Step => ({ type: "plan", amountPaise: a })) },
    { weight: 1, arbitrary: fc.constant<Step>({ type: "retry" }) },
    { weight: 1, arbitrary: fc.constant<Step>({ type: "reactivate" }) },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant("manual" as const),
        direction: fc.constantFrom<AdjustmentDirection>("debit", "credit"),
        amountPaise: fc.integer({ min: 1, max: 100_000 }).map(paise),
      }),
    },
  ),
  { minLength: 1, maxLength: 12 },
);

const scenario: fc.Arbitrary<Scenario> = fc.oneof(
  fc
    .tuple(amount, changeSteps, fc.nat(), fc.boolean())
    .map(([rentalPaise, steps, at, runs]): Scenario => {
      const withRun = [...steps];
      if (runs) withRun.splice(at % (steps.length + 1), 0, { type: "run" });
      return { kind: "active_on_first", rentalPaise, steps: withRun };
    }),
  fc.record({
    kind: fc.constant("mid_month" as const),
    policy: fc.constantFrom<MidMonthStartPolicy>("charge_full_month", "start_next_month"),
    rentalPaise: amount,
    steps: changeSteps,
  }),
  fc.record({
    kind: fc.constant("not_billable" as const),
    rentalPaise: amount,
    steps: changeSteps,
  }),
);

/** The period's rent as the definition says: rent line + plan_change/mid_month_start, signed. */
function nettedRent(records: readonly RentalChargeRecord[]): Paise {
  return sumPaise(
    records
      .filter(
        (r) => r.kind === "rent" || r.source === "plan_change" || r.source === "mid_month_start",
      )
      .map((r) =>
        r.kind === "rent" || r.direction === "debit" ? r.amountPaise : paise(-r.amountPaise),
      ),
  );
}

function shuffled<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, index) => ({ item, key: keys[index % Math.max(keys.length, 1)] ?? 0, index }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map(({ item }) => item);
}

const coverage = {
  debit: 0,
  credit: 0,
  same: 0,
  notBilled: 0,
  billedEnd: 0,
  unbilledEnd: 0,
  runAfterChange: 0,
  midMonthCharged: 0,
  threeOrMoreChanges: 0,
  reactivateAlreadyCharged: 0,
  reactivateCharges: 0,
};

describe("plan-change netting (property)", () => {
  it("any sequence of changes in one month ends with rent = the latest plan amount", () => {
    fc.assert(
      fc.property(scenario, fc.array(fc.integer(), { maxLength: 40 }), (sc, orderKeys) => {
        const records: RentalChargeRecord[] = [];
        let seq = 0;
        let rental = sc.rentalPaise;
        let lastPlan: Paise | null = null;
        let changesBeforeRun = 0;
        let planChanges = 0;
        const manual: RentalChargeRecord[] = [];
        const view = () => shuffled(records, orderKeys);

        if (sc.kind === "mid_month") {
          const start = unwrap(
            midMonthStartForPeriod({
              assignmentId: VC,
              period: OCT,
              records: view(),
              policy: sc.policy,
              rentalPaise: rental,
              startedAfterRun: true,
            }),
          );
          if (sc.policy === "charge_full_month" && rental > 0) {
            expect(start.draft).toEqual({
              assignmentId: VC,
              period: OCT,
              direction: "debit",
              amountPaise: rental,
              source: "mid_month_start",
            });
            coverage.midMonthCharged++;
          } else {
            expect(start.draft).toBeNull();
          }
          if (start.draft) records.push({ kind: "adjustment", id: `a-${seq++}`, ...start.draft });
        }

        for (const step of sc.steps) {
          if (step.type === "run") {
            // T-044: the run bills an eligible connection once, at its current rental.
            records.push({
              kind: "rent",
              id: `line-${seq++}`,
              assignmentId: VC,
              period: OCT,
              amountPaise: rental,
            });
            if (changesBeforeRun > 0) coverage.runAfterChange++;
            continue;
          }
          if (step.type === "reactivate") {
            // Before the run, an active-on-the-1st connection is still billed by the run itself.
            const startedAfterRun =
              sc.kind !== "active_on_first" || records.some((r) => r.kind === "rent");
            const policy = sc.kind === "mid_month" ? sc.policy : "charge_full_month";
            const charged = unwrap(
              rentalChargedSoFar({ assignmentId: VC, period: OCT, records: view() }),
            ).charged;
            const decision = unwrap(
              midMonthStartForPeriod({
                assignmentId: VC,
                period: OCT,
                records: view(),
                policy,
                rentalPaise: rental,
                startedAfterRun,
              }),
            );
            if (charged) {
              expect(decision.outcome).toEqual({ kind: "none", reason: "already_charged" });
              coverage.reactivateAlreadyCharged++;
            } else if (startedAfterRun && policy === "charge_full_month" && rental > 0) {
              expect(decision.outcome).toEqual({ kind: "debit", amountPaise: rental });
              coverage.reactivateCharges++;
            } else {
              expect(decision.draft).toBeNull();
            }
            if (decision.draft)
              records.push({ kind: "adjustment", id: `a-${seq++}`, ...decision.draft });
            continue;
          }
          if (step.type === "manual") {
            const record: RentalChargeRecord = {
              kind: "adjustment",
              id: `m-${seq++}`,
              assignmentId: VC,
              period: OCT,
              direction: step.direction,
              amountPaise: step.amountPaise,
              source: "manual",
            };
            records.push(record);
            manual.push(record);
            continue;
          }
          const newAmount: Paise = step.type === "plan" ? step.amountPaise : (lastPlan ?? rental);
          const before = nettedRent(records);
          const charged = unwrap(
            rentalChargedSoFar({ assignmentId: VC, period: OCT, records: view() }),
          ).charged;
          const decision = unwrap(
            planChangeForPeriod({
              assignmentId: VC,
              period: OCT,
              records: view(),
              newAmountPaise: newAmount,
            }),
          );

          if (!charged) {
            // Nothing billed yet this month: nothing now, the next bill uses the new amount.
            expect(decision.outcome).toEqual({ kind: "none", reason: "not_billed_this_period" });
            expect(decision.draft).toBeNull();
            coverage.notBilled++;
          } else {
            const delta = subtractPaise(newAmount, before);
            expect(decision.chargedBeforePaise).toBe(before);
            expect(decision.chargedAfterPaise).toBe(newAmount);
            expect(signedAdjustmentPaise(decision.outcome)).toBe(delta);
            if (delta === 0) {
              expect(decision.outcome).toEqual({ kind: "none", reason: "same_amount" });
              expect(decision.draft).toBeNull();
              coverage.same++;
            } else {
              expect(decision.draft?.amountPaise).toBe(absPaise(delta));
              expect(decision.draft?.amountPaise).toBeGreaterThan(0);
              expect(decision.draft?.direction).toBe(delta > 0 ? "debit" : "credit");
              expect(decision.draft?.source).toBe("plan_change");
              coverage[delta > 0 ? "debit" : "credit"]++;
            }
          }
          if (decision.draft)
            records.push({ kind: "adjustment", id: `a-${seq++}`, ...decision.draft });
          // After every change that hit a charged month, the month's rent is exactly the new amount.
          if (charged) expect(nettedRent(records)).toBe(newAmount);
          rental = newAmount;
          lastPlan = newAmount;
          planChanges++;
          if (!records.some((r) => r.kind === "rent")) changesBeforeRun++;
        }

        const final = unwrap(
          rentalChargedSoFar({ assignmentId: VC, period: OCT, records: view() }),
        );
        if (final.charged) {
          // PRD §15 #5: the month's rent is the latest plan amount, charged once.
          expect(final.chargedSoFarPaise).toBe(rental);
          expect(nettedRent(records)).toBe(rental);
          coverage.billedEnd++;
          if (planChanges >= 3) coverage.threeOrMoreChanges++;
        } else {
          expect(final.chargedSoFarPaise).toBe(0);
          expect(records.some((r) => r.kind === "adjustment" && r.source === "plan_change")).toBe(
            false,
          );
          coverage.unbilledEnd++;
        }
        // Exactly one base charge at most; the bill's rent line is never changed.
        const bases = records.filter((r) => r.kind === "rent" || r.source === "mid_month_start");
        expect(bases.length).toBeLessThanOrEqual(1);
        // Manual adjustments stay exactly as the Owner made them and are reported as not netted.
        expect(final.notNettedIds).toEqual(manual.map((m) => m.id).sort());
        // Every amount is whole rupees whenever every input was (D-17): nothing is ever rounded.
        const inputsWhole =
          sc.rentalPaise % 100 === 0 &&
          sc.steps.every((s) => s.type !== "plan" || isWholeRupees(s.amountPaise));
        if (inputsWhole) {
          for (const r of records)
            if (r.kind === "adjustment" && r.source !== "manual")
              expect(isWholeRupees(r.amountPaise)).toBe(true);
        }
      }),
      { numRuns: 5_000 },
    );

    // The property must not pass vacuously: every path ran many times.
    for (const [path, count] of Object.entries(coverage)) {
      expect(count, `coverage: ${path}`).toBeGreaterThan(100);
    }
  }, 60_000); // About 3 s locally; the budget leaves room for slow or busy CI runners.

  it("the result does not depend on the order of the records", () => {
    const record = (id: string, direction: AdjustmentDirection, a: number): RentalChargeRecord => ({
      kind: "adjustment",
      id,
      assignmentId: VC,
      period: OCT,
      direction,
      amountPaise: paise(a),
      source: "plan_change",
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(
          fc.integer({ min: -100_000, max: 100_000 }).filter((d) => d !== 0),
          { maxLength: 10 },
        ),
        fc.array(fc.integer(), { maxLength: 12 }),
        amount,
        (base, deltas, keys, newAmount) => {
          // Keep the running rent ≥ 0 so the records are a state the functions can produce.
          const records: RentalChargeRecord[] = [
            { kind: "rent", id: "line", assignmentId: VC, period: OCT, amountPaise: paise(base) },
          ];
          let running = base;
          for (const [i, d] of deltas.entries()) {
            if (running + d < 0) continue;
            running += d;
            records.push(record(`a${i}`, d > 0 ? "debit" : "credit", Math.abs(d)));
          }
          const input = { assignmentId: VC, period: OCT, newAmountPaise: newAmount };
          const a = planChangeForPeriod({ ...input, records });
          const b = planChangeForPeriod({ ...input, records: shuffled(records, keys) });
          expect(b).toEqual(a);
          expect(unwrap(a).chargedBeforePaise).toBe(running);
        },
      ),
      { numRuns: 2_000 },
    );
  }, 60_000);
});

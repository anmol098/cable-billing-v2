/**
 * fast-check properties for eligibility and invoice calculation (T-040 "Tests required").
 *
 * The generator builds the **true day-by-day status** of an assignment first (runs of active and
 * suspended days, optionally ending in a disconnection) and only then derives the events the way the
 * app records them: a change is dated on the last day of the old status (it takes effect at the end
 * of that day). The oracle reads the status of the 1st straight from the day-by-day truth, so it
 * shares no code with `timeline.ts`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Paise, paise, sumPaise } from "../money";
import { unwrap } from "../result";
import {
  addDays,
  addPeriods,
  type BusinessDate,
  businessDate,
  compareBusinessDates,
  type Period,
  period,
  periodEnd,
} from "../time";
import { buildInvoice } from "./invoice";
import { isBillable, rentalForPeriod } from "./timeline";
import type { AssignmentEvent, BillingAssignment, PendingAdjustment } from "./types";

const BASE = businessDate("2025-01-01");
const FIRST_PERIOD = period("2025-01-01");
const PERIOD_COUNT = 40; // Jan 2025 … Apr 2028: covers every generated day
const CUSTOMER = "cust";
const RUNS = 2_000;
/** fast-check properties can exceed Vitest's default 5 s on a busy machine. */
const TIMEOUT_MS = 60_000;

const PERIODS: readonly Period[] = Array.from({ length: PERIOD_COUNT }, (_, i) =>
  addPeriods(FIRST_PERIOD, i),
);

type Truth = "not_started" | "active" | "suspended" | "disconnected";

type Generated = {
  readonly assignment: BillingAssignment;
  /** The true status during a day, from the day-by-day model. */
  readonly truth: (date: BusinessDate) => Truth;
  /** The last day of service, if the assignment ended. */
  readonly lastDay: BusinessDate | null;
  /** Plan changes in effective order (dates are distinct). */
  readonly plans: readonly { readonly date: BusinessDate; readonly rental: Paise }[];
};

const day = (offset: number): BusinessDate => addDays(BASE, offset);

function generatedArb(id: string): fc.Arbitrary<Generated> {
  return fc
    .record({
      start: fc.integer({ min: 0, max: 400 }),
      runs: fc.array(fc.integer({ min: 1, max: 90 }), { minLength: 1, maxLength: 8 }),
      ends: fc.boolean(),
      endStyle: fc.constantFrom("event-and-date", "event-only", "date-only"),
      activated: fc.boolean(),
      initial: fc.integer({ min: 0, max: 200_000 }),
      plans: fc.array(
        fc.record({
          at: fc.integer({ min: 0, max: 700 }),
          rental: fc.integer({ min: 0, max: 200_000 }),
        }),
        { maxLength: 4 },
      ),
      order: fc.array(fc.nat(), { minLength: 32, maxLength: 32 }),
    })
    .map(({ start, runs, ends, endStyle, activated, initial, plans, order }) => {
      // Runs alternate active, suspended, active, …; run i covers [from_i, from_i + length_i − 1].
      const runStarts: number[] = [];
      let next = start;
      for (const length of runs) {
        runStarts.push(next);
        next += length;
      }
      const lastOffset = next - 1;
      const statusOfRun = (i: number): "active" | "suspended" =>
        i % 2 === 0 ? "active" : "suspended";

      const truth = (date: BusinessDate): Truth => {
        const offset = daysFromBase(date);
        if (offset < start) return "not_started";
        if (offset > lastOffset) return ends ? "disconnected" : statusOfRun(runs.length - 1);
        let run = 0;
        while (run + 1 < runStarts.length && (runStarts[run + 1] ?? Infinity) <= offset) run += 1;
        return statusOfRun(run);
      };

      const events: AssignmentEvent[] = [];
      const statusDays = new Set<number>();
      if (activated) events.push({ type: "activated", effectiveDate: day(start) });
      for (let i = 0; i + 1 < runs.length; i += 1) {
        const changeDay = (runStarts[i + 1] ?? 0) - 1; // the last day of run i
        statusDays.add(changeDay);
        events.push({
          type: statusOfRun(i) === "active" ? "suspended" : "reactivated",
          effectiveDate: day(changeDay),
        });
      }
      let endDate: BusinessDate | null = null;
      if (ends) {
        statusDays.add(lastOffset);
        if (endStyle !== "date-only")
          events.push({ type: "disconnected", effectiveDate: day(lastOffset) });
        if (endStyle !== "event-only") endDate = day(lastOffset);
      }

      // Plan changes on distinct days inside the assignment and away from status changes (so the
      // recorded order never matters and any shuffle of the events stays valid).
      const lastPlanDay = ends ? lastOffset - 1 : start + 700;
      const planDays = new Map<number, number>();
      for (const p of plans) {
        const offset = start + p.at;
        if (offset > lastPlanDay || statusDays.has(offset) || planDays.has(offset)) continue;
        planDays.set(offset, p.rental);
      }
      const planList = [...planDays.entries()]
        .sort(([a], [b]) => a - b)
        .map(([offset, rental]) => ({ date: day(offset), rental: paise(rental) }));
      for (const p of planList) {
        events.push({ type: "plan_changed", effectiveDate: p.date, rentalPaise: p.rental });
      }

      return {
        assignment: {
          id,
          customerId: CUSTOMER,
          startDate: day(start),
          endDate,
          events: shuffle(events, order),
          initialRentalPaise: paise(initial),
        },
        truth,
        lastDay: ends ? day(lastOffset) : null,
        plans: planList,
      };
    });
}

function daysFromBase(date: BusinessDate): number {
  // Count by stepping months is overkill; dates here are at most ~1,200 days from BASE.
  let low = 0;
  let high = 2_000;
  while (low < high) {
    const mid = low + ((high - low) >> 1);
    if (compareBusinessDates(day(mid), date) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A deterministic permutation driven by generated numbers. */
function shuffle<T>(items: readonly T[], order: readonly number[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = (order[i % order.length] ?? 0) % (i + 1);
    const a = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = a;
  }
  return copy;
}

function expectedRental(g: Generated, p: Period): Paise {
  let rental = g.assignment.initialRentalPaise;
  for (const plan of g.plans) {
    if (compareBusinessDates(plan.date, periodEnd(p)) <= 0) rental = plan.rental;
  }
  return rental;
}

/** Up to five assignments of one customer, with distinct ids. */
const customerArb = fc
  .array(generatedArb("x"), { maxLength: 5 })
  .map((list) =>
    list.map((g, i): Generated => ({ ...g, assignment: { ...g.assignment, id: `asg-${i}` } })),
  );

const periodArb = fc
  .integer({ min: 0, max: PERIOD_COUNT - 1 })
  .map((i) => addPeriods(FIRST_PERIOD, i));

const adjustmentsArb = fc
  .array(
    fc.record({
      amount: fc.integer({ min: 1, max: 100_000 }),
      periodIndex: fc.option(fc.integer({ min: 0, max: PERIOD_COUNT - 1 }), { nil: null }),
    }),
    { maxLength: 4 },
  )
  .map((list) =>
    list.map(
      (a, i): PendingAdjustment => ({
        id: `adj-${i}`,
        customerId: CUSTOMER,
        assignmentId: null,
        period: a.periodIndex === null ? null : addPeriods(FIRST_PERIOD, a.periodIndex),
        direction: "debit",
        amountPaise: paise(a.amount),
        source: "manual",
      }),
    ),
  );

describe("eligibility properties", () => {
  it(
    "isBillable(P) ⇔ the assignment is active during the 1st of P (day-by-day oracle)",
    () => {
      // Coverage: the boundaries must really be exercised, or the property could pass vacuously.
      const seen = {
        billed: 0,
        notBilled: 0,
        changeOnFirst: 0,
        changeOnDayBefore: 0,
        startOnFirst: 0,
      };
      fc.assert(
        fc.property(generatedArb("a"), (g) => {
          for (const p of PERIODS) {
            const billed = g.truth(p) === "active";
            expect(isBillable(g.assignment, p)).toBe(billed);
            seen[billed ? "billed" : "notBilled"] += 1;
            if (g.assignment.startDate === p) seen.startOnFirst += 1;
            for (const e of g.assignment.events) {
              if (e.type === "plan_changed" || e.type === "activated") continue;
              if (e.effectiveDate === p) seen.changeOnFirst += 1;
              if (e.effectiveDate === addDays(p, -1)) seen.changeOnDayBefore += 1;
            }
          }
        }),
        { numRuns: RUNS },
      );
      for (const count of Object.values(seen)) expect(count).toBeGreaterThan(30);
    },
    TIMEOUT_MS,
  );

  it(
    "never bills an assignment disconnected before the period",
    () => {
      fc.assert(
        fc.property(generatedArb("a"), periodArb, (g, p) => {
          fc.pre(g.lastDay !== null && compareBusinessDates(g.lastDay, p) < 0);
          expect(isBillable(g.assignment, p)).toBe(false);
          const outcome = unwrap(
            buildInvoice({
              customer: { id: CUSTOMER },
              assignments: [g.assignment],
              pendingAdjustments: [],
              openingBalancePaise: paise(0),
              period: p,
            }),
          );
          expect(outcome.outcome).toBe("nothing_to_bill");
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "changes effective on or after the 1st of P never change the answer for P",
    () => {
      fc.assert(
        fc.property(generatedArb("a"), periodArb, (g, p) => {
          const before = (date: BusinessDate) => compareBusinessDates(date, p) < 0;
          const truncated: BillingAssignment = {
            ...g.assignment,
            events: g.assignment.events.filter(
              (e) => e.type === "activated" || before(e.effectiveDate),
            ),
            endDate:
              g.assignment.endDate !== null && before(g.assignment.endDate)
                ? g.assignment.endDate
                : null,
          };
          expect(isBillable(truncated, p)).toBe(isBillable(g.assignment, p));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "rentalForPeriod is the last plan change effective by the end of P, else the initial rental",
    () => {
      fc.assert(
        fc.property(generatedArb("a"), (g) => {
          for (const p of PERIODS)
            expect(rentalForPeriod(g.assignment, p)).toBe(expectedRental(g, p));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );
});

describe("invoice properties", () => {
  it(
    "charges = Σ lines, total due = opening + charges, one rent line per billable VC at its rental",
    () => {
      fc.assert(
        fc.property(
          customerArb,
          adjustmentsArb,
          periodArb,
          fc.integer({ min: -1_000_000, max: 1_000_000 }),
          (generated, adjustments, p, opening) => {
            const outcome = unwrap(
              buildInvoice({
                customer: { id: CUSTOMER },
                assignments: generated.map((g) => g.assignment),
                pendingAdjustments: adjustments,
                openingBalancePaise: paise(opening),
                period: p,
              }),
            );
            const billable = generated.filter((g) => g.truth(p) === "active");
            const due = adjustments.filter(
              (a) => a.period === null || compareBusinessDates(a.period, p) <= 0,
            );

            if (billable.length === 0 && due.length === 0) {
              expect(outcome.outcome).toBe("nothing_to_bill");
              return;
            }
            if (outcome.outcome !== "invoice") throw new Error("expected an invoice");

            expect(outcome.chargesPaise).toBe(
              sumPaise(outcome.lines.map((line) => line.amountPaise)),
            );
            expect(outcome.totalDuePaise).toBe(opening + outcome.chargesPaise);
            expect(outcome.openingBalancePaise).toBe(opening);

            const rent = outcome.lines.filter((line) => line.type === "rent");
            expect(rent.map((line) => line.assignmentId).sort()).toEqual(
              billable.map((g) => g.assignment.id).sort(),
            );
            for (const line of rent) {
              const g = billable.find((x) => x.assignment.id === line.assignmentId);
              expect(g).toBeDefined();
              if (g) expect(line.amountPaise).toBe(expectedRental(g, p));
            }
            expect([...outcome.invoicedAdjustmentIds].sort()).toEqual(due.map((a) => a.id).sort());
            for (const line of outcome.lines) expect(line.amountPaise).toBeGreaterThanOrEqual(0);
          },
        ),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "does not depend on the order of assignments or adjustments",
    () => {
      fc.assert(
        fc.property(
          customerArb,
          adjustmentsArb,
          periodArb,
          fc.array(fc.nat(), { minLength: 8, maxLength: 8 }),
          (generated, adjustments, p, order) => {
            const build = (assignments: BillingAssignment[], pending: PendingAdjustment[]) =>
              buildInvoice({
                customer: { id: CUSTOMER },
                assignments,
                pendingAdjustments: pending,
                openingBalancePaise: paise(0),
                period: p,
              });
            const assignments = generated.map((g) => g.assignment);
            expect(build(shuffle(assignments, order), shuffle(adjustments, order))).toEqual(
              build(assignments, adjustments),
            );
          },
        ),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );
});

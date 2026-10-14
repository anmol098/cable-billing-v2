/**
 * The Owner's back-dated new connection (T-045a; PLAN §8.1, §8.3 "back-dated effective date into
 * an already-billed period", D-18, FR-008, RULE-10, RULE-20).
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `adjustments.back_dated_add` | `adjustments.manage` (Owner) | Adds a connection whose start reaches into months whose bills are made (or whose run has been), with the Owner's reason and an explicit adjustment for every such month it should have been charged |
 * | `adjustments.preview_add` | `dashboard.view` (Owner, Staff; read) | What adding the connection would do to the bills, month by month, and whether it needs the Owner's flow |
 *
 * **How** (T-034 and T-045 parts; which months: ./months.ts):
 * 1. T-034 `addConnectionInTx(…, { allowBilledPeriod: true })` inside T-045 `collectChangeMonth`:
 *    the add itself (VC found or created, assignment, `activated` event, `connections.add` audit)
 *    and its hook, which decides the **start month** with the operator's D-18
 *    `mid_month_start_policy` (`charge_full_month` → a `mid_month_start` debit of the full rent;
 *    `start_next_month` → nothing) and stores the adjustment with the Owner's reason;
 * 2. T-045 `adjustLaterMonths` (kind `start`) on the **covered** months (./months.ts): every
 *    month after the start month that is billed for the customer or has a (not skipped) billing
 *    run, plus the start month itself when the start is on the 1st (PLAN §8.1: active on the 1st
 *    → the month's full rent, whatever the D-18 policy). Each gets what its bill would have
 *    charged: a `mid_month_start` debit of the full rent, the month's base charge, so a run of
 *    that month never adds a rent line as well (T-044's guard);
 * 3. the total is compared with the one the Owner was shown (`expectedTotalPaise`): different →
 *    CONFLICT `preview_stale` (`details.totalPaise` = the new total) and nothing is saved;
 * 4. one `adjustments.back_dated_change` audit event (`kind: "start"`) listing the adjustments.
 *
 * Months after the start month with no run at all (a missed run) get nothing here: their run, when
 * started, bills the connection itself (T-045 decision 5). Debits wait for the next bill (T-041
 * Q-A), so no issued bill, bill line, payment or ledger entry is touched (D-14, RULE-10).
 *
 * The preview builds the same would-be timeline (a start on `startDate`, no other events) and
 * runs the same rules on the same facts, so it says exactly what the add will do.
 *
 * Refusals (nothing written) are `connections.add`'s: NOT_FOUND (another tenant's or a made-up
 * customer / plan id), VALIDATION (`planId`, `rentalPaise`, `vcNumber`, `startDate`, and here
 * `reason`), CONFLICT `customer_closed` / `vc_retired` / `vc_in_use`; then VALIDATION
 * `startDate`/`not_back_dated` (nothing to correct: an ordinary add, which belongs to
 * `connections.add`, so no back-dated audit event is ever written for it) and CONFLICT
 * `preview_stale`. Staff calling `adjustments.back_dated_add` → FORBIDDEN; Staff calling
 * `connections.add` with a date in a billed month → CONFLICT `billed_period` (unchanged).
 */
import { customers, type Tx } from "@cb/db";
import {
  type AssignmentEvent,
  type BusinessDate,
  businessDateOf,
  comparePeriods,
  err,
  ok,
  type Period,
  periodOf,
  type Result,
  toPaise,
} from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { startDateProblem } from "../../connections/rules";
import { addConnectionInTx, resolveRental } from "../../connections/services";
import { eventsOf, latestBilledPeriod } from "../../connections/store";
import { defineService } from "../../context/service";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../../errors/errors";
import {
  adjustLaterMonths,
  collectChangeMonth,
  isPeriodBilled,
  loadConnectionFacts,
  toMonthEffectView,
} from "../apply";
import {
  changeMonthEffect,
  laterMonthEffect,
  type MonthEffect,
  type RentalTimeline,
  signedTotalPaise,
} from "../effects";
import { readMidMonthStartPolicy } from "../store";
import {
  BackDatedAddConnectionInput,
  type PreviewAddConnectionCommand,
  PreviewAddConnectionInput,
} from "./inputs";
import { coveredPeriods, planOfAdd } from "./months";
import type { AddConnectionPreview, BackDatedAddConnectionResult } from "./types";

type AddError = ServiceError<CoreErrorCode>;

/** The assignment id the preview's drafts carry (the connection does not exist yet). */
const PREVIEW_ASSIGNMENT_ID = "new-connection";

/** A new connection's history: it starts on `startDate` and nothing else has happened. */
export function startTimeline(startDate: BusinessDate, rentalPaise: number): RentalTimeline {
  const activated: AssignmentEvent = { type: "activated", effectiveDate: startDate };
  return {
    startDate,
    endDate: null,
    events: [activated],
    initialRentalPaise: toPaise(rentalPaise),
  };
}

/** The latest month whose bills are made for the customer, or whose run has been. */
function latestCovered(billed: Period | null, covered: ReadonlySet<Period>): Period | null {
  let latest = billed;
  for (const p of covered) if (latest === null || comparePeriods(p, latest) > 0) latest = p;
  return latest;
}

/** The month-by-month effect of adding the connection (no writes; the same rules as the add). */
async function previewOfAdd(
  tx: Tx,
  operatorId: string,
  input: PreviewAddConnectionCommand,
  today: BusinessDate,
): Promise<Result<AddConnectionPreview, AddError>> {
  // The same refusals, in the same order, as `addConnectionInTx`.
  const [customer] = await tx
    .select({ id: customers.id, status: customers.status })
    .from(customers)
    .where(and(eq(customers.operatorId, operatorId), eq(customers.id, input.customerId)));
  if (!customer) return err(notFound());
  const rental = await resolveRental(tx, operatorId, input);
  if (!rental.ok) return rental;
  if (customer.status !== "active") {
    return err(
      serviceError("CONFLICT", "The customer is closed", {
        reason: "customer_closed",
      }) as AddError,
    );
  }
  const dateProblem = startDateProblem({ date: input.startDate, today });
  if (dateProblem) {
    return err(
      serviceError("VALIDATION", "Input failed validation", {
        fields: [{ path: "startDate", code: dateProblem }],
      }),
    );
  }

  const policy = await readMidMonthStartPolicy(tx, operatorId);
  const latest = await latestBilledPeriod(tx, operatorId, customer.id);
  const period = periodOf(input.startDate);
  const billed = await isPeriodBilled(tx, operatorId, customer.id, period);
  const covered = await coveredPeriods(tx, operatorId, customer.id, period);
  const rentalPaise = toPaise(rental.value.rentalPaise);
  const timeline = startTimeline(input.startDate, rentalPaise);
  const plan = planOfAdd(timeline, covered);

  // A new connection has no rent lines or adjustments yet: every month's records are empty.
  const later = (month: Period) => {
    const decided = laterMonthEffect({
      assignmentId: PREVIEW_ASSIGNMENT_ID,
      period: month,
      timeline,
      records: [],
    });
    if (!decided.ok) throw new Error(`preview_add: rules refused: ${decided.error.code}`);
    return decided.value;
  };
  let startMonth: MonthEffect;
  if (plan.startCorrection) {
    startMonth = { ...later(period), scope: "change_month" };
  } else {
    const decided = changeMonthEffect({
      kind: "start",
      assignmentId: PREVIEW_ASSIGNMENT_ID,
      effectiveDate: input.startDate,
      timeline,
      rentalPaise,
      policy,
      month: { billed, records: [] },
    });
    if (!decided.ok) throw new Error(`preview_add: rules refused: ${decided.error.code}`);
    startMonth = decided.value;
  }
  const effects: MonthEffect[] = [startMonth, ...plan.laterMonths.map(later)];
  const value: AddConnectionPreview = {
    customerId: customer.id,
    startDate: input.startDate,
    rentalPaise,
    backDated: plan.needsOwnerFlow,
    latestBilledPeriod: latestCovered(latest, covered),
    policy,
    months: effects.map(toMonthEffectView),
    totalPaise: signedTotalPaise(effects),
  };
  return ok(value);
}

/**
 * What adding a connection would do to the bills, without adding it: the start month and every
 * covered month after it, with the amounts. `backDated` says it needs the Owner's flow.
 */
export const previewAddConnection = defineService({
  name: "adjustments.preview_add",
  capability: "dashboard.view",
  input: PreviewAddConnectionInput,
  async run({ ctx, input, tx, now }) {
    return previewOfAdd(tx, ctx.operatorId, input, businessDateOf(now));
  },
});

/**
 * The Owner adds a connection that really started in a month whose bills are already made (see
 * the module comment). Every adjustment carries the Owner's reason; one extra audit event ties
 * them together.
 */
export const backDatedAddConnection = defineService({
  name: "adjustments.back_dated_add",
  capability: "adjustments.manage",
  input: BackDatedAddConnectionInput,
  async run({ ctx, input, tx, now, audit, log }) {
    const op = ctx.operatorId;
    const { reason, expectedTotalPaise, ...command } = input;
    const collected = await collectChangeMonth(tx, reason, () =>
      addConnectionInTx(tx, { ctx, now, audit, log }, command, { allowBilledPeriod: true }),
    );
    if (!collected.value.ok) return collected.value;
    const added = collected.value.value;
    const assignmentId = added.connection.assignmentId;
    const facts = await loadConnectionFacts(tx, op, assignmentId);
    const activated = (await eventsOf(tx, op, assignmentId)).find((e) => e.type === "activated");
    const hooked = collected.effects[0];
    if (!facts || !activated || !hooked) {
      throw new Error("back_dated_add: the new connection's rows are missing in its transaction");
    }
    const startPeriod = periodOf(command.startDate);
    const covered = await coveredPeriods(tx, op, facts.customerId, startPeriod);
    const plan = planOfAdd(facts.timeline, covered);
    if (!plan.needsOwnerFlow) {
      // An ordinary add (nothing to correct) is `connections.add`'s: refused, rolled back.
      return err(
        serviceError("VALIDATION", "The start does not reach a month whose bills are made", {
          fields: [{ path: "startDate", code: "not_back_dated" }],
        }),
      );
    }

    const corrected = await adjustLaterMonths(
      { tx, operatorId: op, userId: ctx.userId, now, audit },
      {
        kind: "start",
        assignmentId,
        changePeriod: startPeriod,
        eventId: activated.id,
        reason,
        months: plan.startCorrection ? [startPeriod, ...plan.laterMonths] : plan.laterMonths,
      },
    );
    // The start month: the hook's D-18 decision, or (a start on the 1st of a covered month) the
    // correction to the full rent when the hook charged nothing.
    let laterEffects = corrected.effects;
    let startMonth = hooked;
    if (plan.startCorrection) {
      const [correction, ...rest] = corrected.effects;
      if (correction?.draft) startMonth = { ...correction, scope: "change_month" };
      laterEffects = rest;
    }
    const effects = [startMonth, ...laterEffects];
    const made = [...collected.adjustments, ...corrected.adjustments];
    const totalPaise = signedTotalPaise(effects);
    if (totalPaise !== expectedTotalPaise) {
      return err(
        serviceError("CONFLICT", "The bills changed since the preview", {
          reason: "preview_stale",
          totalPaise,
        }) as AddError,
      );
    }
    await audit.record({
      action: "adjustments.back_dated_change",
      entityType: "vc_assignment",
      entityId: assignmentId,
      after: {
        kind: "start",
        effectiveDate: command.startDate,
        reason,
        eventId: activated.id,
        adjustmentIds: made.map((a) => a.id),
        totalPaise,
      },
    });
    const value: BackDatedAddConnectionResult = {
      ...added,
      eventId: activated.id,
      adjustments: made,
      months: effects.map(toMonthEffectView),
      totalPaise,
    };
    return ok(value);
  },
});

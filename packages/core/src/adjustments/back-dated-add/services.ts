/**
 * The Owner's back-dated new connection (T-045a; PLAN §8.3 "back-dated effective date into an
 * already-billed period", D-18, FR-008, RULE-10, RULE-20).
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `adjustments.back_dated_add` | `adjustments.manage` (Owner) | Adds a connection whose start day is in a month already billed for the customer, with the Owner's reason and an explicit adjustment for every billed month it should have been charged |
 * | `adjustments.preview_add` | `dashboard.view` (Owner, Staff; read) | What adding the connection would do to the bills, month by month, and whether it needs the Owner's flow |
 *
 * **How** (no new rules; T-034 and T-045 parts only):
 * 1. T-034 `addConnectionInTx(…, { allowBilledPeriod: true })` inside T-045 `collectChangeMonth`:
 *    the add itself (VC found or created, assignment, `activated` event, `connections.add` audit)
 *    and its hook, which decides the **start month** with the operator's D-18
 *    `mid_month_start_policy` (`charge_full_month` → a `mid_month_start` debit of the full rent;
 *    `start_next_month` → nothing) and stores the adjustment with the Owner's reason;
 * 2. T-045 `adjustLaterMonths` (kind `start`): every month **after** the start month that is
 *    already billed for the customer gets what its bill would have charged with the connection in
 *    it (T-040 `isBillable` + `rentalForPeriod`): a `mid_month_start` debit of the full rent, the
 *    month's base charge, so a run of that month never adds a rent line as well (T-044's guard);
 * 3. one `adjustments.back_dated_change` audit event (`kind: "start"`) listing the adjustments.
 *
 * Months after the start month that are **not** billed (a missed run) get nothing here: their
 * run bills the connection itself (T-045 decision 5). Debits wait for the next bill (T-041 Q-A),
 * so no issued bill, bill line, payment or ledger entry is touched (D-14, RULE-10).
 *
 * The preview builds the same would-be timeline (a start on `startDate`, no other events) and
 * runs the same pure rules (`changeMonthEffect` / `laterMonthEffect`) on the same facts, so it
 * says exactly what the add will do.
 *
 * Refusals (nothing written) are `connections.add`'s: NOT_FOUND (another tenant's or a made-up
 * customer / plan id), VALIDATION (`planId`, `rentalPaise`, `vcNumber`, `startDate`, and here
 * `reason`), CONFLICT `customer_closed` / `vc_retired` / `vc_in_use`. Staff calling
 * `adjustments.back_dated_add` → FORBIDDEN; Staff calling `connections.add` with such a date →
 * CONFLICT `billed_period` (unchanged).
 */
import { customers, type Tx } from "@cb/db";
import {
  type AssignmentEvent,
  type BusinessDate,
  businessDateOf,
  err,
  ok,
  periodOf,
  type Result,
  toPaise,
} from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { reachesBilledPeriod, startDateProblem } from "../../connections/rules";
import { addConnectionInTx, resolveRental } from "../../connections/services";
import { eventsOf, latestBilledPeriod } from "../../connections/store";
import { defineService } from "../../context/service";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../../errors/errors";
import { adjustLaterMonths, collectChangeMonth, isPeriodBilled, toMonthEffectView } from "../apply";
import {
  changeMonthEffect,
  laterMonthEffect,
  type MonthEffect,
  type RentalTimeline,
  signedTotalPaise,
} from "../effects";
import { billedPeriodsOf, readMidMonthStartPolicy } from "../store";
import {
  BackDatedAddConnectionInput,
  type PreviewAddConnectionCommand,
  PreviewAddConnectionInput,
} from "./inputs";
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
  const laterMonths = [...(await billedPeriodsOf(tx, operatorId, customer.id, period))].sort();
  const rentalPaise = toPaise(rental.value.rentalPaise);
  const timeline = startTimeline(input.startDate, rentalPaise);

  // A new connection has no rent lines or adjustments yet: every month's records are empty.
  const startMonth = changeMonthEffect({
    kind: "start",
    assignmentId: PREVIEW_ASSIGNMENT_ID,
    effectiveDate: input.startDate,
    timeline,
    rentalPaise,
    policy,
    month: { billed, records: [] },
  });
  if (!startMonth.ok) throw new Error(`preview_add: rules refused: ${startMonth.error.code}`);
  const effects: MonthEffect[] = [startMonth.value];
  for (const month of laterMonths) {
    const later = laterMonthEffect({
      assignmentId: PREVIEW_ASSIGNMENT_ID,
      period: month,
      timeline,
      records: [],
    });
    if (!later.ok) throw new Error(`preview_add: rules refused: ${later.error.code}`);
    effects.push(later.value);
  }
  const value: AddConnectionPreview = {
    customerId: customer.id,
    startDate: input.startDate,
    rentalPaise,
    backDated: reachesBilledPeriod(input.startDate, latest),
    latestBilledPeriod: latest,
    policy,
    months: effects.map(toMonthEffectView),
    totalPaise: signedTotalPaise(effects),
  };
  return ok(value);
}

/**
 * What adding a connection would do to the bills, without adding it: the start month (D-18) and
 * every billed month after it, with the amounts. `backDated` says it needs the Owner's flow.
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
    const { reason, ...command } = input;
    const collected = await collectChangeMonth(tx, reason, () =>
      addConnectionInTx(tx, { ctx, now, audit, log }, command, { allowBilledPeriod: true }),
    );
    if (!collected.value.ok) return collected.value;
    const added = collected.value.value;
    const assignmentId = added.connection.assignmentId;
    const activated = (await eventsOf(tx, op, assignmentId)).find((e) => e.type === "activated");
    if (!activated) throw new Error("back_dated_add: the new connection has no activated event");

    const later = await adjustLaterMonths(
      { tx, operatorId: op, userId: ctx.userId, now, audit },
      {
        kind: "start",
        assignmentId,
        changePeriod: periodOf(command.startDate),
        eventId: activated.id,
        reason,
      },
    );
    const effects = [...collected.effects, ...later.effects];
    const made = [...collected.adjustments, ...later.adjustments];
    const totalPaise = signedTotalPaise(effects);
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

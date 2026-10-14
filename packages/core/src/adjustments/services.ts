/**
 * Adjustment services (T-045; PLAN §8.3, §8.5, D-14, D-18, FR-008, BR-07, RULE-10, RULE-20).
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `adjustments.create_manual` | `adjustments.manage` (Owner) | A manual bill change: debit (more to pay) or credit (less to pay), reason required, idempotent on the form's id |
 * | `adjustments.back_dated_change` | `adjustments.manage` (Owner) | The guided back-dated change: a plan change / stop / start again / remove whose date reaches into a billed month, with the Owner's reason and an explicit adjustment for every month it alters |
 * | `adjustments.preview_change` | `dashboard.view` (Owner, Staff; read) | What a plan change / stop / start again / remove would do to the money, month by month ("₹50 extra will be added to the next bill"), and whether it needs the Owner's back-dated flow |
 * | `adjustments.list` | `billing.preview` (Owner, Staff; read) | The bill changes list under Bills |
 * | `adjustments.charged_months` | `customers.view` (read) | Recent months that already have rent per connection, and the D-18 policy (the "Start again" effect text) |
 *
 * **Nothing here edits an issued bill** (D-14, RULE-10): adjustments are new rows; a debit waits
 * for the next bill, a credit becomes credit and pays the oldest open bills at once (./store.ts).
 * Automatic adjustments come from the connection hooks (./apply.ts, ../connections/hooks).
 *
 * Refusals (nothing written): another tenant's or a made-up id → NOT_FOUND; VALIDATION
 * `details.fields`; CONFLICT `details.reason`: `id_reused` (manual: the same form id with other
 * data), and from the connection rules `invalid_transition`, `billed_period` (Staff, normal
 * flow) etc.
 */
import {
  adjustments,
  customers,
  invoices,
  plans,
  type Tx,
  users,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import {
  type AssignmentEvent,
  addPeriods,
  businessDateOf,
  err,
  ok,
  type Period,
  periodOf,
  type Result,
  rentalChargedSoFar,
  toPaise,
  period as toPeriod,
  validateAssignmentTimeline,
} from "@cb/domain";
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { changeDateProblem, nextStatus, reachesBilledPeriod } from "../connections/rules";
import { type ConnectionWriteEnv, changePlanInTx, changeStatusInTx } from "../connections/services";
import { latestBilledPeriod } from "../connections/store";
import { defineService } from "../context/service";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../errors/errors";
import { lockCustomerBalance } from "../payments/ledger-io";
import {
  adjustLaterMonths,
  type ConnectionFacts,
  collectChangeMonth,
  isPeriodBilled,
  loadConnectionFacts,
  toMonthEffectView,
} from "./apply";
import { changeMonthEffect, laterMonthEffect, type MonthEffect, signedTotalPaise } from "./effects";
import {
  ADJUSTMENT_LIMITS,
  BackDatedChangeInput,
  type ConnectionChangeCommand,
  ConnectionChargedMonthsInput,
  CreateManualAdjustmentInput,
  ListAdjustmentsInput,
  PreviewConnectionChangeInput,
} from "./inputs";
import {
  billedPeriodsOf,
  creditUsedOf,
  insertAdjustment,
  readMidMonthStartPolicy,
  rentalRecordsOf,
  toAdjustmentView,
} from "./store";
import type {
  AdjustmentListRow,
  AdjustmentListView,
  BackDatedChangeResult,
  ConnectionChangePreview,
  ConnectionChargedMonths,
  ManualAdjustmentResult,
} from "./types";

type AdjustmentServiceError = ServiceError<CoreErrorCode>;

function conflict(reason: string, message: string, details: Record<string, unknown> = {}) {
  return serviceError("CONFLICT", message, { reason, ...details }) as AdjustmentServiceError;
}

function fieldProblem(path: string, code: string): AdjustmentServiceError {
  return serviceError("VALIDATION", "Input failed validation", { fields: [{ path, code }] });
}

// ---------------------------------------------------------------------------------------------
// Manual adjustment (Owner)
// ---------------------------------------------------------------------------------------------

/**
 * An Owner's manual bill change (PLAN §8.3 "explicit adjustment with a reason", FR-024 audited).
 * The form's `id` makes a resend safe: the same id and data → `duplicate` with the stored row;
 * the same id with other data → CONFLICT `id_reused`. A debit goes on the next bill; a credit
 * becomes credit and pays the oldest open bills at once (T-041 `applyCredit`).
 */
export const createManualAdjustment = defineService({
  name: "adjustments.create_manual",
  capability: "adjustments.manage",
  input: CreateManualAdjustmentInput,
  async run({ ctx, input, tx, now, audit }) {
    const op = ctx.operatorId;
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.operatorId, op), eq(customers.id, input.customerId)));
    if (!customer) return err(notFound());
    const assignmentId = input.assignmentId ?? null;
    if (assignmentId !== null) {
      const [assignment] = await tx
        .select({ id: vcAssignments.id })
        .from(vcAssignments)
        .where(
          and(
            eq(vcAssignments.operatorId, op),
            eq(vcAssignments.id, assignmentId),
            eq(vcAssignments.customerId, customer.id),
          ),
        );
      if (!assignment) return err(notFound());
    }
    await lockCustomerBalance(tx, op, customer.id);

    const [existing] = await tx
      .select()
      .from(adjustments)
      .where(and(eq(adjustments.operatorId, op), eq(adjustments.id, input.id)));
    if (existing) {
      const same =
        existing.source === "manual" &&
        existing.customerId === customer.id &&
        existing.assignmentId === assignmentId &&
        existing.direction === input.direction &&
        existing.amountPaise === input.amountPaise &&
        existing.reason === input.reason;
      if (!same) return err(conflict("id_reused", "This form was already saved with other data"));
      audit.skip("idempotent_replay");
      const value: ManualAdjustmentResult = {
        outcome: "duplicate",
        adjustment: toAdjustmentView(existing),
        creditAppliedPaise: toPaise(0),
      };
      return ok(value);
    }

    const stored = await insertAdjustment(
      tx,
      { operatorId: op, now, audit },
      {
        id: input.id,
        customerId: customer.id,
        assignmentId,
        period: null,
        direction: input.direction,
        amountPaise: toPaise(input.amountPaise),
        source: "manual",
        reason: input.reason,
        createdBy: ctx.userId,
      },
    );
    const value: ManualAdjustmentResult = { outcome: "created", ...stored };
    return ok(value);
  },
});

// ---------------------------------------------------------------------------------------------
// Preview (Owner, Staff)
// ---------------------------------------------------------------------------------------------

/** The plan or own amount a change asks for. NOT_FOUND for another tenant's plan. */
async function resolveNewRental(
  tx: Tx,
  operatorId: string,
  change: ConnectionChangeCommand,
): Promise<Result<{ planId: string | null; rentalPaise: number }, AdjustmentServiceError>> {
  if (change.planId) {
    const [plan] = await tx
      .select({ id: plans.id, status: plans.status, amount: plans.monthlyAmountPaise })
      .from(plans)
      .where(and(eq(plans.operatorId, operatorId), eq(plans.id, change.planId)));
    if (!plan) return err(notFound());
    if (plan.status !== "active") return err(fieldProblem("change.planId", "retired"));
    return ok({ planId: plan.id, rentalPaise: plan.amount });
  }
  return ok({ planId: null, rentalPaise: change.rentalPaise ?? 0 });
}

const ACTION_OF = {
  plan: "change_plan",
  suspend: "suspend",
  reactivate: "reactivate",
  disconnect: "disconnect",
} as const;

const EVENT_OF = {
  suspend: "suspended",
  reactivate: "reactivated",
  disconnect: "disconnected",
} as const;

/** The month-by-month effect of `change` on `facts` (no writes). */
async function previewOf(
  tx: Tx,
  operatorId: string,
  facts: ConnectionFacts,
  change: ConnectionChangeCommand,
  effectiveDate: ConnectionChangePreview["effectiveDate"],
  today: ConnectionChangePreview["effectiveDate"],
): Promise<Result<ConnectionChangePreview, AdjustmentServiceError>> {
  const rental = await resolveNewRental(tx, operatorId, change);
  if (!rental.ok) return rental;
  const toRental = change.kind === "plan" ? rental.value.rentalPaise : facts.rentalPaise;
  const policy = await readMidMonthStartPolicy(tx, operatorId);
  const latest = await latestBilledPeriod(tx, operatorId, facts.customerId);
  const base = {
    assignmentId: facts.id,
    customerId: facts.customerId,
    kind: change.kind,
    effectiveDate,
    fromRentalPaise: toPaise(facts.rentalPaise),
    toRentalPaise: toPaise(toRental),
    latestBilledPeriod: latest,
    policy,
  };

  if (nextStatus(facts.status, ACTION_OF[change.kind]) === null) {
    return err(
      conflict("invalid_transition", "This change is not allowed from the current status", {
        from: facts.status,
        action: ACTION_OF[change.kind],
      }),
    );
  }
  if (
    change.kind === "plan" &&
    facts.planId === rental.value.planId &&
    facts.rentalPaise === rental.value.rentalPaise
  ) {
    const value: ConnectionChangePreview = {
      ...base,
      noChange: true,
      backDated: false,
      months: [],
      totalPaise: toPaise(0),
    };
    return ok(value);
  }
  const problem = changeDateProblem({
    date: effectiveDate,
    today,
    startDate: facts.timeline.startDate,
    lastChangeDate: facts.lastChangeDate as typeof effectiveDate,
  });
  if (problem) return err(fieldProblem("effectiveDate", problem));

  const event: AssignmentEvent =
    change.kind === "plan"
      ? { type: "plan_changed", effectiveDate, rentalPaise: toPaise(toRental) }
      : { type: EVENT_OF[change.kind], effectiveDate };
  const timeline = {
    ...facts.timeline,
    endDate: change.kind === "disconnect" ? effectiveDate : facts.timeline.endDate,
    events: [...facts.events, event],
  };
  const checked = validateAssignmentTimeline(timeline);
  if (!checked.ok) {
    return err(
      conflict("invalid_transition", "The change does not fit the connection's history", {
        from: facts.status,
        timelineReason: checked.error.details?.reason ?? null,
      }),
    );
  }

  const period = periodOf(effectiveDate);
  const billed = await isPeriodBilled(tx, operatorId, facts.customerId, period);
  const laterMonths = [...(await billedPeriodsOf(tx, operatorId, facts.customerId, period))].sort();
  const records = await rentalRecordsOf(tx, operatorId, facts.id, [period, ...laterMonths]);
  const changeMonth = changeMonthEffect({
    kind: change.kind,
    assignmentId: facts.id,
    effectiveDate,
    timeline,
    rentalPaise: toPaise(toRental),
    policy,
    month: { billed, records: records.get(period) ?? [] },
  });
  if (!changeMonth.ok)
    throw new Error(`preview: rules refused the rows: ${changeMonth.error.code}`);
  const effects: MonthEffect[] = [changeMonth.value];
  for (const month of laterMonths) {
    const later = laterMonthEffect({
      assignmentId: facts.id,
      period: month,
      timeline,
      records: records.get(month) ?? [],
    });
    if (!later.ok) throw new Error(`preview: rules refused the rows: ${later.error.code}`);
    effects.push(later.value);
  }
  const value: ConnectionChangePreview = {
    ...base,
    noChange: false,
    backDated: reachesBilledPeriod(effectiveDate, latest),
    months: effects.map(toMonthEffectView),
    totalPaise: signedTotalPaise(effects),
  };
  return ok(value);
}

/**
 * What a change to a connection would do to the money, without doing it (the plan-change screen's
 * "₹50 extra will be added to the next bill"). The same rules and refusals as the change itself;
 * `backDated` says it needs the Owner's back-dated flow.
 */
export const previewConnectionChange = defineService({
  name: "adjustments.preview_change",
  capability: "dashboard.view",
  input: PreviewConnectionChangeInput,
  async run({ ctx, input, tx, now }) {
    const facts = await loadConnectionFacts(tx, ctx.operatorId, input.assignmentId);
    if (!facts) return err(notFound());
    return previewOf(
      tx,
      ctx.operatorId,
      facts,
      input.change,
      input.effectiveDate,
      businessDateOf(now),
    );
  },
});

// ---------------------------------------------------------------------------------------------
// Back-dated change (Owner)
// ---------------------------------------------------------------------------------------------

/**
 * The Owner's guided back-dated change (PLAN §8.3): the change is made with `allowBilledPeriod`;
 * its own month is adjusted by the connection hook, and every billed month after it gets an
 * explicit adjustment so it charges what the bill would have charged with the corrected history.
 * Every adjustment carries the Owner's reason; one extra audit event ties them together.
 */
export const backDatedConnectionChange = defineService({
  name: "adjustments.back_dated_change",
  capability: "adjustments.manage",
  input: BackDatedChangeInput,
  async run({ ctx, input, tx, now, audit, log }) {
    const env: ConnectionWriteEnv = { ctx, now, audit, log };
    const { change } = input;
    const collected = await collectChangeMonth(tx, input.reason, () =>
      change.kind === "plan"
        ? changePlanInTx(
            tx,
            env,
            {
              assignmentId: input.assignmentId,
              effectiveDate: input.effectiveDate,
              planId: change.planId ?? null,
              rentalPaise: change.rentalPaise ?? null,
            },
            { allowBilledPeriod: true },
          )
        : changeStatusInTx(
            tx,
            env,
            {
              assignmentId: input.assignmentId,
              action: change.kind,
              effectiveDate: input.effectiveDate,
              reason: change.kind === "reactivate" ? null : (change.stopReason ?? null),
              note: change.kind === "reactivate" ? null : (change.note ?? null),
            },
            { allowBilledPeriod: true },
          ),
    );
    if (!collected.value.ok) return collected.value;
    const changed = collected.value.value;
    if (!changed.changed) {
      const value: BackDatedChangeResult = {
        connection: changed.connection,
        changed: false,
        eventId: null,
        adjustments: [],
        months: [],
        totalPaise: toPaise(0),
      };
      return ok(value);
    }

    const later = await adjustLaterMonths(
      { tx, operatorId: ctx.operatorId, userId: ctx.userId, now, audit },
      {
        kind: change.kind,
        assignmentId: input.assignmentId,
        changePeriod: periodOf(input.effectiveDate),
        eventId: changed.eventId,
        reason: input.reason,
      },
    );
    const effects = [...collected.effects, ...later.effects];
    const made = [...collected.adjustments, ...later.adjustments];
    const totalPaise = signedTotalPaise(effects);
    await audit.record({
      action: "adjustments.back_dated_change",
      entityType: "vc_assignment",
      entityId: input.assignmentId,
      after: {
        kind: change.kind,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        eventId: changed.eventId,
        adjustmentIds: made.map((a) => a.id),
        totalPaise,
      },
    });
    const value: BackDatedChangeResult = {
      connection: changed.connection,
      changed: true,
      eventId: changed.eventId,
      adjustments: made,
      months: effects.map(toMonthEffectView),
      totalPaise,
    };
    return ok(value);
  },
});

// ---------------------------------------------------------------------------------------------
// List (Owner, Staff)
// ---------------------------------------------------------------------------------------------

/** The bill changes, newest first, 50 per page, with customer, VC, bill and author. */
export const listAdjustments = defineService({
  name: "adjustments.list",
  capability: "billing.preview",
  input: ListAdjustmentsInput,
  async run({ ctx, input, tx }) {
    const op = ctx.operatorId;
    const filters: SQL[] = [eq(adjustments.operatorId, op)];
    if (input.source) filters.push(eq(adjustments.source, input.source));
    if (input.customerId) filters.push(eq(adjustments.customerId, input.customerId));
    if (input.state === "pending") {
      filters.push(eq(adjustments.direction, "debit"), isNull(adjustments.invoiceId));
    } else if (input.state === "billed") {
      filters.push(isNotNull(adjustments.invoiceId));
    } else if (input.state === "credit") {
      filters.push(eq(adjustments.direction, "credit"));
    }
    const size = ADJUSTMENT_LIMITS.pageSize;
    const rows = await tx
      .select({
        a: adjustments,
        customerCode: customers.customerCode,
        customerName: customers.name,
        vcNumber: vcAssets.vcNumber,
        invoiceNumber: invoices.invoiceNumber,
        createdByName: users.name,
      })
      .from(adjustments)
      .innerJoin(
        customers,
        and(
          eq(customers.operatorId, adjustments.operatorId),
          eq(customers.id, adjustments.customerId),
        ),
      )
      .leftJoin(
        vcAssignments,
        and(
          eq(vcAssignments.operatorId, adjustments.operatorId),
          eq(vcAssignments.id, adjustments.assignmentId),
        ),
      )
      .leftJoin(
        vcAssets,
        and(
          eq(vcAssets.operatorId, vcAssignments.operatorId),
          eq(vcAssets.id, vcAssignments.vcAssetId),
        ),
      )
      .leftJoin(
        invoices,
        and(
          eq(invoices.operatorId, adjustments.operatorId),
          eq(invoices.id, adjustments.invoiceId),
        ),
      )
      .leftJoin(
        users,
        and(eq(users.operatorId, adjustments.operatorId), eq(users.id, adjustments.createdBy)),
      )
      .where(and(...filters))
      .orderBy(desc(adjustments.createdAt), desc(adjustments.id))
      .limit(size + 1)
      .offset((input.page - 1) * size);
    const page = rows.slice(0, size);
    const used = await creditUsedOf(
      tx,
      op,
      page.filter((r) => r.a.direction === "credit").map((r) => r.a.id),
    );
    const [pending] = await tx
      .select({ total: sql<string>`coalesce(sum(${adjustments.amountPaise}), 0)` })
      .from(adjustments)
      .where(
        and(
          eq(adjustments.operatorId, op),
          eq(adjustments.direction, "debit"),
          isNull(adjustments.invoiceId),
        ),
      );
    const list: AdjustmentListRow[] = page.map(({ a, ...joined }) => ({
      id: a.id,
      createdAt: a.createdAt,
      customerId: a.customerId,
      customerCode: joined.customerCode,
      customerName: joined.customerName,
      vcNumber: joined.vcNumber ?? null,
      period: a.period === null ? null : toPeriod(a.period),
      direction: a.direction,
      amountPaise: toPaise(a.amountPaise),
      source: a.source,
      reason: a.reason,
      state: a.direction === "credit" ? "credit" : a.invoiceId === null ? "pending" : "billed",
      invoiceId: a.invoiceId,
      invoiceNumber: joined.invoiceNumber ?? null,
      creditUsedPaise: used.get(a.id) ?? toPaise(0),
      createdByName: joined.createdByName ?? null,
    }));
    const value: AdjustmentListView = {
      rows: list,
      page: input.page,
      hasMore: rows.length > size,
      pendingDebitPaise: toPaise(pending?.total ?? 0),
    };
    return ok(value);
  },
});

// ---------------------------------------------------------------------------------------------
// Charged months (the Connections tab's "Start again" effect)
// ---------------------------------------------------------------------------------------------

/**
 * For each of the customer's connections, the recent months (the last six and this one) that
 * already charge it rent (> ₹0), and the operator's D-18 policy. The Connections tab uses it to
 * say "₹300 for October will be added to the next bill" on "Start again" only when that is true.
 */
export const connectionChargedMonths = defineService({
  name: "adjustments.charged_months",
  capability: "customers.view",
  input: ConnectionChargedMonthsInput,
  async run({ ctx, input, tx, now }) {
    const op = ctx.operatorId;
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.operatorId, op), eq(customers.id, input.customerId)));
    if (!customer) return err(notFound());
    const policy = await readMidMonthStartPolicy(tx, op);
    const current = periodOf(businessDateOf(now));
    const months: Period[] = [];
    for (let back = ADJUSTMENT_LIMITS.chargedMonthsBack; back >= 0; back -= 1) {
      months.push(addPeriods(current, -back));
    }
    const assignmentRows = await tx
      .select({ id: vcAssignments.id })
      .from(vcAssignments)
      .where(and(eq(vcAssignments.operatorId, op), eq(vcAssignments.customerId, customer.id)));
    const charged: Record<string, Period[]> = {};
    for (const { id } of assignmentRows) {
      const records = await rentalRecordsOf(tx, op, id, months);
      const list: Period[] = [];
      for (const month of months) {
        const soFar = rentalChargedSoFar({
          assignmentId: id,
          period: month,
          records: records.get(month) ?? [],
        });
        if (soFar.ok && soFar.value.chargedSoFarPaise > 0) list.push(month);
      }
      charged[id] = list;
    }
    const value: ConnectionChargedMonths = { policy, charged };
    return ok(value);
  },
});

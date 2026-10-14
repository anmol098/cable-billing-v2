/**
 * Turns a connection change into adjustments inside the change's transaction (T-045). Used by the
 * connection hooks (./../connections/hooks) for the change's own month, and by the Owner's
 * back-dated flow (./services.ts) for the billed months after it. The arithmetic is in
 * ./effects.ts (T-042 netting and the D-18 policy); this file loads the facts and stores the
 * drafts with `insertAdjustment` (ledger, credit, audit).
 *
 * **No double charge, ever** (FR-008, PRD §15 #5): every decision nets against what the month
 * already charges (rent line + earlier adjustments, pending or billed), so running a decision
 * again (a retry, a second change in the month, a re-run of the period) finds nothing left to do.
 */
import { type Tx, vcAssignments } from "@cb/db";
import {
  type AssignmentEvent,
  type BusinessDate,
  type Period,
  periodOf,
  previousPeriod,
  toPaise,
} from "@cb/domain";
import { and, eq } from "drizzle-orm";
import type { AuditRecorder } from "../audit/audit";
import { eventsOf, toTimeline } from "../connections/store";
import {
  type ChangeKind,
  changeMonthEffect,
  laterMonthEffect,
  type MonthEffect,
  type RentalTimeline,
} from "./effects";
import {
  billedPeriodsOf,
  insertAdjustment,
  readMidMonthStartPolicy,
  rentalRecordsOf,
} from "./store";
import type { AdjustmentView, MonthEffectView } from "./types";

/**
 * The Owner's back-dated flow runs a connection change whose hook adjusts the change's month. The
 * hooks have no reason parameter and return nothing, so the flow registers a collector for its
 * transaction: the hook stores the Owner's reason on its adjustment and reports what it did.
 */
interface Collector {
  readonly reason: string;
  readonly effects: MonthEffect[];
  readonly adjustments: AdjustmentView[];
}

const collectors = new WeakMap<Tx, Collector>();

export async function collectChangeMonth<T>(
  tx: Tx,
  reason: string,
  fn: () => Promise<T>,
): Promise<{ value: T; effects: MonthEffect[]; adjustments: AdjustmentView[] }> {
  const collector: Collector = { reason, effects: [], adjustments: [] };
  collectors.set(tx, collector);
  try {
    const value = await fn();
    return { value, effects: collector.effects, adjustments: collector.adjustments };
  } finally {
    collectors.delete(tx);
  }
}

/** A connection's row and stored history as a T-040 timeline with its starting rental. */
export interface ConnectionFacts {
  readonly id: string;
  readonly customerId: string;
  readonly status: "active" | "suspended" | "disconnected";
  readonly planId: string | null;
  readonly rentalPaise: number;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly lastChangeDate: string;
  /** Stored events, recorded order, as T-040 events. */
  readonly events: readonly AssignmentEvent[];
  readonly timeline: RentalTimeline;
}

export async function loadConnectionFacts(
  tx: Tx,
  operatorId: string,
  assignmentId: string,
): Promise<ConnectionFacts | null> {
  const [row] = await tx
    .select()
    .from(vcAssignments)
    .where(and(eq(vcAssignments.operatorId, operatorId), eq(vcAssignments.id, assignmentId)));
  if (!row) return null;
  const eventRows = await eventsOf(tx, operatorId, assignmentId);
  const timeline = toTimeline(row, eventRows);
  const firstPlanChange = eventRows.find((e) => e.type === "plan_changed");
  let lastChangeDate = row.startDate;
  for (const event of eventRows) {
    if (event.effectiveDate > lastChangeDate) lastChangeDate = event.effectiveDate;
  }
  return {
    id: row.id,
    customerId: row.customerId,
    status: row.status,
    planId: row.planId,
    rentalPaise: row.rentalAmountPaise,
    startDate: row.startDate,
    endDate: row.endDate,
    lastChangeDate,
    events: timeline.events,
    timeline: {
      ...timeline,
      initialRentalPaise: toPaise(firstPlanChange?.fromRentalPaise ?? row.rentalAmountPaise),
    },
  };
}

export function toMonthEffectView(effect: MonthEffect): MonthEffectView {
  return {
    period: effect.period,
    scope: effect.scope,
    outcome: effect.outcome,
    chargedBeforePaise: effect.chargedBeforePaise,
    chargedAfterPaise: effect.chargedAfterPaise,
  };
}

interface ApplyEnv {
  readonly tx: Tx;
  readonly operatorId: string;
  readonly userId: string;
  readonly now: Date;
  readonly audit: AuditRecorder;
}

/** Whether `period` is billed for the customer (T-034's definition). */
export async function isPeriodBilled(
  tx: Tx,
  operatorId: string,
  customerId: string,
  period: Period,
): Promise<boolean> {
  const billed = await billedPeriodsOf(tx, operatorId, customerId, previousPeriod(period));
  return billed.has(period);
}

/**
 * The change's own month (the hook's job): decides with ./effects.ts on the stored history
 * (already including the change) and stores the adjustment, if any. A domain error here means the
 * stored rows break the rules (a bug): it is thrown, so the change rolls back as INTERNAL.
 */
export async function adjustChangeMonth(
  env: ApplyEnv,
  change: {
    readonly kind: ChangeKind;
    readonly assignmentId: string;
    readonly effectiveDate: BusinessDate;
    readonly eventId: string;
  },
): Promise<{ effect: MonthEffect; adjustment: AdjustmentView | null }> {
  const { tx, operatorId } = env;
  const facts = await loadConnectionFacts(tx, operatorId, change.assignmentId);
  if (!facts) throw new Error("hook: assignment not found in its own transaction");
  const period = periodOf(change.effectiveDate);
  // One statement at a time: they share the transaction's connection.
  const policy = await readMidMonthStartPolicy(tx, operatorId);
  const billed = await isPeriodBilled(tx, operatorId, facts.customerId, period);
  const records = await rentalRecordsOf(tx, operatorId, facts.id, [period]);
  const decided = changeMonthEffect({
    kind: change.kind,
    assignmentId: facts.id,
    effectiveDate: change.effectiveDate,
    timeline: facts.timeline,
    rentalPaise: toPaise(facts.rentalPaise),
    policy,
    month: { billed, records: records.get(period) ?? [] },
  });
  if (!decided.ok) {
    throw new Error(`adjustment rules refused the stored rows: ${decided.error.code}`);
  }
  const effect = decided.value;
  const collector = collectors.get(tx);
  collector?.effects.push(effect);
  if (effect.draft === null) return { effect, adjustment: null };
  const stored = await insertAdjustment(
    tx,
    env,
    {
      customerId: facts.customerId,
      assignmentId: effect.draft.assignmentId,
      period: effect.draft.period,
      direction: effect.draft.direction,
      amountPaise: effect.draft.amountPaise,
      source: effect.draft.source,
      reason: collector?.reason ?? null,
      createdBy: env.userId,
    },
    { cause: change.kind, eventId: change.eventId, scope: "change_month" },
  );
  collector?.adjustments.push(stored.adjustment);
  return { effect, adjustment: stored.adjustment };
}

/**
 * The billed months after `changePeriod` (the Owner's back-dated flow): each one is corrected to
 * what the monthly bill would charge with the new history (./effects.ts `laterMonthEffect`).
 * `months` replaces that list when the caller knows better which months need it (T-045a: a new
 * connection also corrects months whose run has already been, with or without a bill for the
 * customer, and a start-on-the-1st month).
 */
export async function adjustLaterMonths(
  env: ApplyEnv,
  change: {
    readonly kind: ChangeKind;
    readonly assignmentId: string;
    readonly changePeriod: Period;
    readonly eventId: string | null;
    readonly reason: string;
    readonly months?: readonly Period[];
  },
): Promise<{ effects: MonthEffect[]; adjustments: AdjustmentView[] }> {
  const { tx, operatorId } = env;
  const facts = await loadConnectionFacts(tx, operatorId, change.assignmentId);
  if (!facts) throw new Error("back-dated flow: assignment not found in its own transaction");
  const months = [
    ...(change.months ??
      (await billedPeriodsOf(tx, operatorId, facts.customerId, change.changePeriod))),
  ].sort();
  const records = await rentalRecordsOf(tx, operatorId, facts.id, months);
  const effects: MonthEffect[] = [];
  const stored: AdjustmentView[] = [];
  for (const month of months) {
    const decided = laterMonthEffect({
      assignmentId: facts.id,
      period: month,
      timeline: facts.timeline,
      records: records.get(month) ?? [],
    });
    if (!decided.ok) {
      throw new Error(`adjustment rules refused the stored rows: ${decided.error.code}`);
    }
    effects.push(decided.value);
    const draft = decided.value.draft;
    if (draft === null) continue;
    const saved = await insertAdjustment(
      tx,
      env,
      {
        customerId: facts.customerId,
        assignmentId: draft.assignmentId,
        period: draft.period,
        direction: draft.direction,
        amountPaise: draft.amountPaise,
        source: draft.source,
        reason: change.reason,
        createdBy: env.userId,
      },
      { cause: change.kind, eventId: change.eventId, scope: "later_month" },
    );
    stored.push(saved.adjustment);
  }
  return { effects, adjustments: stored };
}

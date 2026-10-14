/**
 * Manual subscription changes by a platform admin (T-086, PLAN §13: "The admin can record an
 * offline payment or extend manually (audited)").
 *
 * Both go through T-085's `applySubscriptionChange` with `{ kind: "manual_extend", until }` in the
 * **tenant's** transaction (row lock, the state machine, `subscription.state_changed` in the
 * tenant's log with the admin as actor), then write a platform audit event.
 *
 * - **Extend** (`admin.subscription_extend`): paid access through an IST last day, with a reason.
 *   A date before the current paid end changes nothing (the machine keeps the later end).
 * - **Offline payment** (`admin.offline_payment_record`): stores the money record
 *   (`subscription_offline_payments`, append-only, integer paise) and extends by whole months from
 *   the later of: the current paid end, the end of the trial, or the next IST midnight. Idempotent
 *   on the form's `paymentId`.
 */
import {
  OFFLINE_PAYMENT_MAX_MONTHS,
  OFFLINE_PAYMENT_METHODS,
  subscriptionOfflinePayments,
} from "@cb/db";
import {
  addDays,
  type BusinessDate,
  businessDateFromParts,
  businessDateOf,
  dateParts,
  daysInMonth,
  err,
  isBusinessDate,
  istStartOfDay,
  ok,
} from "@cb/domain";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { notFound, serviceError } from "../errors/errors";
import { istMidnightOnOrAfter } from "../subscriptions/state";
import { applySubscriptionChange, lockSubscription } from "../subscriptions/store";
import { defineAdminService } from "./service";

/** Furthest an admin may extend in one step, in days from today (IST). */
export const MAX_EXTEND_DAYS = 731;
/** Largest offline payment we accept in one record: ₹1,00,000. */
export const MAX_OFFLINE_PAYMENT_PAISE = 10_000_000;

const businessDay = z.string().refine((v) => isBusinessDate(v), { message: "invalid_date" });

/** `date` plus whole calendar months; the day is clamped to the month's length (31 Jan + 1 → 28/29 Feb). */
export function addMonthsToDate(date: BusinessDate, months: number): BusinessDate {
  const { year, month, day } = dateParts(date);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return businessDateFromParts({ year: y, month: m, day: Math.min(day, daysInMonth(y, m)) });
}

export const ExtendSubscriptionInput = z.object({
  operatorId: z.uuid(),
  /** The last IST day of paid access (inclusive). */
  lastDay: businessDay,
  reason: z.string().trim().min(5).max(300),
});

export const extendSubscription = defineAdminService({
  name: "admin.subscription_extend",
  input: ExtendSubscriptionInput,
  async run({ ctx, input, runtime, audit, now }) {
    const today = businessDateOf(now);
    const lastDay = input.lastDay as BusinessDate;
    if (lastDay < today || lastDay > addDays(today, MAX_EXTEND_DAYS)) {
      return err(
        serviceError("VALIDATION", "lastDay out of range", {
          fields: [{ path: "lastDay", code: "out_of_range" }],
        }),
      );
    }
    const until = istStartOfDay(addDays(lastDay, 1));
    const op = input.operatorId;
    const applied = await runtime.db.withTenant(op, (tx) =>
      applySubscriptionChange(tx, {
        operatorId: op,
        change: { kind: "manual_extend", until },
        now,
        actor: { kind: "user", userId: ctx.userId, role: "platform_admin" },
        source: "admin_extend",
        requestId: ctx.requestId,
      }),
    );
    if (!applied.found || !applied.before || !applied.step) return err(notFound());
    const after = applied.step.state;
    await runtime.db.withPlatform((tx) =>
      audit.platform(tx, {
        action: "admin.subscription_extended",
        entityType: "operator",
        entityId: op,
        before: {
          status: applied.before?.status,
          current_period_end: applied.before?.currentPeriodEnd,
        },
        after: {
          status: after.status,
          current_period_end: after.currentPeriodEnd,
          last_day: lastDay,
          reason: input.reason,
          changed: applied.changed,
        },
      }),
    );
    return ok({
      changed: applied.changed,
      status: after.status,
      currentPeriodEnd: after.currentPeriodEnd,
      missedRunPeriods: applied.missedRunPeriods,
    });
  },
});

export const RecordOfflinePaymentInput = z.object({
  operatorId: z.uuid(),
  /** Made once by the form (hidden field): a retry or double submit records one payment. */
  paymentId: z.uuid(),
  amountPaise: z.number().int().positive().max(MAX_OFFLINE_PAYMENT_PAISE),
  method: z.enum(OFFLINE_PAYMENT_METHODS),
  reference: z.string().trim().max(100).optional(),
  /** The IST day the money arrived (not in the future). */
  receivedOn: businessDay,
  months: z.number().int().min(1).max(OFFLINE_PAYMENT_MAX_MONTHS),
  note: z.string().trim().max(500).optional(),
});

export const recordOfflinePayment = defineAdminService({
  name: "admin.offline_payment_record",
  input: RecordOfflinePaymentInput,
  async run({ ctx, input, runtime, audit, now }) {
    const receivedOn = input.receivedOn as BusinessDate;
    if (receivedOn > businessDateOf(now) || receivedOn < addDays(businessDateOf(now), -400)) {
      return err(
        serviceError("VALIDATION", "receivedOn out of range", {
          fields: [{ path: "receivedOn", code: "out_of_range" }],
        }),
      );
    }
    const op = input.operatorId;
    const outcome = await runtime.db.withTenant(op, async (tx) => {
      const current = await lockSubscription(tx);
      if (!current) return null;
      const existing = await tx
        .select({
          id: subscriptionOfflinePayments.id,
          paidUntil: subscriptionOfflinePayments.paidUntil,
        })
        .from(subscriptionOfflinePayments)
        .where(eq(subscriptionOfflinePayments.id, input.paymentId))
        .limit(1);
      if (existing[0]) {
        return {
          status: "already_recorded" as const,
          paidUntil: existing[0].paidUntil,
          missed: [],
        };
      }
      const candidates = [now, current.currentPeriodEnd];
      if (current.status === "trialing") candidates.push(current.trialEndsAt);
      const base = candidates
        .filter((d): d is Date => d instanceof Date)
        .reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
      const startDay = businessDateOf(istMidnightOnOrAfter(base));
      const paidUntil = istStartOfDay(addMonthsToDate(startDay, input.months));
      await tx.insert(subscriptionOfflinePayments).values({
        id: input.paymentId,
        operatorId: op,
        amountPaise: input.amountPaise,
        method: input.method,
        reference: input.reference || null,
        receivedOn,
        months: input.months,
        paidUntil,
        note: input.note || null,
        recordedBy: ctx.userId,
        recordedAt: now,
      });
      const applied = await applySubscriptionChange(tx, {
        operatorId: op,
        change: { kind: "manual_extend", until: paidUntil },
        now,
        actor: { kind: "user", userId: ctx.userId, role: "platform_admin" },
        source: "admin_offline_payment",
        requestId: ctx.requestId,
      });
      await audit.tenant(tx, op, {
        action: "subscription.offline_payment_recorded",
        entityType: "subscription",
        entityId: op,
        after: {
          amount_paise: input.amountPaise,
          method: input.method,
          months: input.months,
          received_on: receivedOn,
          paid_until: paidUntil,
        },
      });
      return { status: "recorded" as const, paidUntil, missed: applied.missedRunPeriods };
    });
    if (!outcome) return err(notFound());
    await runtime.db.withPlatform((tx) =>
      audit.platform(tx, {
        action: "admin.offline_payment_recorded",
        entityType: "operator",
        entityId: op,
        after: {
          payment_id: input.paymentId,
          status: outcome.status,
          amount_paise: input.amountPaise,
          method: input.method,
          reference: input.reference ?? null,
          months: input.months,
          received_on: receivedOn,
          paid_until: outcome.paidUntil,
        },
      }),
    );
    return ok({
      status: outcome.status,
      paidUntil: outcome.paidUntil,
      missedRunPeriods: outcome.missed,
    });
  },
});

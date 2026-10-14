/**
 * The connection hooks the services call (contract: ../hooks-contract.ts), implemented by T-045
 * (PLAN §8.3, D-14, D-18, BR-07, FR-008):
 *
 * | Hook | What it does to the change's own month (`periodOf(effectiveDate)`) |
 * |---|---|
 * | `onAssignmentStarted` | D-18: `charge_full_month` → a `mid_month_start` debit for the full rental, unless the month's bill charges it itself (a start on the 1st before the month is billed) or it already has rent; `start_next_month` → nothing |
 * | `onAssignmentReactivated` | the same rule ("start again" mid-month) |
 * | `onAssignmentPlanChanged` | T-042 netting: the month's rent becomes the new amount through a `plan_change` debit or credit; nothing when the month has no rent yet (the next bill charges the new amount) |
 *
 * Each runs in the change's transaction with the customer's balance lock held, stores at most one
 * adjustment (with its ledger / credit effect and an audit event, see ../../adjustments/store.ts)
 * and never touches an issued bill. A domain rule refusing the stored rows is a bug: it throws, so
 * the change rolls back as INTERNAL.
 *
 * `connectionHooks` is a plain object so tests can spy on its methods.
 */
import { ok } from "@cb/domain";
import { adjustChangeMonth } from "../../adjustments/apply";
import type { ConnectionHookContext, ConnectionHooks } from "../hooks-contract";

function envOf(hc: ConnectionHookContext) {
  return {
    tx: hc.tx,
    operatorId: hc.ctx.operatorId,
    userId: hc.ctx.userId,
    now: hc.now,
    audit: hc.audit,
  };
}

export const connectionHooks: ConnectionHooks = {
  async onAssignmentStarted(hc, event) {
    await adjustChangeMonth(envOf(hc), {
      kind: "start",
      assignmentId: event.assignment.id,
      effectiveDate: event.effectiveDate,
      eventId: event.eventId,
    });
    return ok(undefined);
  },
  async onAssignmentReactivated(hc, event) {
    await adjustChangeMonth(envOf(hc), {
      kind: "reactivate",
      assignmentId: event.assignment.id,
      effectiveDate: event.effectiveDate,
      eventId: event.eventId,
    });
    return ok(undefined);
  },
  async onAssignmentPlanChanged(hc, event) {
    await adjustChangeMonth(envOf(hc), {
      kind: "plan",
      assignmentId: event.assignment.id,
      effectiveDate: event.effectiveDate,
      eventId: event.eventId,
    });
    return ok(undefined);
  },
};

/**
 * Which months a back-dated new connection must be charged by an explicit adjustment (T-045a).
 *
 * A month P after the start month is **covered** when its bills can no longer pick the connection
 * up by themselves:
 * - P is billed for the customer (T-034's definition: a regular bill, or the run's item
 *   `created` / `already_exists` / `skipped`); or
 * - P has a billing run that is not `skipped` (pending, running, completed, completed with
 *   errors, failed). A completed run never comes back (T-044, D-25) and a running one may have
 *   passed the customer already (`candidateCustomers` only takes customers with a connection or a
 *   pending debit on the 1st, ids ascending). A `mid_month_start` debit for P is safe whatever the
 *   run does next: T-044's per-period guard then bills the debit instead of a rent line, once.
 *   A `skipped` run (read-only tenant, D-25) billed nobody that month and is only billed if the
 *   Owner starts it by hand, which then bills the connection's rent like everyone else's.
 *
 * Every covered month after the start month gets its full rent (T-040 `isBillable` +
 * `rentalForPeriod`, via T-045 `laterMonthEffect`). The **start month** follows the D-18 policy
 * (the T-045 hook), except a start on the 1st: PLAN §8.1 charges a connection active at any time
 * on the 1st the month's full rent, so when that month is covered it is charged like a later
 * month, whatever the policy.
 */
import { billingRuns, type Tx } from "@cb/db";
import {
  comparePeriods,
  isBillable,
  type Period,
  periodOf,
  previousPeriod,
  period as toPeriod,
} from "@cb/domain";
import { and, eq, gte, ne } from "drizzle-orm";
import type { RentalTimeline } from "../effects";
import { billedPeriodsOf } from "../store";

/** The covered months from `from` on (see the module comment). */
export async function coveredPeriods(
  tx: Tx,
  operatorId: string,
  customerId: string,
  from: Period,
): Promise<Set<Period>> {
  const billed = await billedPeriodsOf(tx, operatorId, customerId, previousPeriod(from));
  const runs = await tx
    .selectDistinct({ period: billingRuns.period })
    .from(billingRuns)
    .where(
      and(
        eq(billingRuns.operatorId, operatorId),
        gte(billingRuns.period, from),
        ne(billingRuns.status, "skipped"),
      ),
    );
  return new Set([...billed, ...runs.map((row) => toPeriod(row.period))]);
}

export interface AddPlan {
  readonly startPeriod: Period;
  /** The start is on the 1st and its month is covered: charge it like a later month. */
  readonly startCorrection: boolean;
  /** Covered months after the start month, oldest first. */
  readonly laterMonths: readonly Period[];
  /**
   * The add has months to correct, so it needs the Owner's flow (and a reason). Otherwise it is an
   * ordinary add, and `adjustments.back_dated_add` refuses it.
   */
  readonly needsOwnerFlow: boolean;
}

/** What the add of a connection with `timeline` must correct, given the covered months. */
export function planOfAdd(timeline: RentalTimeline, covered: ReadonlySet<Period>): AddPlan {
  const startPeriod = periodOf(timeline.startDate);
  const startCorrection = isBillable(timeline, startPeriod) && covered.has(startPeriod);
  const laterMonths = [...covered].filter((p) => comparePeriods(p, startPeriod) > 0).sort();
  return {
    startPeriod,
    startCorrection,
    laterMonths,
    needsOwnerFlow: startCorrection || laterMonths.length > 0,
  };
}

/**
 * The connection hooks the services call (contract: ../hooks-contract.ts).
 *
 * T-034 ships **no-op defaults**: starting, reactivating or re-planning a connection creates no
 * adjustment yet. T-045 owns this folder and replaces these with the PLAN §8.3 / D-18 rules
 * (plan-change netting, mid-month start per `mid_month_start_policy`).
 *
 * `connectionHooks` is a plain object so tests can spy on its methods.
 */
import { ok } from "@cb/domain";
import type { ConnectionHooks } from "../hooks-contract";

export const connectionHooks: ConnectionHooks = {
  async onAssignmentStarted() {
    return ok(undefined);
  },
  async onAssignmentReactivated() {
    return ok(undefined);
  },
  async onAssignmentPlanChanged() {
    return ok(undefined);
  },
};

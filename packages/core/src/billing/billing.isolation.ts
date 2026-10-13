/**
 * Tenant isolation cases for the billing run services (T-044, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts.
 *
 * - `retryFailedItems` takes a run id: another tenant's run → NOT_FOUND, nothing written.
 * - `startBillingRun`, `previewBillingRun` and `missedRuns` take no ids (the period only), so they
 *   are `no_leak` cases: the attacker's call must succeed on its own run, never show the victim's
 *   ids and never change the victim's rows.
 */
import { billingRunItems, billingRuns, customers, uuidv7 } from "@cb/db";
import { periodOfInstant } from "@cb/domain";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { missedRuns, previewBillingRun, retryFailedItems, startBillingRun } from "./services";

/** The current IST month (the harness runs on the real clock). */
const thisPeriod = () => periodOfInstant(new Date());

/** A customer and a finished run of the current period with one failed item. */
async function seedRun({ tx, tenant }: IsolationSeedArgs) {
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
  });
  const runId = uuidv7();
  const now = new Date();
  await tx.insert(billingRuns).values({
    id: runId,
    operatorId: tenant.operatorId,
    period: thisPeriod(),
    trigger: "cron",
    status: "completed_with_errors",
    customerCount: 1,
    failedCount: 1,
    startedAt: now,
    finishedAt: now,
  });
  await tx.insert(billingRunItems).values({
    id: uuidv7(),
    operatorId: tenant.operatorId,
    runId,
    customerId,
    outcome: "failed",
    reason: "internal_error",
  });
  return { runId };
}

/** A skipped (missed) run of the current period. */
async function seedSkippedRun({ tx, tenant }: IsolationSeedArgs) {
  const runId = uuidv7();
  await tx.insert(billingRuns).values({
    id: runId,
    operatorId: tenant.operatorId,
    period: thisPeriod(),
    trigger: "cron",
    status: "skipped",
    skipReason: "tenant_read_only",
    finishedAt: new Date(),
  });
  return { runId };
}

export const retryFailedItemsIsolation = defineIsolationCases(retryFailedItems, {
  seed: seedRun,
  cases: [{ name: "retry another tenant's billing run", input: (seed) => ({ runId: seed.runId }) }],
});

export const startBillingRunIsolation = defineIsolationCases(startBillingRun, {
  seed: seedRun,
  cases: [
    {
      name: "starting the period's run touches only the tenant's own run",
      expect: "no_leak",
      input: () => ({ period: thisPeriod() }),
    },
  ],
});

export const previewBillingRunIsolation = defineIsolationCases(previewBillingRun, {
  seed: seedRun,
  cases: [
    {
      name: "the preview shows only the tenant's own run and customers",
      expect: "no_leak",
      input: () => ({ period: thisPeriod() }),
    },
  ],
});

export const missedRunsIsolation = defineIsolationCases(missedRuns, {
  seed: seedSkippedRun,
  cases: [
    {
      name: "missed runs lists only the tenant's own skipped runs",
      expect: "no_leak",
      input: () => ({}),
    },
  ],
});

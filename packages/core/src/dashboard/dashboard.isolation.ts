/**
 * Tenant isolation case for the Home page read (T-083, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: each tenant gets a bill run, a payment, a flagged payment and a
 * waiting handover; the Home read of tenant A names only A's run (the control) and nothing of B's,
 * and changes nothing. That A's numbers leave B's rows out is tested in home.test.ts (a second busy
 * tenant changes none of the first tenant's numbers).
 */
import { billingRuns, customers, uuidv7 } from "@cb/db";
import { businessDateOf, periodOfInstant } from "@cb/domain";
import { submitHandoverInTx } from "../collections/handover";
import { postPaymentInTx } from "../payments/post-payment";
import { defineIsolationCases, type IsolationSeedArgs } from "../testing/isolation";
import { homeDashboard } from "./home";

async function seedBusyDay({ tx, tenant }: IsolationSeedArgs) {
  const now = new Date();
  const runId = uuidv7();
  // The current month's run: the newest run, so Home shows (and names) it.
  await tx.insert(billingRuns).values({
    id: runId,
    operatorId: tenant.operatorId,
    period: periodOfInstant(now),
    trigger: "cron",
    status: "completed",
    startedAt: now,
    finishedAt: now,
  });
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
    status: "inactive",
  });
  // A counter payment from a closed customer: counted today and flagged to check.
  const posted = await postPaymentInTx(
    tx,
    { operatorId: tenant.operatorId, userId: tenant.users.owner, channel: "web", deviceId: null },
    { id: uuidv7(), customerId, amountPaise: 50_000, method: "cash" },
    now,
  );
  if (!posted.ok) throw new Error(`seed payment: ${posted.error.code}`);
  const handed = await submitHandoverInTx(
    tx,
    { operatorId: tenant.operatorId, userId: tenant.users.lineman },
    {
      businessDate: businessDateOf(now),
      submissionId: uuidv7(),
      cashHandedOverPaise: 0,
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    },
    now,
  );
  if (!handed.ok) throw new Error(`seed handover: ${handed.error.code}`);
  return { runId };
}

export const homeDashboardIsolation = defineIsolationCases(homeDashboard, {
  seed: seedBusyDay,
  cases: [
    {
      name: "Home shows only the tenant's own numbers, run and alerts",
      expect: "no_leak",
      input: () => ({}),
    },
  ],
});

/**
 * Tenant isolation cases for the operations reports (T-081, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts. Each tenant gets an area, a plan, a customer with an active
 * connection, today's phone cash payment by its lineman with a handover, and this month's bill run
 * that looked at the customer. The lists take no ids (`no_leak`); every filter id of another
 * tenant (person, area, plan) is NOT_FOUND.
 */
import {
  areas,
  assignmentEvents,
  billingRunItems,
  billingRuns,
  customers,
  plans,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { addDays, businessDateOf, periodOfInstant } from "@cb/domain";
import { submitHandoverInTx } from "../../collections/handover";
import { postPaymentInTx } from "../../payments/post-payment";
import { defineIsolationCases, type IsolationSeedArgs } from "../../testing/isolation";
import { billingRunReport } from "./billing-runs";
import { collectionsReport } from "./collections";
import { connectionsReport } from "./connections";
import { handoverReport } from "./handover";

async function seedOperations({ tx, tenant }: IsolationSeedArgs) {
  const operatorId = tenant.operatorId;
  const now = new Date();
  const today = businessDateOf(now);
  const areaId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId, name: "North" });
  const planId = uuidv7();
  await tx
    .insert(plans)
    .values({ id: planId, operatorId, name: "Basic", monthlyAmountPaise: 30_000 });
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
    areaId,
  });
  const vcAssetId = uuidv7();
  await tx
    .insert(vcAssets)
    .values({ id: vcAssetId, operatorId, vcNumber: `VC${vcAssetId.slice(-8)}` });
  const assignmentId = uuidv7();
  const startDate = addDays(today, -5);
  await tx.insert(vcAssignments).values({
    id: assignmentId,
    operatorId,
    vcAssetId,
    customerId,
    startDate,
    planId,
    rentalAmountPaise: 30_000,
  });
  await tx.insert(assignmentEvents).values({
    id: uuidv7(),
    operatorId,
    assignmentId,
    type: "activated",
    effectiveDate: startDate,
  });

  // Today's cash, taken on the lineman's phone, then handed over.
  const posted = await postPaymentInTx(
    tx,
    {
      operatorId,
      userId: tenant.users.lineman,
      channel: "mobile",
      deviceId: tenant.deviceId,
    },
    {
      id: uuidv7(),
      customerId,
      amountPaise: 20_000,
      method: "cash",
      recordedAt: new Date(now.getTime() - 60_000),
      provisionalRef: "P-ISO-0001",
    },
    new Date(now.getTime() - 60_000),
  );
  if (!posted.ok) throw new Error(`seed payment: ${posted.error.code}`);
  const handed = await submitHandoverInTx(
    tx,
    { operatorId, userId: tenant.users.lineman },
    {
      businessDate: today,
      submissionId: uuidv7(),
      cashHandedOverPaise: 20_000,
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    },
    new Date(now.getTime() - 30_000),
  );
  if (!handed.ok) throw new Error(`seed handover: ${handed.error.code}`);

  // This month's bill run looked at the customer (nothing to bill, so no bill is needed).
  const runId = uuidv7();
  await tx.insert(billingRuns).values({
    id: runId,
    operatorId,
    period: periodOfInstant(now),
    trigger: "cron",
    status: "completed",
    customerCount: 1,
    skippedCount: 1,
    startedAt: now,
    finishedAt: now,
  });
  await tx.insert(billingRunItems).values({
    id: uuidv7(),
    operatorId,
    runId,
    customerId,
    outcome: "skipped",
    reason: "nothing_to_bill",
  });

  return {
    areaId,
    planId,
    customerId,
    assignmentId,
    linemanId: tenant.users.lineman,
    sessionId: handed.value.day.sessionId,
    runId,
  };
}

export const collectionsReportIsolation = defineIsolationCases(collectionsReport, {
  seed: seedOperations,
  cases: [
    {
      name: "the collections report lists only the tenant's own payments and people",
      expect: "no_leak",
      input: () => ({}),
    },
    {
      name: "the collections report for another tenant's lineman",
      input: (seed) => ({ collectorId: seed.linemanId }),
    },
  ],
});

export const handoverReportIsolation = defineIsolationCases(handoverReport, {
  seed: seedOperations,
  cases: [
    {
      name: "the handover report lists only the tenant's own linemen's days",
      expect: "no_leak",
      input: () => ({}),
    },
    {
      name: "the handover report for another tenant's lineman",
      input: (seed) => ({ linemanId: seed.linemanId }),
    },
  ],
});

export const connectionsReportIsolation = defineIsolationCases(connectionsReport, {
  seed: seedOperations,
  cases: [
    {
      name: "the connections report lists only the tenant's own connections",
      expect: "no_leak",
      input: () => ({}),
    },
    {
      name: "the connections report filtered by another tenant's area",
      input: (seed) => ({ areaId: seed.areaId }),
    },
    {
      name: "the connections report filtered by another tenant's plan",
      input: (seed) => ({ plan: seed.planId }),
    },
  ],
});

export const billingRunReportIsolation = defineIsolationCases(billingRunReport, {
  seed: seedOperations,
  cases: [
    {
      name: "the bill run report shows only the tenant's own run and customers",
      expect: "no_leak",
      input: () => ({}),
    },
    {
      name: "the bill run report filtered by another tenant's area",
      input: (seed) => ({ areaId: seed.areaId }),
    },
  ],
});

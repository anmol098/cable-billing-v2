/**
 * Tenant isolation cases for the Bills read services (T-047, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts.
 *
 * - `billingRunProblems`, `billingCustomerLabels`, `getBill` and `listBills` with an area take
 *   ids: another tenant's id → NOT_FOUND, nothing written.
 * - `billingMonths` and `listBills` without an area take a period only: `no_leak` cases (the
 *   tenant's own run / bills are listed, never the other tenant's).
 */
import { areas, billingRunItems, billingRuns, customers, invoices, uuidv7 } from "@cb/db";
import { periodOfInstant } from "@cb/domain";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { billingCustomerLabels, billingMonths, billingRunProblems, getBill, listBills } from "./views";

/** The current IST month (the harness runs on the real clock). */
const thisPeriod = () => periodOfInstant(new Date());

/** An area, a customer in it, the month's bill, and a finished run with one failed item. */
async function seedBills({ tx, tenant }: IsolationSeedArgs) {
  const operatorId = tenant.operatorId;
  const areaId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId, name: "North" });
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
    areaId,
  });
  const invoiceId = uuidv7();
  await tx.insert(invoices).values({
    id: invoiceId,
    operatorId,
    customerId,
    period: thisPeriod(),
    invoiceNumber: `INV-ISO-${invoiceId.slice(-6)}`,
    openingBalancePaise: 0,
    chargesPaise: 30_000,
    totalDuePaise: 30_000,
  });
  const runId = uuidv7();
  const now = new Date();
  await tx.insert(billingRuns).values({
    id: runId,
    operatorId,
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
    operatorId,
    runId,
    customerId,
    outcome: "failed",
    reason: "internal_error",
  });
  return { areaId, customerId, invoiceId, runId };
}

export const billingMonthsIsolation = defineIsolationCases(billingMonths, {
  seed: seedBills,
  cases: [
    {
      name: "the calendar shows only the tenant's own runs",
      expect: "no_leak",
      input: () => ({ from: thisPeriod(), to: thisPeriod() }),
    },
  ],
});

export const billingRunProblemsIsolation = defineIsolationCases(billingRunProblems, {
  seed: seedBills,
  cases: [
    { name: "problems of another tenant's billing run", input: (seed) => ({ runId: seed.runId }) },
  ],
});

export const billingCustomerLabelsIsolation = defineIsolationCases(billingCustomerLabels, {
  seed: seedBills,
  cases: [
    {
      name: "names of another tenant's customers",
      input: (seed) => ({ customerIds: [seed.customerId] }),
    },
  ],
});

export const listBillsIsolation = defineIsolationCases(listBills, {
  seed: seedBills,
  cases: [
    {
      name: "the bill register lists only the tenant's own bills",
      expect: "no_leak",
      input: () => ({ period: thisPeriod() }),
    },
    {
      name: "the bill register filtered by another tenant's area",
      input: (seed) => ({ period: thisPeriod(), areaId: seed.areaId }),
    },
  ],
});

export const getBillIsolation = defineIsolationCases(getBill, {
  seed: seedBills,
  cases: [{ name: "open another tenant's bill", input: (seed) => ({ invoiceId: seed.invoiceId }) }],
});

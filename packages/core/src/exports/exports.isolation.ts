/**
 * Tenant isolation cases for `exports.download` (T-082, RULE-22, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts. Every id an export filter can name (area, person, customer, plan)
 * must be the tenant's own: another tenant's is NOT_FOUND and writes nothing (no audit event).
 * The rows themselves come from services with their own isolation cases (customers.search,
 * payments.list, reports.*); ./exports.test.ts checks whole exports of two tenants.
 */
import { areas, customers, plans, uuidv7 } from "@cb/db";
import { businessDateOf, periodOfInstant } from "@cb/domain";
import { defineIsolationCases, type IsolationSeedArgs } from "../testing/isolation";
import { startExport } from "./service";

async function seedExportFilters({ tx, tenant }: IsolationSeedArgs) {
  const operatorId = tenant.operatorId;
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
    customerCode: `EXP-${customerId.slice(-6)}`,
    name: "Export customer",
    areaId,
  });
  return { areaId, planId, customerId, linemanId: tenant.users.lineman };
}

const today = () => businessDateOf(new Date());
const thisMonth = () => periodOfInstant(new Date());

export const startExportIsolation = defineIsolationCases(startExport, {
  seed: seedExportFilters,
  cases: [
    {
      name: "an export names only the tenant's own filters",
      expect: "no_leak",
      input: (seed) => ({ kind: "dues" as const, filters: { areaId: seed.areaId } }),
    },
    {
      name: "the customer list of another tenant's area",
      input: (seed) => ({ kind: "customers" as const, filters: { areaId: seed.areaId } }),
    },
    {
      name: "the bill register of another tenant's area",
      input: (seed) => ({
        kind: "bills" as const,
        filters: { from: thisMonth(), to: thisMonth(), areaId: seed.areaId },
      }),
    },
    {
      name: "the payment register of another tenant's lineman",
      input: (seed) => ({ kind: "payments" as const, filters: { collectorId: seed.linemanId } }),
    },
    {
      name: "the payment register of another tenant's customer",
      input: (seed) => ({ kind: "payments" as const, filters: { customerId: seed.customerId } }),
    },
    {
      name: "the daily collection of another tenant's lineman",
      input: (seed) => ({ kind: "collections" as const, filters: { collectorId: seed.linemanId } }),
    },
    {
      name: "the cash handovers of another tenant's lineman",
      input: (seed) => ({ kind: "handover" as const, filters: { linemanId: seed.linemanId } }),
    },
    {
      name: "the connections of another tenant's plan",
      input: (seed) => ({ kind: "connections" as const, filters: { date: today(), plan: seed.planId } }),
    },
    {
      name: "a bill run of another tenant's area",
      input: (seed) => ({ kind: "billing_runs" as const, filters: { areaId: seed.areaId } }),
    },
  ],
});

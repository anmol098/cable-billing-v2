/**
 * Tenant isolation cases for the plan services (T-031, PLAN §9.1, §16). Changing, retiring or
 * restoring another tenant's plan answers NOT_FOUND and changes nothing; the list shows only the
 * caller's own plans; adding a plan writes only to the caller's tenant (and a name used by another
 * tenant is free: the unique name is per operator).
 */
import { plans, uuidv7 } from "@cb/db";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { createPlan, listPlans, restorePlan, retirePlan, updatePlan } from "./plans";

async function seedPlan({ tx, tenant }: IsolationSeedArgs) {
  const planId = uuidv7();
  await tx.insert(plans).values({
    id: planId,
    operatorId: tenant.operatorId,
    name: "Basic",
    monthlyAmountPaise: 25_000,
  });
  return { planId };
}

async function seedRetiredPlan({ tx, tenant }: IsolationSeedArgs) {
  const planId = uuidv7();
  await tx.insert(plans).values({
    id: planId,
    operatorId: tenant.operatorId,
    name: "Old sports",
    monthlyAmountPaise: 40_000,
    status: "retired",
  });
  return { planId };
}

export const listPlansIsolation = defineIsolationCases(listPlans, {
  seed: seedPlan,
  cases: [
    { name: "list shows only own plans", expect: "no_leak", input: () => ({}) },
    {
      name: "picker list shows only own plans",
      expect: "no_leak",
      input: () => ({ includeRetired: false }),
    },
  ],
});

export const createPlanIsolation = defineIsolationCases(createPlan, {
  // Nothing to find: the case checks the write lands only in the caller's tenant.
  seed: async () => ({}),
  cases: [
    {
      name: "add a plan only to the own tenant (same name as the other tenant's)",
      expect: "no_leak",
      input: () => ({ name: "Basic", monthlyAmountPaise: 30_000 }),
    },
  ],
});

export const updatePlanIsolation = defineIsolationCases(updatePlan, {
  seed: seedPlan,
  cases: [
    {
      name: "change another tenant's plan price",
      input: (s) => ({ planId: s.planId, name: "Basic", monthlyAmountPaise: 1_000 }),
    },
    {
      name: "rename another tenant's plan",
      input: (s) => ({ planId: s.planId, name: "Taken over", monthlyAmountPaise: 25_000 }),
    },
  ],
});

export const retirePlanIsolation = defineIsolationCases(retirePlan, {
  seed: seedPlan,
  cases: [{ name: "hide another tenant's plan", input: (s) => ({ planId: s.planId }) }],
});

export const restorePlanIsolation = defineIsolationCases(restorePlan, {
  seed: seedRetiredPlan,
  cases: [{ name: "show another tenant's hidden plan", input: (s) => ({ planId: s.planId }) }],
});

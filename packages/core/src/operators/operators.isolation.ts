/**
 * Tenant isolation cases for the business profile services (T-030, PLAN §9.1, §16). Neither takes
 * an id: the operator is always `ctx.operatorId`. The cases prove that reading returns only the
 * caller's own operator, and that saving changes only the caller's own row (the other tenant's
 * rows are byte-identical afterwards).
 */
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { getBusinessProfile, updateBusinessProfile } from "./profile";

/** The tenant's own operator id, so the control requires it in the output. */
async function seedOperator({ tenant }: IsolationSeedArgs) {
  return { operatorId: tenant.operatorId };
}

export const getBusinessProfileIsolation = defineIsolationCases(getBusinessProfile, {
  seed: seedOperator,
  cases: [{ name: "read only the own business profile", expect: "no_leak", input: () => ({}) }],
});

export const updateBusinessProfileIsolation = defineIsolationCases(updateBusinessProfile, {
  seed: seedOperator,
  cases: [
    {
      name: "save changes only the own business profile",
      expect: "no_leak",
      input: () => ({
        name: "Isolation Cable",
        phone: "+91 98765 43210",
        address: "",
        receiptFooter: "Thank you",
        invoicePrefix: "ISO",
        defaultLanguage: "en" as const,
        midMonthStartPolicy: "charge_full_month" as const,
      }),
    },
  ],
});

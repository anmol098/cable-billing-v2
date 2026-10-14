/**
 * Tenant isolation cases for the subscription services (T-085, PLAN §9.1, §16). Neither takes a
 * tenant id: the subscription is always `ctx.operatorId`'s. The cases prove the overview shows only
 * the caller's own subscription, and recording a checkout changes only the caller's own row.
 */
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { recordCheckoutSubscription, subscriptionOverview } from "./services";

let sequence = 0;

async function seedTenant({ tenant }: IsolationSeedArgs) {
  sequence += 1;
  const unique = `${Date.now().toString(36)}${sequence}`.replace(/[^A-Za-z0-9]/g, "");
  return { operatorId: tenant.operatorId, subscriptionId: `sub_Iso${unique}` };
}

export const subscriptionOverviewIsolation = defineIsolationCases(subscriptionOverview, {
  seed: seedTenant,
  cases: [{ name: "see only the own subscription", expect: "no_leak", input: () => ({}) }],
});

export const recordCheckoutSubscriptionIsolation = defineIsolationCases(
  recordCheckoutSubscription,
  {
    seed: seedTenant,
    cases: [
      {
        name: "recording a checkout changes only the own subscription",
        expect: "no_leak",
        input: (seed) => ({ razorpaySubscriptionId: seed.subscriptionId }),
      },
    ],
  },
);

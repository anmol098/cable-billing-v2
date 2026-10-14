/**
 * Tenant isolation cases for the Owner's back-dated new connection (T-045a, PLAN §9.1, §16). Run
 * by src/testing/isolation.test.ts: as tenant A with tenant B's ids every call is NOT_FOUND with
 * nothing written anywhere; with A's own ids it gets past the lookups.
 *
 * Limit: the harness gives a case the victim's seed for the attack, so "A's own customer with B's
 * plan" can't be expressed here; the "with its plan" cases stop at the customer lookup (as
 * T-034's "add a VC on another tenant's plan" does). ./scenarios.test.ts covers it directly: A's
 * Owner with A's customer and B's plan id → NOT_FOUND for the add and the preview, nothing written.
 */
import { customers, plans, uuidv7 } from "@cb/db";
import { businessDateOf } from "@cb/domain";
import type { IsolationSeedArgs } from "../../testing/isolation";
import { defineIsolationCases } from "../../testing/isolation";
import { backDatedAddConnection, previewAddConnection } from "./services";

/** A customer and a plan of the tenant. */
async function seedCustomer({ tx, tenant }: IsolationSeedArgs) {
  const op = tenant.operatorId;
  const customerId = uuidv7();
  const planId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: op,
    customerCode: `BDA-${customerId.slice(-6)}`,
    name: "Isolation Kamla",
  });
  await tx.insert(plans).values({
    id: planId,
    operatorId: op,
    name: `Isolation plan ${planId.slice(-4)}`,
    monthlyAmountPaise: 30_000,
  });
  return { customerId, planId };
}

/** Today (IST) when the case runs: the harness runtime uses the real clock. */
const today = () => businessDateOf(new Date());

/** A VC number nobody else uses (one per seed). */
const vcOf = (customerId: string) => `ISOBDA${customerId.replace(/-/g, "").slice(-12)}`;

export const backDatedAddConnectionIsolation = defineIsolationCases(backDatedAddConnection, {
  seed: seedCustomer,
  cases: [
    {
      name: "a back-dated connection on another tenant's customer (own amount)",
      input: (seed) => ({
        customerId: seed.customerId,
        vcNumber: vcOf(seed.customerId),
        rentalPaise: 25_000,
        startDate: today(),
        reason: "Isolation attempt",
        expectedTotalPaise: 0,
      }),
      // The attacker's own customer has no billed month: the add is refused as not back-dated
      // (VALIDATION), after the customer lookup that this case proves.
      control: "not_not_found",
    },
    {
      name: "a back-dated connection on another tenant's customer with its plan",
      input: (seed) => ({
        customerId: seed.customerId,
        vcNumber: vcOf(seed.customerId),
        planId: seed.planId,
        startDate: today(),
        reason: "Isolation attempt",
        expectedTotalPaise: 0,
      }),
      // The attacker's own customer has no billed month: the add is refused as not back-dated
      // (VALIDATION), after the customer lookup that this case proves.
      control: "not_not_found",
    },
  ],
});

export const previewAddConnectionIsolation = defineIsolationCases(previewAddConnection, {
  seed: seedCustomer,
  cases: [
    {
      name: "preview a new connection on another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId, rentalPaise: 25_000, startDate: today() }),
    },
    {
      name: "preview a new connection with another tenant's customer and plan",
      input: (seed) => ({ customerId: seed.customerId, planId: seed.planId, startDate: today() }),
    },
  ],
});

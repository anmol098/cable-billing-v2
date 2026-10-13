/**
 * Tenant isolation cases for the customer services (T-033, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: as tenant A with tenant B's ids every call is NOT_FOUND with
 * nothing written anywhere; lists and searches never show B's customers.
 */
import { areas, customers, uuidv7, vcAssets, vcAssignments } from "@cb/db";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import {
  createCustomer,
  setCustomerStatus,
  updateCustomer,
  updateCustomerPhone,
} from "./customers";
import { customerFormOptions, getCustomer, searchCustomers } from "./queries";

/** One area and one customer in it (code, phone and a VC number all start with "ISO"/"98"). */
async function seedCustomer({ tx, tenant }: IsolationSeedArgs) {
  const areaId = uuidv7();
  const customerId = uuidv7();
  const vcAssetId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId: tenant.operatorId, name: "Iso Nagar" });
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation Kumar",
    phone: "9876500001",
    areaId,
  });
  await tx.insert(vcAssets).values({
    id: vcAssetId,
    operatorId: tenant.operatorId,
    vcNumber: `555${customerId.slice(-9).replace(/[^0-9]/g, "1")}`,
  });
  await tx.insert(vcAssignments).values({
    id: uuidv7(),
    operatorId: tenant.operatorId,
    vcAssetId,
    customerId,
    startDate: "2026-10-01",
    rentalAmountPaise: 30_000,
  });
  return { areaId, customerId };
}

/** A fresh code per call, so the control (own area) can't collide with an earlier call. */
const freshCode = () => `NEW-${uuidv7().slice(-8)}`;

export const createCustomerIsolation = defineIsolationCases(createCustomer, {
  seed: seedCustomer,
  cases: [
    {
      name: "add a customer in another tenant's area",
      input: (seed) => ({ customerCode: freshCode(), name: "Attacker", areaId: seed.areaId }),
    },
  ],
});

export const updateCustomerIsolation = defineIsolationCases(updateCustomer, {
  seed: seedCustomer,
  cases: [
    {
      name: "edit another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId, name: "Changed", phone: "9876500002" }),
    },
    {
      name: "move a customer to another tenant's area",
      // Victim ids for both: the customer lookup fails first. The control moves the tenant's own
      // customer to its own area (already there: no change, still ok).
      input: (seed) => ({ customerId: seed.customerId, areaId: seed.areaId }),
    },
  ],
});

export const setCustomerStatusIsolation = defineIsolationCases(setCustomerStatus, {
  seed: seedCustomer,
  cases: [
    {
      name: "reactivate another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId, status: "active" as const }),
    },
  ],
});

export const updateCustomerPhoneIsolation = defineIsolationCases(updateCustomerPhone, {
  seed: seedCustomer,
  cases: [
    {
      name: "change another tenant's customer's phone",
      input: (seed) => ({ customerId: seed.customerId, phone: "9876500003" }),
    },
  ],
});

export const getCustomerIsolation = defineIsolationCases(getCustomer, {
  seed: seedCustomer,
  cases: [
    {
      name: "open another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId }),
    },
  ],
});

export const searchCustomersIsolation = defineIsolationCases(searchCustomers, {
  seed: seedCustomer,
  cases: [
    { name: "list every customer", expect: "no_leak", input: () => ({}) },
    { name: "search by code", expect: "no_leak", input: () => ({ q: "iso" }) },
    { name: "search by phone", expect: "no_leak", input: () => ({ q: "98765 00001" }) },
    { name: "search by VC number", expect: "no_leak", input: () => ({ q: "555" }) },
    { name: "search by name with a typo", expect: "no_leak", input: () => ({ q: "isolaton" }) },
    {
      name: "filter by another tenant's area",
      input: (seed) => ({ areaId: seed.areaId }),
    },
  ],
});

export const customerFormOptionsIsolation = defineIsolationCases(customerFormOptions, {
  seed: seedCustomer,
  cases: [{ name: "areas for the form", expect: "no_leak", input: () => ({}) }],
});

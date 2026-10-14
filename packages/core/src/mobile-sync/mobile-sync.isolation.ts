/**
 * Tenant isolation cases for the mobile sync services (T-060, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: the roster of tenant A never contains tenant B's customers (full
 * and delta), and B's customer ids are NOT_FOUND for A with nothing written anywhere. A cursor made
 * for another tenant is refused with CURSOR_INVALID (mobile-sync.test.ts).
 */
import { areas, customerBalances, customers, uuidv7, vcAssets, vcAssignments } from "@cb/db";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { encodeCursor } from "./cursor";
import { getRosterCustomer, getRosterCustomerDetail, syncRoster } from "./services";

/** An area, an active customer with a VC and a balance, and an inactive customer. */
async function seedRoster({ tx, tenant }: IsolationSeedArgs) {
  const areaId = uuidv7();
  const customerId = uuidv7();
  const closedId = uuidv7();
  const vcAssetId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId: tenant.operatorId, name: "Iso Nagar" });
  await tx.insert(customers).values([
    {
      id: customerId,
      operatorId: tenant.operatorId,
      customerCode: `ISO-${customerId.slice(-6)}`,
      name: "Isolation Kumar",
      phone: "9876500001",
      areaId,
    },
    {
      id: closedId,
      operatorId: tenant.operatorId,
      customerCode: `ISX-${closedId.slice(-6)}`,
      name: "Closed Kumar",
      status: "inactive",
    },
  ]);
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
  await tx
    .insert(customerBalances)
    .values({ customerId, operatorId: tenant.operatorId, balancePaise: 30_000 });
  return { areaId, customerId, closedId };
}

export const syncRosterIsolation = defineIsolationCases(syncRoster, {
  seed: seedRoster,
  cases: [
    { name: "full roster sync", expect: "no_leak", input: () => ({}) },
    { name: "one-row pages", expect: "no_leak", input: () => ({ limit: 1 }) },
    {
      name: "delta from the beginning (tombstones too)",
      expect: "no_leak",
      // A delta pass from xid 0 for the caller's own tenant: every row, inactive ones as ids.
      input: (_seed, tenant) => ({
        cursor: encodeCursor({ operatorId: tenant.operatorId, watermark: "0", full: false }),
      }),
    },
  ],
});

export const getRosterCustomerDetailIsolation = defineIsolationCases(getRosterCustomerDetail, {
  seed: seedRoster,
  cases: [
    {
      name: "open another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId }),
    },
    {
      name: "open another tenant's closed customer",
      input: (seed) => ({ customerId: seed.closedId }),
    },
  ],
});

export const getRosterCustomerIsolation = defineIsolationCases(getRosterCustomer, {
  seed: seedRoster,
  cases: [
    {
      name: "read another tenant's roster row",
      input: (seed) => ({ customerId: seed.customerId }),
    },
  ],
});

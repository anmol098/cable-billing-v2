/**
 * Tenant isolation cases for the customer import (T-084, PLAN §9.1, §16). The import takes no ids:
 * it matches customer codes, area names, plan names and VC numbers. Both tenants get the **same**
 * names and numbers, so a lookup that ignored the tenant would answer with the other tenant's
 * rows: as tenant A, every id in the result must be A's (the seeded customer's code comes back as
 * "already there" with A's id), never B's, and B's rows never change.
 */
import { areas, customers, plans, uuidv7, vcAssets, vcAssignments } from "@cb/db";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { IMPORT_FIELDS, type ImportField } from "./columns";
import { applyCustomerImport, checkCustomerImport } from "./services";

async function seedImportTargets({ tx, tenant }: IsolationSeedArgs) {
  const areaId = uuidv7();
  const planId = uuidv7();
  const customerId = uuidv7();
  const vcAssetId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId: tenant.operatorId, name: "Iso Ward" });
  await tx.insert(plans).values({
    id: planId,
    operatorId: tenant.operatorId,
    name: "Iso Plan",
    monthlyAmountPaise: 30_000,
  });
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: "ISO-1",
    name: "Isolation Kumar",
    areaId,
  });
  await tx
    .insert(vcAssets)
    .values({ id: vcAssetId, operatorId: tenant.operatorId, vcNumber: "ISO-VC-1" });
  await tx.insert(vcAssignments).values({
    id: uuidv7(),
    operatorId: tenant.operatorId,
    vcAssetId,
    customerId,
    startDate: "2026-09-01",
    planId,
    rentalAmountPaise: 30_000,
  });
  return { areaId, planId, customerId };
}

function line(n: number, values: Partial<Record<ImportField, string>>) {
  const all = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ""])) as Record<ImportField, string>;
  return { line: n, values: { ...all, ...values } };
}

/** The seeded code (→ "already there"), names and a VC that exist in both tenants. */
const lines = () => [
  line(2, { code: "iso-1", name: "Isolation Kumar" }),
  line(3, {
    code: `NEW-${uuidv7().slice(-8)}`,
    name: "New Person",
    area: "Iso Ward",
    vcNumber: `NEWVC${uuidv7().slice(-8)}`,
    plan: "Iso Plan",
  }),
  line(4, {
    code: `NEW-${uuidv7().slice(-8)}`,
    name: "Box Taken",
    vcNumber: "ISO-VC-1",
    rent: "100",
  }),
];

export const checkCustomerImportIsolation = defineIsolationCases(checkCustomerImport, {
  seed: seedImportTargets,
  cases: [
    {
      name: "preview matches codes, areas, plans and VCs only in the caller's business",
      expect: "no_leak",
      input: () => ({ lines: lines() }),
    },
  ],
});

export const applyCustomerImportIsolation = defineIsolationCases(applyCustomerImport, {
  seed: seedImportTargets,
  cases: [
    {
      name: "import matches codes, areas, plans and VCs only in the caller's business",
      expect: "no_leak",
      input: () => ({ lines: lines() }),
    },
  ],
});

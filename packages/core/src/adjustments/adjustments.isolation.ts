/**
 * Tenant isolation cases for the adjustment services (T-045, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: as tenant A with tenant B's ids every call is NOT_FOUND with
 * nothing written anywhere; the bill changes list never shows B's rows.
 */
import { adjustments, assignmentEvents, customers, uuidv7, vcAssets, vcAssignments } from "@cb/db";
import { businessDateOf } from "@cb/domain";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import {
  backDatedConnectionChange,
  connectionChargedMonths,
  createManualAdjustment,
  listAdjustments,
  previewConnectionChange,
} from "./services";

/** A customer with one active connection (since 2025) and one manual bill change. */
async function seedAdjustments({ tx, tenant }: IsolationSeedArgs) {
  const op = tenant.operatorId;
  const customerId = uuidv7();
  const assetId = uuidv7();
  const assignmentId = uuidv7();
  const adjustmentId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: op,
    customerCode: `ADJ-${customerId.slice(-6)}`,
    name: "Isolation Devi",
  });
  await tx.insert(vcAssets).values({ id: assetId, operatorId: op, vcNumber: `ISO${assetId}` });
  await tx.insert(vcAssignments).values({
    id: assignmentId,
    operatorId: op,
    vcAssetId: assetId,
    customerId,
    startDate: "2025-01-01",
    status: "active",
    rentalAmountPaise: 30_000,
  });
  await tx.insert(assignmentEvents).values({
    id: uuidv7(),
    operatorId: op,
    assignmentId,
    type: "activated",
    effectiveDate: "2025-01-01",
    at: new Date("2025-01-01T06:00:00Z"),
  });
  await tx.insert(adjustments).values({
    id: adjustmentId,
    operatorId: op,
    customerId,
    direction: "debit",
    amountPaise: 5_000,
    source: "manual",
    reason: "Isolation repair visit",
    createdBy: tenant.users.owner,
  });
  return { customerId, assignmentId, adjustmentId };
}

/** Today (IST) when the case runs: the harness runtime uses the real clock. */
const today = () => businessDateOf(new Date());

export const createManualAdjustmentIsolation = defineIsolationCases(createManualAdjustment, {
  seed: seedAdjustments,
  cases: [
    {
      name: "a bill change on another tenant's customer",
      input: (seed) => ({
        id: uuidv7(),
        customerId: seed.customerId,
        direction: "credit" as const,
        amountPaise: 1_000,
        reason: "Isolation attempt",
      }),
    },
    {
      name: "a bill change on another tenant's connection",
      input: (seed) => ({
        id: uuidv7(),
        customerId: seed.customerId,
        assignmentId: seed.assignmentId,
        direction: "debit" as const,
        amountPaise: 1_000,
        reason: "Isolation attempt",
      }),
    },
  ],
});

export const backDatedConnectionChangeIsolation = defineIsolationCases(backDatedConnectionChange, {
  seed: seedAdjustments,
  cases: [
    {
      name: "a back-dated plan change on another tenant's connection",
      input: (seed) => ({
        assignmentId: seed.assignmentId,
        effectiveDate: today(),
        change: { kind: "plan" as const, rentalPaise: 12_300 },
        reason: "Isolation attempt",
      }),
    },
  ],
});

export const previewConnectionChangeIsolation = defineIsolationCases(previewConnectionChange, {
  seed: seedAdjustments,
  cases: [
    {
      name: "preview a change on another tenant's connection",
      input: (seed) => ({
        assignmentId: seed.assignmentId,
        effectiveDate: today(),
        change: { kind: "suspend" as const },
      }),
    },
  ],
});

export const connectionChargedMonthsIsolation = defineIsolationCases(connectionChargedMonths, {
  seed: seedAdjustments,
  cases: [
    {
      name: "charged months of another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId }),
    },
  ],
});

export const listAdjustmentsIsolation = defineIsolationCases(listAdjustments, {
  seed: seedAdjustments,
  cases: [
    { name: "list the bill changes", expect: "no_leak", input: () => ({}) },
    {
      name: "list the manual bill changes",
      expect: "no_leak",
      input: () => ({ source: "manual" as const }),
    },
    {
      name: "list another tenant's customer's bill changes",
      input: (seed) => ({ customerId: seed.customerId }),
    },
  ],
});

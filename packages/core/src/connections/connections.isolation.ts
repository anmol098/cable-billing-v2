/**
 * Tenant isolation cases for the connection services (T-034, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: as tenant A with tenant B's ids every call is NOT_FOUND with
 * nothing written anywhere; the plan list never shows B's plans.
 */
import { areas, assignmentEvents, customers, plans, uuidv7, vcAssets, vcAssignments } from "@cb/db";
import { businessDateOf } from "@cb/domain";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { connectionFormOptions, listConnections } from "./queries";
import {
  addConnection,
  changeConnectionPlan,
  createCustomerWithConnections,
  disconnectConnection,
  reactivateConnection,
  suspendConnection,
} from "./services";

/**
 * An area, an active plan, and an active customer with two connections started in 2025: one
 * active (own amount ₹300), one stopped since June 2025.
 */
async function seedConnections({ tx, tenant }: IsolationSeedArgs) {
  const op = tenant.operatorId;
  const areaId = uuidv7();
  const planId = uuidv7();
  const customerId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId: op, name: "Iso Nagar" });
  await tx
    .insert(plans)
    .values({ id: planId, operatorId: op, name: "Iso Basic", monthlyAmountPaise: 25_000 });
  await tx.insert(customers).values({
    id: customerId,
    operatorId: op,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation Kumar",
    areaId,
  });
  const connection = async (status: "active" | "suspended") => {
    const assetId = uuidv7();
    const assignmentId = uuidv7();
    await tx.insert(vcAssets).values({ id: assetId, operatorId: op, vcNumber: `ISO${assetId}` });
    await tx.insert(vcAssignments).values({
      id: assignmentId,
      operatorId: op,
      vcAssetId: assetId,
      customerId,
      startDate: "2025-01-01",
      status,
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
    if (status === "suspended") {
      await tx.insert(assignmentEvents).values({
        id: uuidv7(),
        operatorId: op,
        assignmentId,
        type: "suspended",
        effectiveDate: "2025-06-01",
        at: new Date("2025-06-01T06:00:00Z"),
      });
    }
    return assignmentId;
  };
  const activeAssignmentId = await connection("active");
  const stoppedAssignmentId = await connection("suspended");
  return { areaId, planId, customerId, activeAssignmentId, stoppedAssignmentId };
}

/** Today (IST) when the case runs: the harness runtime uses the real clock. */
const today = () => businessDateOf(new Date());
const freshVc = () => `NEW${uuidv7().replace(/-/g, "").slice(-12)}`;
const freshCode = () => `NEW-${uuidv7().slice(-8)}`;

export const addConnectionIsolation = defineIsolationCases(addConnection, {
  seed: seedConnections,
  cases: [
    {
      name: "add a VC to another tenant's customer",
      input: (seed) => ({
        customerId: seed.customerId,
        vcNumber: freshVc(),
        rentalPaise: 30_000,
        startDate: today(),
      }),
    },
    {
      name: "add a VC on another tenant's plan",
      // Victim ids for both: the customer lookup fails first. The control uses the tenant's own.
      input: (seed) => ({
        customerId: seed.customerId,
        vcNumber: freshVc(),
        planId: seed.planId,
        startDate: today(),
      }),
    },
  ],
});

export const suspendConnectionIsolation = defineIsolationCases(suspendConnection, {
  seed: seedConnections,
  cases: [
    {
      name: "stop another tenant's connection",
      input: (seed) => ({
        assignmentId: seed.activeAssignmentId,
        effectiveDate: today(),
        reason: "not_paying" as const,
      }),
    },
  ],
});

export const reactivateConnectionIsolation = defineIsolationCases(reactivateConnection, {
  seed: seedConnections,
  cases: [
    {
      name: "start another tenant's stopped connection",
      input: (seed) => ({ assignmentId: seed.stoppedAssignmentId, effectiveDate: today() }),
    },
  ],
});

export const disconnectConnectionIsolation = defineIsolationCases(disconnectConnection, {
  seed: seedConnections,
  cases: [
    {
      name: "remove another tenant's connection",
      input: (seed) => ({
        assignmentId: seed.activeAssignmentId,
        effectiveDate: today(),
        reason: "moved_away" as const,
      }),
    },
  ],
});

export const changeConnectionPlanIsolation = defineIsolationCases(changeConnectionPlan, {
  seed: seedConnections,
  cases: [
    {
      name: "change another tenant's connection's plan",
      input: (seed) => ({
        assignmentId: seed.activeAssignmentId,
        effectiveDate: today(),
        planId: seed.planId,
      }),
    },
  ],
});

export const createCustomerWithConnectionsIsolation = defineIsolationCases(
  createCustomerWithConnections,
  {
    seed: seedConnections,
    cases: [
      {
        name: "add a customer with a VC on another tenant's plan",
        input: (seed) => ({
          customer: { customerCode: freshCode(), name: "Attacker" },
          connections: [{ vcNumber: freshVc(), planId: seed.planId, startDate: today() }],
        }),
      },
      {
        name: "add a customer with a VC in another tenant's area",
        input: (seed) => ({
          customer: { customerCode: freshCode(), name: "Attacker", areaId: seed.areaId },
          connections: [{ vcNumber: freshVc(), rentalPaise: 20_000, startDate: today() }],
        }),
      },
    ],
  },
);

export const listConnectionsIsolation = defineIsolationCases(listConnections, {
  seed: seedConnections,
  cases: [
    {
      name: "open another tenant's customer's connections",
      input: (seed) => ({ customerId: seed.customerId }),
    },
  ],
});

export const connectionFormOptionsIsolation = defineIsolationCases(connectionFormOptions, {
  seed: seedConnections,
  cases: [
    {
      name: "start dates for another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId }),
    },
    { name: "list the plans", expect: "no_leak", input: () => ({}) },
  ],
});

/**
 * Tenant isolation cases for "Who changed what" (T-035, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: tenant A never sees tenant B's events, whatever the filters, and
 * a person filter naming B's user is NOT_FOUND with nothing written.
 */
import { customers, uuidv7 } from "@cb/db";
import { writeAuditEvent } from "../audit/audit";
import { defineIsolationCases, type IsolationSeedArgs } from "../testing/isolation";
import { listAuditEvents } from "./list";

/** One customer and one "changed the phone" event by the tenant's staff member. */
async function seedEvent({ tx, tenant }: IsolationSeedArgs) {
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
  });
  const eventId = await writeAuditEvent(tx, {
    operatorId: tenant.operatorId,
    actorId: tenant.users.staff,
    actorRole: "staff",
    action: "customers.update_phone",
    entityType: "customer",
    entityId: customerId,
    before: { phone: "9876543210" },
    after: { phone: "9123456780" },
  });
  return { eventId, customerId, staffId: tenant.users.staff };
}

export const listAuditEventsIsolation = defineIsolationCases(listAuditEvents, {
  seed: seedEvent,
  cases: [
    { name: "who changed what (no filters)", expect: "no_leak", input: () => ({}) },
    {
      name: "filtered by kind and action",
      expect: "no_leak",
      input: () => ({ entityType: "customer", action: "customers.update_phone" }),
    },
    {
      name: "one customer's history",
      expect: "no_leak",
      input: (seed) => ({ entityType: "customer", entityId: seed.customerId }),
    },
    {
      name: "changes made by another tenant's staff member",
      input: (seed) => ({ actor: seed.staffId }),
    },
  ],
});

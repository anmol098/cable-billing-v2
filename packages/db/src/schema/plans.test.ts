/**
 * Rental plans (T-022, FR-007): amounts, active-name uniqueness, retire instead of delete, RLS, and
 * plan edits never touching a connection's copied rental.
 */
import { eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { vcAssets, vcAssignments } from "./connections";
import { customers } from "./customers";
import { plans } from "./plans";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;

describeDb("plans", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  const insertPlan = (tenant: TestTenant, overrides: Partial<typeof plans.$inferInsert> = {}) =>
    t.current.db
      .withTenant(tenant.operatorId, (tx) =>
        tx
          .insert(plans)
          .values({
            id: uuidv7(),
            operatorId: tenant.operatorId,
            name: `Plan ${uuidv7().slice(-6)}`,
            monthlyAmountPaise: 30_000,
            ...overrides,
          })
          .returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  it("stores integer paise, defaults to active, allows ₹0 and rejects negative amounts or blank names", async () => {
    const basic = await insertPlan(a, { monthlyAmountPaise: 35_000 });
    expect(basic).toMatchObject({ monthlyAmountPaise: 35_000, status: "active" });
    await expect(insertPlan(a, { monthlyAmountPaise: 0 })).resolves.toMatchObject({
      monthlyAmountPaise: 0,
    });
    await expect(insertPlan(a, { monthlyAmountPaise: -1 })).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
    await expect(insertPlan(a, { name: " " })).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
  });

  it("active plan names are unique per operator (ignoring case and outer spaces); retired ones may repeat", async () => {
    const first = await insertPlan(a, { name: "Basic" });
    await expect(insertPlan(a, { name: " basic " })).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
    await expect(insertPlan(b, { name: "Basic" })).resolves.toMatchObject({ name: "Basic" });
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.update(plans).set({ status: "retired" }).where(eq(plans.id, first.id)),
    );
    const second = await insertPlan(a, { name: "BASIC" });
    expect(second.status).toBe("active");
    // Un-retiring the old one would make two active "Basic" plans.
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.update(plans).set({ status: "active" }).where(eq(plans.id, first.id)),
      ),
    ).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
  });

  it("plans are retired, never deleted, and keep their id and tenant", async () => {
    const plan = await insertPlan(a);
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) => tx.delete(plans).where(eq(plans.id, plan.id))),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(t.current.admin.query("TRUNCATE plans CASCADE")).rejects.toSatisfy(
      isImmutableRowError,
    );
    await expect(
      t.current.admin.query("UPDATE plans SET operator_id = $2 WHERE id = $1", [
        plan.id,
        b.operatorId,
      ]),
    ).rejects.toSatisfy(isImmutableRowError);
  });

  it("is tenant-scoped", async () => {
    const plan = await insertPlan(a);
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(plans).where(eq(plans.id, plan.id)),
    );
    expect(seenByB).toEqual([]);
    await expect(insertPlan(b, { operatorId: a.operatorId })).rejects.toSatisfy(
      failsWith(RLS_VIOLATION),
    );
  });

  it("FR-007: editing a plan's amount does not change the rental copied onto a connection", async () => {
    const plan = await insertPlan(a, { monthlyAmountPaise: 30_000 });
    const customerId = uuidv7();
    const assetId = uuidv7();
    const assignmentId = uuidv7();
    await t.current.db.withTenant(a.operatorId, async (tx) => {
      await tx
        .insert(customers)
        .values({ id: customerId, operatorId: a.operatorId, customerCode: "P1", name: "Ravi" });
      await tx.insert(vcAssets).values({ id: assetId, operatorId: a.operatorId, vcNumber: "P-1" });
      await tx.insert(vcAssignments).values({
        id: assignmentId,
        operatorId: a.operatorId,
        vcAssetId: assetId,
        customerId,
        startDate: "2026-10-01",
        planId: plan.id,
        rentalAmountPaise: plan.monthlyAmountPaise,
      });
      await tx.update(plans).set({ monthlyAmountPaise: 45_000 }).where(eq(plans.id, plan.id));
    });
    const [assignment] = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select().from(vcAssignments).where(eq(vcAssignments.id, assignmentId)),
    );
    expect(assignment).toMatchObject({ planId: plan.id, rentalAmountPaise: 30_000 });
  });
});

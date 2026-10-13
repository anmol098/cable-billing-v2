/**
 * Connections (T-022): VC number normalisation and uniqueness, the no-overlap EXCLUDE constraint
 * (RULE-06, BR-03) with sequential reuse (PRD §15 #6), cross-tenant composite FKs, identity and
 * append-only triggers, and the T-040 mapping from stored rows to `AssignmentTimeline`.
 */
import {
  type AssignmentEvent,
  type AssignmentTimeline,
  businessDate,
  isBillable,
  period,
  rentalForPeriod,
  toPaise,
  validateAssignmentTimeline,
} from "@cb/domain";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { assignmentEvents, normalizeVcNumber, vcAssets, vcAssignments } from "./connections";
import { customers } from "./customers";
import { plans } from "./plans";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";
const EXCLUSION_VIOLATION = "23P01";

const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;
const constraintOf = (e: unknown): string | undefined => {
  let current: unknown = e;
  for (let i = 0; i < 5 && current && typeof current === "object"; i += 1) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};
const isOverlap = (e: unknown) =>
  sqlStateOf(e) === EXCLUSION_VIOLATION && constraintOf(e) === "vc_assignments_no_overlap";

const VC_CASES: ReadonlyArray<readonly [string, string]> = [
  ["000123456789", "000123456789"],
  ["0001 2345 6789", "000123456789"],
  ["0001-2345-6789", "000123456789"],
  [" 0001\t2345\n6789 ", "000123456789"],
  ["vc-12ab", "VC12AB"],
  ["12.34/5", "12.34/5"],
  ["१२३४", "१२३४"],
];

describe("normalizeVcNumber", () => {
  it.each(VC_CASES)("%j → %j", (input, expected) => {
    expect(normalizeVcNumber(input)).toBe(expected);
  });
});

interface Seed {
  tenant: TestTenant;
  ownerId: string;
  customerIds: [string, string];
  planIds: [string, string];
}

describeDb("vc_assets, vc_assignments and assignment_events", () => {
  const t = useTestDatabase();
  let a: Seed;
  let b: Seed;

  async function seed(): Promise<Seed> {
    const tenant = await createTenant(t.current);
    const owner = await createUser(t.current, { operatorId: tenant.operatorId });
    const customerIds: [string, string] = [uuidv7(), uuidv7()];
    const planIds: [string, string] = [uuidv7(), uuidv7()];
    await t.current.db.withTenant(tenant.operatorId, async (tx) => {
      await tx.insert(customers).values(
        customerIds.map((id, i) => ({
          id,
          operatorId: tenant.operatorId,
          customerCode: String(100 + i),
          name: `Customer ${i}`,
        })),
      );
      await tx.insert(plans).values([
        {
          id: planIds[0],
          operatorId: tenant.operatorId,
          name: "Basic",
          monthlyAmountPaise: 30_000,
        },
        { id: planIds[1], operatorId: tenant.operatorId, name: "Gold", monthlyAmountPaise: 45_000 },
      ]);
    });
    return { tenant, ownerId: owner.userId, customerIds, planIds };
  }

  const insertAsset = (s: Seed, vcNumber = `VC${uuidv7().slice(-8)}`) =>
    t.current.db
      .withTenant(s.tenant.operatorId, (tx) =>
        tx
          .insert(vcAssets)
          .values({ id: uuidv7(), operatorId: s.tenant.operatorId, vcNumber })
          .returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });

  const assign = (
    s: Seed,
    vcAssetId: string,
    overrides: Partial<typeof vcAssignments.$inferInsert> = {},
  ) =>
    t.current.db
      .withTenant(s.tenant.operatorId, (tx) =>
        tx
          .insert(vcAssignments)
          .values({
            id: uuidv7(),
            operatorId: s.tenant.operatorId,
            vcAssetId,
            customerId: s.customerIds[0],
            startDate: "2026-01-01",
            planId: s.planIds[0],
            rentalAmountPaise: 30_000,
            ...overrides,
          })
          .returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });

  const disconnect = (s: Seed, assignmentId: string, endDate: string) =>
    t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx
        .update(vcAssignments)
        .set({ status: "disconnected", endDate })
        .where(eq(vcAssignments.id, assignmentId)),
    );

  const addEvent = (s: Seed, overrides: Partial<typeof assignmentEvents.$inferInsert>) =>
    t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx
        .insert(assignmentEvents)
        .values({
          id: uuidv7(),
          operatorId: s.tenant.operatorId,
          assignmentId: "",
          type: "activated",
          effectiveDate: "2026-01-01",
          actorId: s.ownerId,
          ...overrides,
        })
        .returning(),
    );

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  describe("vc_assets", () => {
    it("the generated vc_number_norm equals normalizeVcNumber for every case", async () => {
      for (const [input, expected] of VC_CASES) {
        const row = await insertAsset(await seed(), input);
        expect(row.vcNumberNorm).toBe(expected);
        expect(row.vcNumberNorm).toBe(normalizeVcNumber(input));
      }
    });

    it("a VC number is unique within an operator (after normalisation) and free across operators", async () => {
      await insertAsset(a, "5555 0000 1111");
      await insertAsset(b, "555500001111");
      for (const duplicate of ["555500001111", "5555-0000-1111", " 5555 0000 1111 "]) {
        const error = await insertAsset(a, duplicate).catch((e: unknown) => e);
        expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION);
        expect(constraintOf(error)).toBe("vc_assets_operator_number_unique");
      }
      await expect(insertAsset(a, " - ")).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    });

    it("is tenant-scoped, never deleted, and keeps its id and tenant", async () => {
      const asset = await insertAsset(a);
      expect(asset.lifecycleStatus).toBe("in_service");
      const seenByB = await t.current.db.withTenant(b.tenant.operatorId, (tx) =>
        tx.select().from(vcAssets).where(eq(vcAssets.id, asset.id)),
      );
      expect(seenByB).toEqual([]);
      await expect(
        t.current.db.withTenant(b.tenant.operatorId, (tx) =>
          tx
            .insert(vcAssets)
            .values({ id: uuidv7(), operatorId: a.tenant.operatorId, vcNumber: "X1" }),
        ),
      ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
      await expect(
        t.current.db.withTenant(a.tenant.operatorId, (tx) =>
          tx.delete(vcAssets).where(eq(vcAssets.id, asset.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.admin.query("UPDATE vc_assets SET operator_id = $2 WHERE id = $1", [
          asset.id,
          b.tenant.operatorId,
        ]),
      ).rejects.toSatisfy(isImmutableRowError);
      const [retired] = await t.current.db.withTenant(a.tenant.operatorId, (tx) =>
        tx
          .update(vcAssets)
          .set({ lifecycleStatus: "retired" })
          .where(eq(vcAssets.id, asset.id))
          .returning(),
      );
      expect(retired?.lifecycleStatus).toBe("retired");
    });

    it("legacy ids are unique per operator", async () => {
      const legacy = { legacySource: "legacy:vc", legacyId: "9" };
      const insert = (s: Seed) =>
        t.current.db.withTenant(s.tenant.operatorId, (tx) =>
          tx.insert(vcAssets).values({
            id: uuidv7(),
            operatorId: s.tenant.operatorId,
            vcNumber: `L${uuidv7().slice(-8)}`,
            ...legacy,
          }),
        );
      await insert(a);
      await insert(b);
      await expect(insert(a)).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
    });
  });

  describe("vc_assignments: no overlapping assignments for one VC (RULE-06, BR-03)", () => {
    it("rejects a second open assignment of the same VC, for another customer or the same one", async () => {
      const asset = await insertAsset(a);
      await assign(a, asset.id, { startDate: "2026-01-01" });
      for (const overrides of [
        { customerId: a.customerIds[1], startDate: "2026-06-01" },
        { customerId: a.customerIds[0], startDate: "2026-01-01" },
        {
          customerId: a.customerIds[1],
          startDate: "2025-12-01",
          endDate: "2026-01-01",
          status: "disconnected" as const,
        },
      ]) {
        await expect(assign(a, asset.id, overrides)).rejects.toSatisfy(isOverlap);
      }
      // Different VCs never conflict, even with the same dates and customer.
      const other = await insertAsset(a);
      await expect(assign(a, other.id, { startDate: "2026-01-01" })).resolves.toBeTruthy();
    });

    it("PRD §15 #6: a disconnected VC is reassigned from the day after its last day; the old assignment stays with the old customer", async () => {
      const asset = await insertAsset(a);
      const old = await assign(a, asset.id, {
        customerId: a.customerIds[0],
        startDate: "2026-01-01",
      });
      await disconnect(a, old.id, "2026-10-20");
      // end_date is the last day of service, inclusive: the same day is still taken.
      await expect(
        assign(a, asset.id, { customerId: a.customerIds[1], startDate: "2026-10-20" }),
      ).rejects.toSatisfy(isOverlap);
      const reused = await assign(a, asset.id, {
        customerId: a.customerIds[1],
        startDate: "2026-10-21",
        planId: a.planIds[1],
        rentalAmountPaise: 45_000,
      });
      expect(reused.id).not.toBe(old.id);
      const history = await t.current.db.withTenant(a.tenant.operatorId, (tx) =>
        tx
          .select({
            id: vcAssignments.id,
            customerId: vcAssignments.customerId,
            startDate: vcAssignments.startDate,
            endDate: vcAssignments.endDate,
            status: vcAssignments.status,
            rentalAmountPaise: vcAssignments.rentalAmountPaise,
          })
          .from(vcAssignments)
          .where(eq(vcAssignments.vcAssetId, asset.id))
          .orderBy(asc(vcAssignments.startDate)),
      );
      expect(history).toEqual([
        {
          id: old.id,
          customerId: a.customerIds[0],
          startDate: "2026-01-01",
          endDate: "2026-10-20",
          status: "disconnected",
          rentalAmountPaise: 30_000,
        },
        {
          id: reused.id,
          customerId: a.customerIds[1],
          startDate: "2026-10-21",
          endDate: null,
          status: "active",
          rentalAmountPaise: 45_000,
        },
      ]);
      // A back-dated range inside the old one, or stretching the old one into the new one, overlaps.
      await expect(
        assign(a, asset.id, {
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          status: "disconnected",
        }),
      ).rejects.toSatisfy(isOverlap);
      await expect(disconnect(a, old.id, "2026-10-25")).rejects.toSatisfy(isOverlap);
      // A period entirely before the first one is fine (e.g. imported history).
      await expect(
        assign(a, asset.id, {
          startDate: "2025-01-01",
          endDate: "2025-12-31",
          status: "disconnected",
        }),
      ).resolves.toBeTruthy();
      // The same VC number at another operator is a different asset: no conflict.
      const sameNumberB = await insertAsset(b, asset.vcNumber);
      await expect(assign(b, sameNumberB.id, { startDate: "2026-01-01" })).resolves.toBeTruthy();
    });

    it("end_date is set exactly when disconnected, never before the start; rental ≥ 0", async () => {
      const asset = await insertAsset(a);
      for (const overrides of [
        { status: "disconnected" as const },
        { endDate: "2026-05-01" },
        { status: "suspended" as const, endDate: "2026-05-01" },
        { startDate: "2026-05-02", endDate: "2026-05-01", status: "disconnected" as const },
        { rentalAmountPaise: -100 },
      ]) {
        await expect(assign(a, asset.id, overrides)).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
      }
      // A one-day assignment (start = end) is valid.
      await expect(
        assign(a, asset.id, {
          startDate: "2026-05-01",
          endDate: "2026-05-01",
          status: "disconnected",
        }),
      ).resolves.toMatchObject({ historyLimited: false });
    });

    it("an assignment never changes VC, customer, start date or tenant and is never deleted", async () => {
      const asset = await insertAsset(a);
      const other = await insertAsset(a);
      const row = await assign(a, asset.id, { startDate: "2026-02-01" });
      const update = (set: Partial<typeof vcAssignments.$inferInsert>) =>
        t.current.db.withTenant(a.tenant.operatorId, (tx) =>
          tx.update(vcAssignments).set(set).where(eq(vcAssignments.id, row.id)).returning(),
        );
      for (const set of [
        { customerId: a.customerIds[1] },
        { vcAssetId: other.id },
        { startDate: "2026-02-02" },
      ]) {
        await expect(update(set)).rejects.toSatisfy(isImmutableRowError);
      }
      await expect(
        t.current.admin.query("UPDATE vc_assignments SET operator_id = $2 WHERE id = $1", [
          row.id,
          b.tenant.operatorId,
        ]),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(a.tenant.operatorId, (tx) =>
          tx.delete(vcAssignments).where(eq(vcAssignments.id, row.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE vc_assignments CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
      // Status, plan and rental changes are what the timeline is for.
      const [changed] = await update({
        status: "suspended",
        planId: a.planIds[1],
        rentalAmountPaise: 45_000,
      });
      expect(changed).toMatchObject({
        status: "suspended",
        planId: a.planIds[1],
        rentalAmountPaise: 45_000,
      });
    });

    it("composite FKs: an assignment can't use another tenant's VC, customer or plan", async () => {
      const assetA = await insertAsset(a);
      const assetB = await insertAsset(b);
      await expect(assign(a, assetB.id)).rejects.toSatisfy(failsWith(FK_VIOLATION));
      await expect(assign(a, assetA.id, { customerId: b.customerIds[0] })).rejects.toSatisfy(
        failsWith(FK_VIOLATION),
      );
      await expect(assign(a, assetA.id, { planId: b.planIds[0] })).rejects.toSatisfy(
        failsWith(FK_VIOLATION),
      );
      // Even the owner role (no RLS) can't build a cross-tenant row.
      await expect(
        t.current.admin.query(
          `INSERT INTO vc_assignments (id, operator_id, vc_asset_id, customer_id, start_date, rental_amount_paise)
           VALUES ($1, $2, $3, $4, '2026-01-01', 0)`,
          [uuidv7(), a.tenant.operatorId, assetA.id, b.customerIds[0]],
        ),
      ).rejects.toSatisfy(failsWith(FK_VIOLATION));
      // A custom amount needs no plan.
      await expect(
        assign(a, assetA.id, { planId: null, rentalAmountPaise: 25_000 }),
      ).resolves.toMatchObject({
        planId: null,
      });
    });

    it("is tenant-scoped", async () => {
      const asset = await insertAsset(a);
      const row = await assign(a, asset.id);
      const seenByB = await t.current.db.withTenant(b.tenant.operatorId, (tx) =>
        tx.select().from(vcAssignments).where(eq(vcAssignments.id, row.id)),
      );
      expect(seenByB).toEqual([]);
      const updatedByB = await t.current.db.withTenant(b.tenant.operatorId, (tx) =>
        tx
          .update(vcAssignments)
          .set({ status: "suspended" })
          .where(eq(vcAssignments.id, row.id))
          .returning(),
      );
      expect(updatedByB).toEqual([]);
    });
  });

  describe("assignment_events", () => {
    it("maps one to one onto T-040's AssignmentTimeline (end_date = last day of service, inclusive)", async () => {
      const asset = await insertAsset(a);
      const row = await assign(a, asset.id, {
        startDate: "2026-10-05",
        planId: a.planIds[0],
        rentalAmountPaise: 30_000,
      });
      const event = (overrides: Partial<typeof assignmentEvents.$inferInsert>) =>
        addEvent(a, { assignmentId: row.id, ...overrides });
      await event({ type: "activated", effectiveDate: "2026-10-05" });
      await event({
        type: "plan_changed",
        effectiveDate: "2026-10-20",
        fromPlanId: a.planIds[0],
        toPlanId: a.planIds[1],
        fromRentalPaise: 30_000,
        toRentalPaise: 45_000,
      });
      await event({ type: "suspended", effectiveDate: "2026-11-10", reason: "travelling" });
      await event({ type: "reactivated", effectiveDate: "2026-12-03" });
      await event({ type: "disconnected", effectiveDate: "2027-01-15", reason: "moved away" });
      await t.current.db.withTenant(a.tenant.operatorId, (tx) =>
        tx
          .update(vcAssignments)
          .set({
            status: "disconnected",
            endDate: "2027-01-15",
            rentalAmountPaise: 45_000,
            planId: a.planIds[1],
          })
          .where(eq(vcAssignments.id, row.id)),
      );

      const { assignment, events } = await t.current.db.withTenant(
        a.tenant.operatorId,
        async (tx) => ({
          assignment: (
            await tx.select().from(vcAssignments).where(eq(vcAssignments.id, row.id))
          )[0],
          events: await tx
            .select()
            .from(assignmentEvents)
            .where(eq(assignmentEvents.assignmentId, row.id))
            .orderBy(asc(assignmentEvents.at), asc(assignmentEvents.id)),
        }),
      );
      if (!assignment) throw new Error("assignment missing");
      const timeline: AssignmentTimeline = {
        startDate: businessDate(assignment.startDate),
        endDate: assignment.endDate === null ? null : businessDate(assignment.endDate),
        events: events.map(
          (e): AssignmentEvent =>
            e.type === "plan_changed"
              ? {
                  type: "plan_changed",
                  effectiveDate: businessDate(e.effectiveDate),
                  rentalPaise: toPaise(e.toRentalPaise ?? Number.NaN),
                }
              : { type: e.type, effectiveDate: businessDate(e.effectiveDate) },
        ),
      };
      expect(validateAssignmentTimeline(timeline).ok).toBe(true);
      const billable = ["2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"].map(
        (p) => isBillable(timeline, period(p)),
      );
      // Oct: starts on the 5th. Nov: active on the 1st. Dec: suspended on the 1st. Jan: reactivated
      // 3 Dec. Feb: disconnected 15 Jan.
      expect(billable).toEqual([false, true, false, true, false]);
      const firstPlanChange = events.find((e) => e.type === "plan_changed");
      const initialRentalPaise = toPaise(
        firstPlanChange?.fromRentalPaise ?? assignment.rentalAmountPaise,
      );
      expect(rentalForPeriod({ ...timeline, initialRentalPaise }, period("2026-10-01"))).toBe(
        45_000,
      );
      expect(initialRentalPaise).toBe(30_000);
    });

    it("plan values are required on plan_changed and forbidden elsewhere; one activation and one disconnection", async () => {
      const asset = await insertAsset(a);
      const row = await assign(a, asset.id);
      const event = (overrides: Partial<typeof assignmentEvents.$inferInsert>) =>
        addEvent(a, { assignmentId: row.id, ...overrides });
      for (const overrides of [
        { type: "plan_changed" as const, toRentalPaise: 100 },
        { type: "plan_changed" as const, fromRentalPaise: 100 },
        { type: "plan_changed" as const, fromRentalPaise: -1, toRentalPaise: 100 },
        { type: "suspended" as const, toRentalPaise: 100 },
        { type: "suspended" as const, toPlanId: a.planIds[0] },
      ]) {
        await expect(event(overrides)).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
      }
      await expect(
        event({
          type: "plan_changed",
          fromPlanId: null,
          toPlanId: null,
          fromRentalPaise: 0,
          toRentalPaise: 100,
        }),
      ).resolves.toHaveLength(1);
      await event({ type: "activated", effectiveDate: "2026-01-01" });
      await expect(event({ type: "activated", effectiveDate: "2026-01-01" })).rejects.toSatisfy(
        failsWith(UNIQUE_VIOLATION),
      );
      await event({ type: "disconnected", effectiveDate: "2026-03-01" });
      await expect(event({ type: "disconnected", effectiveDate: "2026-04-01" })).rejects.toSatisfy(
        failsWith(UNIQUE_VIOLATION),
      );
      // System/migration events have no actor.
      await expect(event({ type: "suspended", actorId: null })).resolves.toHaveLength(1);
    });

    it("is append-only for every role", async () => {
      const asset = await insertAsset(a);
      const row = await assign(a, asset.id);
      const [ev] = await addEvent(a, { assignmentId: row.id });
      if (!ev) throw new Error("no event");
      await expect(
        t.current.db.withTenant(a.tenant.operatorId, (tx) =>
          tx
            .update(assignmentEvents)
            .set({ effectiveDate: "2026-02-01" })
            .where(eq(assignmentEvents.id, ev.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.admin.query("DELETE FROM assignment_events WHERE id = $1", [ev.id]),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE assignment_events")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("composite FKs: an event can't point at another tenant's assignment, plan or user; RLS hides events", async () => {
      const assetA = await insertAsset(a);
      const assignmentA = await assign(a, assetA.id);
      const assetB = await insertAsset(b);
      const assignmentB = await assign(b, assetB.id);
      await expect(addEvent(a, { assignmentId: assignmentB.id })).rejects.toSatisfy(
        failsWith(FK_VIOLATION),
      );
      await expect(
        addEvent(a, {
          assignmentId: assignmentA.id,
          type: "plan_changed",
          fromRentalPaise: 0,
          toRentalPaise: 1,
          toPlanId: b.planIds[0],
        }),
      ).rejects.toSatisfy(failsWith(FK_VIOLATION));
      await expect(
        addEvent(a, { assignmentId: assignmentA.id, actorId: b.ownerId }),
      ).rejects.toSatisfy(failsWith(FK_VIOLATION));
      await addEvent(a, { assignmentId: assignmentA.id });
      const seenByB = await t.current.db.withTenant(b.tenant.operatorId, (tx) =>
        tx.select().from(assignmentEvents).where(eq(assignmentEvents.assignmentId, assignmentA.id)),
      );
      expect(seenByB).toEqual([]);
      await expect(
        t.current.db.withTenant(b.tenant.operatorId, (tx) =>
          tx.insert(assignmentEvents).values({
            id: uuidv7(),
            operatorId: a.tenant.operatorId,
            assignmentId: assignmentA.id,
            type: "suspended",
            effectiveDate: "2026-02-01",
          }),
        ),
      ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    });
  });
});

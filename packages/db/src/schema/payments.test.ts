/**
 * Payments and reversals (T-023): the client id is the idempotency key per tenant (FR-015), the
 * amount is > 0, a posted payment is immutable at DB level (FR-013, RULE-20) except the review
 * workflow, one reversal per payment. Isolation cases too.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { devices } from "./auth";
import { customers } from "./customers";
import { paymentReversals, payments } from "./payments";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

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
const violates = (code: string, constraint: string) => (e: unknown) =>
  sqlStateOf(e) === code && constraintOf(e) === constraint;

interface Seed {
  tenant: TestTenant;
  operatorId: string;
  ownerId: string;
  linemanId: string;
  deviceId: string;
  customerIds: [string, string];
}

describeDb("payments and payment_reversals", () => {
  const t = useTestDatabase();
  let a: Seed;
  let b: Seed;

  async function seed(): Promise<Seed> {
    const tenant = await createTenant(t.current);
    const operatorId = tenant.operatorId;
    const owner = await createUser(t.current, { operatorId });
    const lineman = await createUser(t.current, { operatorId, role: "lineman" });
    const customerIds: [string, string] = [uuidv7(), uuidv7()];
    const deviceId = uuidv7();
    await t.current.db.withTenant(operatorId, async (tx) => {
      await tx
        .insert(customers)
        .values(
          customerIds.map((id, i) => ({ id, operatorId, customerCode: `C${i}`, name: `C ${i}` })),
        );
      await tx.insert(devices).values({
        id: deviceId,
        operatorId,
        userId: lineman.userId,
        installId: uuidv7(),
        deviceCode: "K7Q",
      });
    });
    return {
      tenant,
      operatorId,
      ownerId: owner.userId,
      linemanId: lineman.userId,
      deviceId,
      customerIds,
    };
  }

  const paymentValues = (s: Seed, overrides: Partial<typeof payments.$inferInsert> = {}) =>
    ({
      id: uuidv7(),
      operatorId: s.operatorId,
      customerId: s.customerIds[0],
      amountPaise: 50_000,
      method: "cash",
      collectorId: s.linemanId,
      deviceId: s.deviceId,
      source: "android",
      recordedAt: new Date("2026-10-12T05:00:00Z"),
      businessDate: "2026-10-12",
      balanceAfterPaise: 0,
      creditAfterPaise: 0,
      ...overrides,
    }) satisfies typeof payments.$inferInsert;

  const insertPayment = (s: Seed, overrides: Partial<typeof payments.$inferInsert> = {}) =>
    t.current.db
      .withTenant(s.operatorId, (tx) =>
        tx.insert(payments).values(paymentValues(s, overrides)).returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  describe("payments", () => {
    it("stores a posted payment with its defaults", async () => {
      const row = await insertPayment(a, { method: "upi", upiReference: "412345678901" });
      expect(row).toMatchObject({
        upiVerification: "unverified",
        reviewStatus: "none",
        reviewReason: null,
        source: "android",
      });
      expect(row.postedAt).toBeInstanceOf(Date);
    });

    it("FR-015: replaying the same client id can never create a second payment", async () => {
      const id = uuidv7();
      await insertPayment(a, { id });
      await expect(insertPayment(a, { id })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "payments_pkey"),
      );
      // Even with a different payload (the service answers ID_REUSED_WITH_DIFFERENT_DATA).
      await expect(insertPayment(a, { id, amountPaise: 1 })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "payments_pkey"),
      );
      // Ten concurrent identical posts: exactly one row.
      const id2 = uuidv7();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => insertPayment(a, { id: id2 })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rows = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, id2)),
      );
      expect(rows).toHaveLength(1);
      // The key is per tenant: another tenant's id space is separate (no cross-tenant oracle).
      await insertPayment(b, { id });
    });

    it("amount must be > 0", async () => {
      for (const amountPaise of [0, -100]) {
        await expect(insertPayment(a, { amountPaise })).rejects.toSatisfy(
          violates(CHECK_VIOLATION, "payments_amount_positive"),
        );
      }
    });

    it("checks method, collector, device, snapshots and review columns", async () => {
      const cases: Array<[Partial<typeof payments.$inferInsert>, string]> = [
        [{ upiReference: "4123" }, "payments_upi_reference_only_upi"],
        [{ method: "upi", upiReference: " " }, "payments_upi_reference_only_upi"],
        [{ collectorId: null }, "payments_collector_required"],
        [{ deviceId: null }, "payments_device_only_android"],
        [{ source: "web" }, "payments_device_only_android"],
        [{ balanceAfterPaise: null }, "payments_snapshots_required"],
        [{ creditAfterPaise: -1 }, "payments_credit_after_not_negative"],
        [{ reviewStatus: "needs_review" }, "payments_review_reason_iff_flagged"],
        [{ reviewReason: "other" }, "payments_review_reason_iff_flagged"],
        [{ reviewStatus: "resolved", reviewReason: "other" }, "payments_review_resolution"],
        [{ reviewNote: "fine" }, "payments_review_resolution"],
        [{ legacySource: "legacy" }, "payments_legacy_both_or_neither"],
        [{ legacySource: "legacy", legacyId: "1" }, "payments_legacy_only_migration"],
      ];
      for (const [values, constraint] of cases) {
        await expect(insertPayment(a, values), JSON.stringify(values)).rejects.toSatisfy(
          violates(CHECK_VIOLATION, constraint),
        );
      }
      // Web counter payment (no device) and a migrated one (no collector, no snapshots).
      await insertPayment(a, { source: "web", deviceId: null, collectorId: a.ownerId });
      await insertPayment(a, {
        source: "migration",
        deviceId: null,
        collectorId: null,
        balanceAfterPaise: null,
        creditAfterPaise: null,
        legacySource: "legacy_payment",
        legacyId: "77",
      });
    });

    it("UPDATE or DELETE of a posted payment fails at DB level, for every role", async () => {
      const row = await insertPayment(a);
      for (const set of [
        { amountPaise: 1 },
        { amountPaise: 50_001 },
        { customerId: a.customerIds[1] },
        { method: "upi" as const },
        { recordedAt: new Date() },
        { reviewStatus: "needs_review" as const, reviewReason: "other" as const },
      ]) {
        await expect(
          t.current.db.withTenant(a.operatorId, (tx) =>
            tx.update(payments).set(set).where(eq(payments.id, row.id)),
          ),
          JSON.stringify(set),
        ).rejects.toSatisfy(isImmutableRowError);
      }
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.delete(payments).where(eq(payments.id, row.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      // The table owner too (no BYPASS of the trigger).
      await expect(
        t.current.admin.query("UPDATE payments SET amount_paise = 1 WHERE id = $1", [row.id]),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.admin.query("DELETE FROM payments WHERE id = $1", [row.id]),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE payments CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
      const [stored] = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, row.id)),
      );
      expect(stored?.amountPaise).toBe(50_000);
    });

    it("review workflow: a flagged payment can be resolved once; nothing else changes", async () => {
      const row = await insertPayment(a, {
        reviewStatus: "needs_review",
        reviewReason: "recorded_at_out_of_range",
      });
      const update = (set: Partial<typeof payments.$inferInsert>) =>
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.update(payments).set(set).where(eq(payments.id, row.id)),
        );
      await expect(update({ reviewStatus: "none", reviewReason: null })).rejects.toSatisfy(
        isImmutableRowError,
      );
      await expect(update({ amountPaise: 1, reviewStatus: "resolved" })).rejects.toSatisfy(
        isImmutableRowError,
      );
      await expect(update({ reviewStatus: "resolved" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "payments_review_resolution"),
      );
      await update({
        reviewStatus: "resolved",
        reviewedBy: a.ownerId,
        reviewedAt: new Date(),
        reviewNote: "Clock was wrong; cash received",
      });
      await expect(update({ reviewNote: "edited" })).rejects.toSatisfy(isImmutableRowError);
      await expect(
        update({
          reviewStatus: "needs_review",
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        }),
      ).rejects.toSatisfy(isImmutableRowError);
    });

    it("is tenant-scoped; references stay inside the tenant", async () => {
      const row = await insertPayment(a);
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, row.id)),
      );
      expect(seenByB).toEqual([]);
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) => tx.insert(payments).values(paymentValues(a))),
      ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
      await expect(insertPayment(b, { customerId: a.customerIds[0] })).rejects.toSatisfy(
        violates(FK_VIOLATION, "payments_customer_fk"),
      );
      await expect(insertPayment(b, { collectorId: a.linemanId })).rejects.toSatisfy(
        violates(FK_VIOLATION, "payments_collector_fk"),
      );
      await expect(insertPayment(b, { deviceId: a.deviceId })).rejects.toSatisfy(
        violates(FK_VIOLATION, "payments_device_fk"),
      );
    });
  });

  describe("payment_reversals", () => {
    const reversalValues = (
      s: Seed,
      paymentId: string,
      overrides: Partial<typeof paymentReversals.$inferInsert> = {},
    ) =>
      ({
        id: uuidv7(),
        operatorId: s.operatorId,
        customerId: s.customerIds[0],
        paymentId,
        reason: "Entered twice",
        actorId: s.ownerId,
        ...overrides,
      }) satisfies typeof paymentReversals.$inferInsert;
    const insertReversal = (
      s: Seed,
      paymentId: string,
      overrides: Partial<typeof paymentReversals.$inferInsert> = {},
    ) =>
      t.current.db.withTenant(s.operatorId, (tx) =>
        tx
          .insert(paymentReversals)
          .values(reversalValues(s, paymentId, overrides))
          .returning(),
      );

    it("at most one reversal per payment, with a reason and the payment's own customer", async () => {
      const payment = await insertPayment(a);
      await expect(insertReversal(a, payment.id, { reason: "  " })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "payment_reversals_reason_not_blank"),
      );
      await expect(
        insertReversal(a, payment.id, { customerId: a.customerIds[1] }),
      ).rejects.toSatisfy(violates(FK_VIOLATION, "payment_reversals_payment_fk"));
      await insertReversal(a, payment.id);
      await expect(insertReversal(a, payment.id)).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "payment_reversals_payment_unique"),
      );
      // The payment itself is untouched.
      const [stored] = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, payment.id)),
      );
      expect(stored?.amountPaise).toBe(50_000);
    });

    it("is append-only and tenant-scoped", async () => {
      const payment = await insertPayment(a);
      const [reversal] = await insertReversal(a, payment.id);
      const id = reversal?.id ?? "";
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.update(paymentReversals).set({ reason: "x" }).where(eq(paymentReversals.id, id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.delete(paymentReversals).where(eq(paymentReversals.id, id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE payment_reversals CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(paymentReversals).where(eq(paymentReversals.id, id)),
      );
      expect(seenByB).toEqual([]);
      // B can't reverse A's payment, even naming its own tenant.
      await expect(insertReversal(b, payment.id)).rejects.toSatisfy(failsWith(FK_VIOLATION));
    });
  });
});

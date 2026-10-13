/**
 * Receipts (T-023): one receipt per payment, numbers unique per operator, the provisional
 * reference kept as an alias (FR-016), append-only; receipt links store only a SHA-256 hash and
 * change only by revocation / access counting (FR-021); receipt actions are observable states only
 * (RULE-19: no "sent" / "delivered"). Isolation cases too.
 */
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { devices } from "./auth";
import { customers } from "./customers";
import { payments } from "./payments";
import { RECEIPT_ACTIONS, receiptActions, receiptLinks, receipts } from "./receipts";

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

const tokenHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

interface Seed {
  tenant: TestTenant;
  operatorId: string;
  ownerId: string;
  linemanId: string;
  deviceId: string;
  customerId: string;
}

describeDb("receipts, receipt_links and receipt_actions", () => {
  const t = useTestDatabase();
  let a: Seed;
  let b: Seed;

  async function seed(): Promise<Seed> {
    const tenant = await createTenant(t.current);
    const operatorId = tenant.operatorId;
    const owner = await createUser(t.current, { operatorId });
    const lineman = await createUser(t.current, { operatorId, role: "lineman" });
    const customerId = uuidv7();
    const deviceId = uuidv7();
    await t.current.db.withTenant(operatorId, async (tx) => {
      await tx
        .insert(customers)
        .values({ id: customerId, operatorId, customerCode: "1", name: "C" });
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
      customerId,
    };
  }

  const insertPayment = async (s: Seed) => {
    const id = uuidv7();
    await t.current.db.withTenant(s.operatorId, (tx) =>
      tx.insert(payments).values({
        id,
        operatorId: s.operatorId,
        customerId: s.customerId,
        amountPaise: 30_000,
        method: "cash",
        collectorId: s.linemanId,
        deviceId: s.deviceId,
        source: "android",
        recordedAt: new Date(),
        businessDate: "2026-10-12",
        balanceAfterPaise: 0,
        creditAfterPaise: 0,
      }),
    );
    return id;
  };

  let receiptSeq = 0;
  const insertReceipt = (
    s: Seed,
    paymentId: string,
    overrides: Partial<typeof receipts.$inferInsert> = {},
  ) => {
    receiptSeq += 1;
    return t.current.db
      .withTenant(s.operatorId, (tx) =>
        tx
          .insert(receipts)
          .values({
            id: uuidv7(),
            operatorId: s.operatorId,
            paymentId,
            receiptNumber: `R-2610-${String(receiptSeq).padStart(5, "0")}`,
            provisionalRef: "P-K7Q-0012",
            ...overrides,
          })
          .returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });
  };

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  describe("receipts", () => {
    it("one receipt per payment; numbers unique per operator; provisional ref kept and searchable", async () => {
      const paymentId = await insertPayment(a);
      const receipt = await insertReceipt(a, paymentId, { receiptNumber: "R-2610-99999" });
      expect(receipt.provisionalRef).toBe("P-K7Q-0012");
      await expect(insertReceipt(a, paymentId)).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "receipts_payment_unique"),
      );
      await expect(
        insertReceipt(a, await insertPayment(a), { receiptNumber: "R-2610-99999" }),
      ).rejects.toSatisfy(violates(UNIQUE_VIOLATION, "receipts_operator_number_unique"));
      // The same number at another operator is fine; the provisional ref is not unique (a
      // collision must never block posting a payment).
      await insertReceipt(b, await insertPayment(b), { receiptNumber: "R-2610-99999" });
      await insertReceipt(a, await insertPayment(a));
      const found = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(receipts).where(eq(receipts.provisionalRef, "P-K7Q-0012")),
      );
      expect(found.length).toBeGreaterThanOrEqual(2);
    });

    it("checks the number and the provisional ref format", async () => {
      const paymentId = await insertPayment(a);
      await expect(insertReceipt(a, paymentId, { receiptNumber: " " })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "receipts_number_not_blank"),
      );
      for (const provisionalRef of ["P-K7-0012", "P-k7q-0012", "P-K7Q-12", "R-K7Q-0012"]) {
        await expect(insertReceipt(a, paymentId, { provisionalRef })).rejects.toSatisfy(
          violates(CHECK_VIOLATION, "receipts_provisional_ref_format"),
        );
      }
      await insertReceipt(a, paymentId, { provisionalRef: null }); // web counter payment
      await expect(insertReceipt(a, uuidv7())).rejects.toSatisfy(
        violates(FK_VIOLATION, "receipts_payment_fk"),
      );
    });

    it("is append-only and tenant-scoped", async () => {
      const receipt = await insertReceipt(a, await insertPayment(a));
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.update(receipts).set({ receiptNumber: "X" }).where(eq(receipts.id, receipt.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.delete(receipts).where(eq(receipts.id, receipt.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE receipts CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(receipts).where(eq(receipts.id, receipt.id)),
      );
      expect(seenByB).toEqual([]);
      // B can't issue a receipt for A's payment.
      await expect(insertReceipt(b, receipt.paymentId)).rejects.toSatisfy(failsWith(FK_VIOLATION));
    });
  });

  describe("receipt_links", () => {
    let receiptId: string;

    beforeAll(async () => {
      receiptId = (await insertReceipt(a, await insertPayment(a))).id;
    });

    const insertLink = (values: Partial<typeof receiptLinks.$inferInsert> = {}, s: Seed = a) =>
      t.current.db
        .withTenant(s.operatorId, (tx) =>
          tx
            .insert(receiptLinks)
            .values({
              id: uuidv7(),
              operatorId: s.operatorId,
              receiptId,
              tokenHash: tokenHash(),
              createdBy: s.linemanId,
              expiresAt: days(90),
              ...values,
            })
            .returning(),
        )
        .then(([row]) => {
          if (!row) throw new Error("insert returned nothing");
          return row;
        });

    it("stores only a SHA-256 hash, globally unique, with a future expiry", async () => {
      for (const bad of ["abc", tokenHash().toUpperCase(), randomBytes(32).toString("base64url")]) {
        await expect(insertLink({ tokenHash: bad })).rejects.toSatisfy(
          violates(CHECK_VIOLATION, "receipt_links_token_hash_format"),
        );
      }
      const hash = tokenHash();
      await insertLink({ tokenHash: hash });
      await expect(insertLink({ tokenHash: hash })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "receipt_links_token_hash_unique"),
      );
      await expect(insertLink({ expiresAt: days(-1) })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "receipt_links_expires_after_created"),
      );
      await expect(insertLink({ revokedBy: a.ownerId })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "receipt_links_revoked_by_needs_revoked_at"),
      );
    });

    it("only access counting and (one-way) revocation change; expired links can be purged", async () => {
      const link = await insertLink();
      const update = (set: Partial<typeof receiptLinks.$inferInsert>) =>
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.update(receiptLinks).set(set).where(eq(receiptLinks.id, link.id)),
        );
      await update({ accessCount: 1, lastAccessAt: new Date() });
      await expect(update({ accessCount: -1 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "receipt_links_access_count_not_negative"),
      );
      for (const set of [
        { tokenHash: tokenHash() },
        { expiresAt: days(200) },
        { createdBy: a.ownerId },
      ]) {
        await expect(update(set), JSON.stringify(set)).rejects.toSatisfy(isImmutableRowError);
      }
      await update({ revokedAt: new Date(), revokedBy: a.ownerId });
      await expect(update({ revokedAt: null, revokedBy: null })).rejects.toSatisfy(
        isImmutableRowError,
      );
      await expect(update({ revokedAt: new Date() })).rejects.toSatisfy(isImmutableRowError);
      await update({ accessCount: 2 }); // still counted (the generic page is shown)
      // The weekly purge deletes link rows; the receipt stays.
      await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.delete(receiptLinks).where(eq(receiptLinks.id, link.id)),
      );
      const stillThere = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(receipts).where(eq(receipts.id, receiptId)),
      );
      expect(stillThere).toHaveLength(1);
    });

    it("the public page may look a link up by hash on the platform path, and only read it", async () => {
      const hash = tokenHash();
      const link = await insertLink({ tokenHash: hash });
      const found = await t.current.db.withPlatform((tx) =>
        tx.select().from(receiptLinks).where(eq(receiptLinks.tokenHash, hash)),
      );
      expect(found.map((r) => [r.id, r.operatorId])).toEqual([[link.id, a.operatorId]]);
      const updated = await t.current.db.withPlatform((tx) =>
        tx
          .update(receiptLinks)
          .set({ accessCount: 99 })
          .where(eq(receiptLinks.id, link.id))
          .returning(),
      );
      expect(updated).toEqual([]);
      const deleted = await t.current.db.withPlatform((tx) =>
        tx.delete(receiptLinks).where(eq(receiptLinks.id, link.id)).returning(),
      );
      expect(deleted).toEqual([]);
      await expect(
        t.current.db.withPlatform((tx) =>
          tx.insert(receiptLinks).values({
            id: uuidv7(),
            operatorId: a.operatorId,
            receiptId,
            tokenHash: tokenHash(),
            expiresAt: days(90),
          }),
        ),
      ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
      // The platform path sees no receipt (the page reads it in withTenant).
      const receiptsSeen = await t.current.db.withPlatform((tx) => tx.select().from(receipts));
      expect(receiptsSeen).toEqual([]);
    });

    it("is tenant-scoped", async () => {
      const link = await insertLink();
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(receiptLinks).where(eq(receiptLinks.id, link.id)),
      );
      expect(seenByB).toEqual([]);
      await expect(insertLink({}, b)).rejects.toSatisfy(failsWith(FK_VIOLATION));
    });
  });

  describe("receipt_actions", () => {
    it("RULE-19: the action enum has only observable states", async () => {
      const { rows } = await t.current.admin.query<{ value: string }>(
        "SELECT unnest(enum_range(NULL::receipt_action))::text AS value",
      );
      expect(rows.map((r) => r.value)).toEqual([...RECEIPT_ACTIONS]);
      for (const { value } of rows) expect(value).not.toMatch(/sent|deliver/i);
    });

    it("the phone's id is the idempotency key; actions are append-only and tenant-scoped", async () => {
      const receipt = await insertReceipt(a, await insertPayment(a));
      const id = uuidv7();
      const insert = (values: Partial<typeof receiptActions.$inferInsert> = {}, s: Seed = a) =>
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.insert(receiptActions).values({
            id,
            operatorId: s.operatorId,
            receiptId: receipt.id,
            action: "whatsapp_opened",
            deviceId: s.deviceId,
            actorId: s.linemanId,
            at: new Date(),
            ...values,
          }),
        );
      await insert();
      await expect(insert({ action: "printed" })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "receipt_actions_pkey"),
      );
      await expect(insert({ id: uuidv7(), action: "delivered" as never })).rejects.toSatisfy(
        failsWith("22P02"),
      );
      // Web: printed at the counter, no device.
      await insert({ id: uuidv7(), action: "printed", deviceId: null, actorId: a.ownerId });
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.update(receiptActions).set({ action: "printed" }).where(eq(receiptActions.id, id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.delete(receiptActions).where(eq(receiptActions.id, id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE receipt_actions")).rejects.toSatisfy(
        isImmutableRowError,
      );
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(receiptActions).where(eq(receiptActions.id, id)),
      );
      expect(seenByB).toEqual([]);
      await expect(insert({ id: uuidv7() }, b)).rejects.toSatisfy(failsWith(FK_VIOLATION));
    });
  });
});

/**
 * Billing tables (T-023): invoices (RULE-05 one regular invoice per customer and period, numbers
 * unique per operator, immutability except the void metadata), invoice lines, adjustments,
 * billing runs and their items. Every constraint and trigger has a test; isolation cases too.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { adjustments, billingRunItems, billingRuns, invoiceLines, invoices } from "./billing";
import { vcAssets, vcAssignments } from "./connections";
import { nextCounter } from "./counters";
import { customers } from "./customers";

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
  customerIds: [string, string];
  assignmentId: string;
}

describeDb("invoices, invoice_lines, adjustments, billing_runs and billing_run_items", () => {
  const t = useTestDatabase();
  let a: Seed;
  let b: Seed;

  async function seed(): Promise<Seed> {
    const tenant = await createTenant(t.current);
    const owner = await createUser(t.current, { operatorId: tenant.operatorId });
    const operatorId = tenant.operatorId;
    const customerIds: [string, string] = [uuidv7(), uuidv7()];
    const assignmentId = uuidv7();
    await t.current.db.withTenant(operatorId, async (tx) => {
      await tx
        .insert(customers)
        .values(
          customerIds.map((id, i) => ({ id, operatorId, customerCode: `C${i}`, name: `C ${i}` })),
        );
      const vcAssetId = uuidv7();
      await tx.insert(vcAssets).values({ id: vcAssetId, operatorId, vcNumber: "VC1" });
      await tx.insert(vcAssignments).values({
        id: assignmentId,
        operatorId,
        vcAssetId,
        customerId: customerIds[0],
        startDate: "2026-09-01",
        rentalAmountPaise: 40_000,
      });
    });
    return { tenant, operatorId, ownerId: owner.userId, customerIds, assignmentId };
  }

  let numberSeq = 0;
  const invoiceValues = (s: Seed, overrides: Partial<typeof invoices.$inferInsert> = {}) => {
    numberSeq += 1;
    return {
      id: uuidv7(),
      operatorId: s.operatorId,
      customerId: s.customerIds[0],
      period: "2026-10-01",
      invoiceNumber: `INV-2610-${String(numberSeq).padStart(5, "0")}`,
      openingBalancePaise: 0,
      chargesPaise: 40_000,
      totalDuePaise: 40_000,
      ...overrides,
    } satisfies typeof invoices.$inferInsert;
  };
  const insertInvoice = (s: Seed, overrides: Partial<typeof invoices.$inferInsert> = {}) =>
    t.current.db
      .withTenant(s.operatorId, (tx) =>
        tx.insert(invoices).values(invoiceValues(s, overrides)).returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });

  const insertAdjustment = (s: Seed, overrides: Partial<typeof adjustments.$inferInsert> = {}) =>
    t.current.db
      .withTenant(s.operatorId, (tx) =>
        tx
          .insert(adjustments)
          .values({
            id: uuidv7(),
            operatorId: s.operatorId,
            customerId: s.customerIds[0],
            assignmentId: s.assignmentId,
            period: "2026-10-01",
            direction: "debit",
            amountPaise: 10_000,
            source: "plan_change",
            ...overrides,
          })
          .returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  describe("invoices", () => {
    it("RULE-05: a second regular invoice for the same customer and period fails", async () => {
      const s = await seed();
      await insertInvoice(s, { period: "2026-10-01" });
      await expect(insertInvoice(s, { period: "2026-10-01" })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "invoices_one_regular_per_period"),
      );
      // Other periods, other customers, and an opening_balance invoice in the same period are fine.
      await insertInvoice(s, { period: "2026-11-01" });
      await insertInvoice(s, { period: "2026-10-01", customerId: s.customerIds[1] });
      await insertInvoice(s, { period: "2026-10-01", kind: "opening_balance" });
    });

    it("RULE-05 holds under concurrency: two runs inserting the same bill → exactly one wins", async () => {
      const s = await seed();
      const attempt = () =>
        t.current.db.withTenant(s.operatorId, async (tx) => {
          const number = await nextCounter(tx, s.operatorId, "invoice");
          await tx
            .insert(invoices)
            .values(invoiceValues(s, { period: "2027-01-01", invoiceNumber: `INV-${number}` }));
          await tx.execute(sql`select pg_sleep(0.05)`);
        });
      const results = await Promise.allSettled([attempt(), attempt(), attempt(), attempt()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(violates(UNIQUE_VIOLATION, "invoices_one_regular_per_period")(r.reason)).toBe(
            true,
          );
        }
      }
      const rows = await t.current.db.withTenant(s.operatorId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.period, "2027-01-01")),
      );
      expect(rows).toHaveLength(1);
      // The losers rolled back their counter increments: numbering stays gap-free.
      expect(rows[0]?.invoiceNumber).toBe("INV-1");
    });

    it("invoice numbers are unique per operator only", async () => {
      await insertInvoice(a, { invoiceNumber: "INV-SAME", period: "2026-01-01" });
      await insertInvoice(b, { invoiceNumber: "INV-SAME", period: "2026-01-01" });
      await expect(
        insertInvoice(a, { invoiceNumber: "INV-SAME", period: "2026-02-01" }),
      ).rejects.toSatisfy(violates(UNIQUE_VIOLATION, "invoices_operator_number_unique"));
      await expect(
        insertInvoice(a, { invoiceNumber: " ", period: "2026-03-01" }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "invoices_number_not_blank"));
    });

    it("checks the period, the amounts and the void metadata", async () => {
      await expect(insertInvoice(a, { period: "2026-04-02" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "invoices_period_first_day"),
      );
      await expect(
        insertInvoice(a, { period: "2026-04-01", chargesPaise: -1, totalDuePaise: -1 }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "invoices_charges_not_negative"));
      await expect(
        insertInvoice(a, { period: "2026-04-01", openingBalancePaise: 500, totalDuePaise: 40_000 }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "invoices_total_due_is_opening_plus_charges"));
      await expect(insertInvoice(a, { period: "2026-04-01", status: "void" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "invoices_void_metadata"),
      );
      await expect(
        insertInvoice(a, { period: "2026-04-01", legacySource: "legacy" }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "invoices_legacy_both_or_neither"));
      // Credit larger than dues: a negative total is a valid snapshot (T-040).
      const row = await insertInvoice(a, {
        period: "2026-04-01",
        openingBalancePaise: -50_000,
        totalDuePaise: -10_000,
      });
      expect(row).toMatchObject({ kind: "regular", status: "issued", totalDuePaise: -10_000 });
    });

    it("an issued invoice never changes except to void, and void is final", async () => {
      const row = await insertInvoice(a, { period: "2026-05-01" });
      const update = (set: Partial<typeof invoices.$inferInsert>) =>
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.update(invoices).set(set).where(eq(invoices.id, row.id)),
        );
      for (const set of [
        { chargesPaise: 1, totalDuePaise: 1 },
        { invoiceNumber: "X-1" },
        { period: "2026-06-01" },
        { customerId: a.customerIds[1] },
        { kind: "opening_balance" as const },
      ]) {
        await expect(update(set), JSON.stringify(set)).rejects.toSatisfy(isImmutableRowError);
      }
      // A no-op update passes; void with its metadata passes.
      await update({ status: "issued" });
      await update({
        status: "void",
        voidedAt: new Date(),
        voidedBy: a.ownerId,
        voidReason: "Billed by mistake",
      });
      await expect(
        update({ status: "issued", voidedAt: null, voidedBy: null, voidReason: null }),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(update({ voidReason: "changed" })).rejects.toSatisfy(isImmutableRowError);
      // Never deleted, by any role.
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.delete(invoices).where(eq(invoices.id, row.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.admin.query("DELETE FROM invoices WHERE id = $1", [row.id]),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE invoices CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("is tenant-scoped and only for the tenant's own customers", async () => {
      const row = await insertInvoice(a, { period: "2026-07-01" });
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, row.id)),
      );
      expect(seenByB).toEqual([]);
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.insert(invoices).values(invoiceValues(a, { period: "2026-08-01" })),
        ),
      ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
      await expect(
        insertInvoice(b, { customerId: a.customerIds[0], period: "2026-08-01" }),
      ).rejects.toSatisfy(violates(FK_VIOLATION, "invoices_customer_fk"));
    });
  });

  describe("adjustments", () => {
    it("checks amount, sources and directions", async () => {
      await expect(insertAdjustment(a, { amountPaise: 0 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "adjustments_amount_positive"),
      );
      await expect(insertAdjustment(a, { assignmentId: null })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "adjustments_rental_sources_name_connection"),
      );
      await expect(
        insertAdjustment(a, { source: "mid_month_start", period: null }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "adjustments_rental_sources_name_connection"));
      await expect(
        insertAdjustment(a, { source: "mid_month_start", direction: "credit" }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "adjustments_mid_month_start_is_debit"));
      await expect(insertAdjustment(a, { period: "2026-10-15" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "adjustments_period_first_day"),
      );
      // Manual: reason and author required; no connection needed.
      const manual = { source: "manual" as const, assignmentId: null, period: null };
      await expect(insertAdjustment(a, { ...manual, createdBy: a.ownerId })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "adjustments_manual_has_reason_and_author"),
      );
      await expect(
        insertAdjustment(a, { ...manual, createdBy: a.ownerId, reason: "  " }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "adjustments_manual_has_reason_and_author"));
      await expect(insertAdjustment(a, { ...manual, reason: "Discount" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "adjustments_manual_has_reason_and_author"),
      );
      await insertAdjustment(a, {
        ...manual,
        direction: "credit",
        reason: "Discount",
        createdBy: a.ownerId,
      });
      // Plan change both ways, migration without a connection.
      await insertAdjustment(a, { direction: "credit" });
      await insertAdjustment(a, { source: "migration", assignmentId: null, period: null });
    });

    it("a debit is invoiced once on its own customer's invoice; credits are never invoiced", async () => {
      const s = await seed();
      const debit = await insertAdjustment(s);
      const credit = await insertAdjustment(s, { direction: "credit" });
      const invoice = await insertInvoice(s, { period: "2026-11-01" });
      const otherCustomersInvoice = await insertInvoice(s, {
        period: "2026-11-01",
        customerId: s.customerIds[1],
      });
      const setInvoice = (id: string, invoiceId: string | null) =>
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.update(adjustments).set({ invoiceId }).where(eq(adjustments.id, id)),
        );
      await expect(setInvoice(credit.id, invoice.id)).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "adjustments_only_debits_invoiced"),
      );
      await expect(setInvoice(debit.id, otherCustomersInvoice.id)).rejects.toSatisfy(
        violates(FK_VIOLATION, "adjustments_invoice_fk"),
      );
      await setInvoice(debit.id, invoice.id);
      await setInvoice(debit.id, invoice.id); // same value: no change, passes
      await expect(setInvoice(debit.id, null)).rejects.toSatisfy(isImmutableRowError);
      const later = await insertInvoice(s, { period: "2026-12-01" });
      await expect(setInvoice(debit.id, later.id)).rejects.toSatisfy(isImmutableRowError);
    });

    it("is append-only apart from invoice_id", async () => {
      const row = await insertAdjustment(a);
      for (const set of [
        { amountPaise: 1 },
        { direction: "credit" as const },
        { reason: "edited" },
        { period: "2026-11-01" },
      ]) {
        await expect(
          t.current.db.withTenant(a.operatorId, (tx) =>
            tx.update(adjustments).set(set).where(eq(adjustments.id, row.id)),
          ),
          JSON.stringify(set),
        ).rejects.toSatisfy(isImmutableRowError);
      }
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.delete(adjustments).where(eq(adjustments.id, row.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE adjustments CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("is tenant-scoped; references stay inside the tenant", async () => {
      const row = await insertAdjustment(a);
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(adjustments).where(eq(adjustments.id, row.id)),
      );
      expect(seenByB).toEqual([]);
      await expect(insertAdjustment(b, { assignmentId: a.assignmentId })).rejects.toSatisfy(
        violates(FK_VIOLATION, "adjustments_assignment_fk"),
      );
      await expect(
        insertAdjustment(b, { source: "manual", reason: "x", createdBy: a.ownerId }),
      ).rejects.toSatisfy(failsWith(FK_VIOLATION));
    });
  });

  describe("invoice_lines", () => {
    let s: Seed;
    let invoiceId: string;
    let debitId: string;

    beforeAll(async () => {
      s = await seed();
      invoiceId = (
        await insertInvoice(s, {
          period: "2026-10-01",
          chargesPaise: 50_000,
          totalDuePaise: 50_000,
        })
      ).id;
      debitId = (await insertAdjustment(s)).id;
    });

    const insertLine = (values: Partial<typeof invoiceLines.$inferInsert>) =>
      t.current.db.withTenant(s.operatorId, (tx) =>
        tx
          .insert(invoiceLines)
          .values({
            id: uuidv7(),
            operatorId: s.operatorId,
            invoiceId,
            type: "rent",
            assignmentId: s.assignmentId,
            amountPaise: 40_000,
            ...values,
          })
          .returning(),
      );

    it("rent lines: one per assignment and invoice, amount ≥ 0", async () => {
      await expect(insertLine({ assignmentId: null })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "invoice_lines_shape"),
      );
      await expect(insertLine({ amountPaise: -1 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "invoice_lines_shape"),
      );
      await insertLine({});
      await expect(insertLine({ amountPaise: 0 })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "invoice_lines_one_rent_per_assignment"),
      );
      // A ₹0 rental gives a ₹0 line (T-040), on another invoice.
      const other = await insertInvoice(s, { period: "2026-09-01" });
      await t.current.db.withTenant(s.operatorId, (tx) =>
        tx.insert(invoiceLines).values({
          id: uuidv7(),
          operatorId: s.operatorId,
          invoiceId: other.id,
          type: "rent",
          assignmentId: s.assignmentId,
          amountPaise: 0,
        }),
      );
    });

    it("adjustment lines bill a debit adjustment already marked with this invoice, once", async () => {
      const line = { type: "adjustment" as const, adjustmentId: debitId, amountPaise: 10_000 };
      await expect(insertLine({ ...line, adjustmentId: null })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "invoice_lines_shape"),
      );
      await expect(insertLine({ ...line, amountPaise: 0 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "invoice_lines_shape"),
      );
      // The adjustment is still pending: the line can't claim it.
      await expect(insertLine(line)).rejects.toSatisfy(
        violates(FK_VIOLATION, "invoice_lines_adjustment_fk"),
      );
      await t.current.db.withTenant(s.operatorId, (tx) =>
        tx.update(adjustments).set({ invoiceId }).where(eq(adjustments.id, debitId)),
      );
      await insertLine(line);
      await expect(insertLine(line)).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "invoice_lines_adjustment_unique"),
      );
    });

    it("is append-only for every role", async () => {
      const rows = await t.current.db.withTenant(s.operatorId, (tx) =>
        tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)),
      );
      const id = rows[0]?.id ?? "";
      await expect(
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.update(invoiceLines).set({ amountPaise: 1 }).where(eq(invoiceLines.id, id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.update(invoiceLines).set({ description: "x" }).where(eq(invoiceLines.id, id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.admin.query("DELETE FROM invoice_lines WHERE id = $1", [id]),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE invoice_lines")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("is tenant-scoped", async () => {
      const seenByA = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)),
      );
      expect(seenByA).toEqual([]);
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.insert(invoiceLines).values({
            id: uuidv7(),
            operatorId: a.operatorId,
            invoiceId,
            type: "rent",
            assignmentId: a.assignmentId,
            amountPaise: 1,
          }),
        ),
      ).rejects.toSatisfy(violates(FK_VIOLATION, "invoice_lines_invoice_fk"));
    });
  });

  describe("billing_runs and billing_run_items", () => {
    const insertRun = (s: Seed, values: Partial<typeof billingRuns.$inferInsert> = {}) =>
      t.current.db
        .withTenant(s.operatorId, (tx) =>
          tx
            .insert(billingRuns)
            .values({
              id: uuidv7(),
              operatorId: s.operatorId,
              period: "2026-10-01",
              trigger: "cron",
              ...values,
            })
            .returning(),
        )
        .then(([row]) => {
          if (!row) throw new Error("insert returned nothing");
          return row;
        });

    it("one run per operator and period, with consistent status columns", async () => {
      const s = await seed();
      const run = await insertRun(s);
      expect(run).toMatchObject({ status: "pending", customerCount: 0, totalChargesPaise: 0 });
      await expect(insertRun(s)).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "billing_runs_operator_period_unique"),
      );
      await insertRun(b, { period: "2030-10-01" });
      await expect(insertRun(s, { period: "2026-11-02" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "billing_runs_period_first_day"),
      );
      await expect(insertRun(s, { period: "2026-11-01", trigger: "manual" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "billing_runs_manual_has_actor"),
      );
      await expect(
        insertRun(s, { period: "2026-11-01", status: "skipped", finishedAt: new Date() }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "billing_runs_skip_reason_iff_skipped"));
      await expect(insertRun(s, { period: "2026-11-01", status: "completed" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "billing_runs_finished_iff_done"),
      );
      await expect(insertRun(s, { period: "2026-11-01", failedCount: -1 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "billing_runs_counts_not_negative"),
      );
      const skipped = await insertRun(s, {
        period: "2026-11-01",
        status: "skipped",
        skipReason: "tenant_read_only",
        finishedAt: new Date(),
      });
      // D-25: the owner later runs the skipped month manually, reusing the run.
      await t.current.db.withTenant(s.operatorId, (tx) =>
        tx
          .update(billingRuns)
          .set({
            status: "running",
            skipReason: null,
            finishedAt: null,
            trigger: "manual",
            actorId: s.ownerId,
            startedAt: new Date(),
          })
          .where(eq(billingRuns.id, skipped.id)),
      );
      // A run keeps its period and tenant and is never deleted.
      await expect(
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.update(billingRuns).set({ period: "2026-12-01" }).where(eq(billingRuns.id, run.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.delete(billingRuns).where(eq(billingRuns.id, run.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE billing_runs CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("items: one per customer per run; failed → retried → created, then final", async () => {
      const s = await seed();
      const run = await insertRun(s);
      const invoice = await insertInvoice(s, { period: "2026-10-01" });
      const insertItem = (values: Partial<typeof billingRunItems.$inferInsert>) =>
        t.current.db
          .withTenant(s.operatorId, (tx) =>
            tx
              .insert(billingRunItems)
              .values({
                id: uuidv7(),
                operatorId: s.operatorId,
                runId: run.id,
                customerId: s.customerIds[0],
                outcome: "failed",
                reason: "invalid_transition",
                ...values,
              })
              .returning(),
          )
          .then(([row]) => {
            if (!row) throw new Error("insert returned nothing");
            return row;
          });
      await expect(insertItem({ reason: null })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "billing_run_items_reason_when_not_billed"),
      );
      await expect(insertItem({ outcome: "created", reason: null })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "billing_run_items_invoice_iff_billed"),
      );
      await expect(insertItem({ invoiceId: invoice.id })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "billing_run_items_invoice_iff_billed"),
      );
      await expect(
        insertItem({
          outcome: "skipped",
          details: sql`'[]'::jsonb` as unknown as Record<string, unknown>,
        }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "billing_run_items_details_object"));
      // The other customer's invoice can't be this customer's item's invoice.
      await expect(
        insertItem({
          outcome: "created",
          reason: null,
          customerId: s.customerIds[1],
          invoiceId: invoice.id,
        }),
      ).rejects.toSatisfy(violates(FK_VIOLATION, "billing_run_items_invoice_fk"));

      const item = await insertItem({ details: { assignmentId: s.assignmentId } });
      await expect(insertItem({})).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "billing_run_items_run_customer_unique"),
      );
      const update = (set: Partial<typeof billingRunItems.$inferInsert>) =>
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.update(billingRunItems).set(set).where(eq(billingRunItems.id, item.id)),
        );
      await update({ outcome: "created", reason: null, invoiceId: invoice.id, attempts: 2 });
      await update({ updatedAt: new Date() });
      await expect(update({ outcome: "failed", reason: "x", invoiceId: null })).rejects.toSatisfy(
        isImmutableRowError,
      );
      await expect(update({ customerId: s.customerIds[1] })).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(s.operatorId, (tx) =>
          tx.delete(billingRunItems).where(eq(billingRunItems.id, item.id)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      const [stored] = await t.current.db.withTenant(s.operatorId, (tx) =>
        tx
          .select()
          .from(billingRunItems)
          .where(and(eq(billingRunItems.runId, run.id), eq(billingRunItems.outcome, "created"))),
      );
      expect(stored).toMatchObject({ invoiceId: invoice.id, attempts: 2 });
    });

    it("are tenant-scoped", async () => {
      const run = await insertRun(a, { period: "2031-01-01" });
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(billingRuns).where(eq(billingRuns.id, run.id)),
      );
      expect(seenByB).toEqual([]);
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.insert(billingRunItems).values({
            id: uuidv7(),
            operatorId: b.operatorId,
            runId: run.id,
            customerId: b.customerIds[0],
            outcome: "skipped",
            reason: "nothing_to_bill",
          }),
        ),
      ).rejects.toSatisfy(violates(FK_VIOLATION, "billing_run_items_run_fk"));
    });
  });
});

/**
 * Ledger (T-023): the money path end to end through the real tables, checked with T-041's
 * `checkLedger` on the rows read back (the schema maps onto the domain model), plus the
 * constraints and triggers of `allocations`, `ledger_entries` and `customer_balances`.
 *
 * The small "services" below follow PLAN §8.2 / §8.4 / §8.5 / §8.6 and T-041's completion notes:
 * they are a reference for T-044 / T-045 / T-046, not production code.
 */
import {
  type AllocationRow,
  allocate,
  applyCredit,
  type CreditSource,
  checkLedger,
  invoiceOutstanding,
  type LedgerState,
  type OpenInvoice,
  type Paise,
  paise,
  period,
  reverse,
  toPaise,
  unallocatedRemainder,
} from "@cb/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import type { Tx } from "../tenant";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { devices } from "./auth";
import { adjustments, invoiceLines, invoices } from "./billing";
import { vcAssets, vcAssignments } from "./connections";
import { nextCounter } from "./counters";
import { customers } from "./customers";
import { allocations, customerBalances, ledgerEntries } from "./ledger";
import { paymentReversals, payments } from "./payments";
import { receipts } from "./receipts";

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
  assignmentId: string;
}

// ── Reference "services" over the tables (PLAN §8) ──────────────────────────────────────────────

/** Locks (creating it if needed) the customer's balance row: serialises its money changes. */
async function lockBalance(tx: Tx, operatorId: string, customerId: string) {
  await tx.insert(customerBalances).values({ customerId, operatorId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(customerBalances)
    .where(eq(customerBalances.customerId, customerId))
    .for("update");
  if (!row) throw new Error("balance row missing");
  return { balancePaise: toPaise(row.balancePaise), creditPaise: toPaise(row.creditPaise) };
}

async function allocationRows(tx: Tx, customerId: string) {
  const rows = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.customerId, customerId))
    .orderBy(asc(allocations.createdAt), asc(allocations.id));
  return rows.map((r): AllocationRow & { kind: string } => ({
    id: r.id,
    invoiceId: r.invoiceId,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    amountPaise: toPaise(r.amountPaise),
    reversalId: r.reversalId,
    kind: r.kind,
  }));
}

/** Open invoices with `outstanding = charges − Σ allocations` (T-041 `invoiceOutstanding`). */
async function openInvoices(tx: Tx, customerId: string): Promise<OpenInvoice[]> {
  const invoiceRows = await tx.select().from(invoices).where(eq(invoices.customerId, customerId));
  const rows = await allocationRows(tx, customerId);
  return invoiceRows.map((inv) => ({
    id: inv.id,
    period: period(inv.period),
    outstandingPaise: invoiceOutstanding(
      toPaise(inv.chargesPaise),
      rows.filter((r) => r.invoiceId === inv.id),
    ),
  }));
}

/** Inserts allocation rows, filling `outstanding_after_paise` from the running outstanding. */
async function insertAllocations(
  tx: Tx,
  s: Seed,
  customerId: string,
  open: readonly OpenInvoice[],
  rows: readonly {
    invoiceId: string;
    sourceType: "payment" | "credit_adjustment";
    sourceId: string;
    amountPaise: Paise;
    kind: "posting" | "credit_application" | "reversal";
    reversalId?: string;
    reversesAllocationId?: string;
  }[],
) {
  const outstanding = new Map(open.map((o) => [o.id, o.outstandingPaise as number]));
  for (const row of rows) {
    const after = (outstanding.get(row.invoiceId) ?? 0) - row.amountPaise;
    outstanding.set(row.invoiceId, after);
    await tx.insert(allocations).values({
      id: uuidv7(),
      operatorId: s.operatorId,
      customerId,
      invoiceId: row.invoiceId,
      sourceType: row.sourceType,
      paymentId: row.sourceType === "payment" ? row.sourceId : null,
      creditAdjustmentId: row.sourceType === "credit_adjustment" ? row.sourceId : null,
      kind: row.kind,
      amountPaise: row.amountPaise,
      outstandingAfterPaise: after,
      reversalId: row.reversalId ?? null,
      reversesAllocationId: row.reversesAllocationId ?? null,
    });
  }
}

/** Every live credit source of the customer (PLAN §8.5), oldest first by T-041's rules. */
async function creditSources(tx: Tx, customerId: string): Promise<CreditSource[]> {
  const rows = await allocationRows(tx, customerId);
  const paymentRows = await tx
    .select({ p: payments, reversalId: paymentReversals.id })
    .from(payments)
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(eq(payments.customerId, customerId));
  const credits = await tx
    .select()
    .from(adjustments)
    .where(and(eq(adjustments.customerId, customerId), eq(adjustments.direction, "credit")));
  return [
    ...paymentRows.map(({ p, reversalId }) => ({
      sourceType: "payment" as const,
      sourceId: p.id,
      at: p.postedAt,
      availablePaise: unallocatedRemainder(
        { amountPaise: toPaise(p.amountPaise), reversed: reversalId !== null },
        rows.filter((r) => r.sourceId === p.id),
      ),
    })),
    ...credits.map((c) => ({
      sourceType: "credit_adjustment" as const,
      sourceId: c.id,
      at: c.createdAt,
      availablePaise: unallocatedRemainder(
        { amountPaise: toPaise(c.amountPaise) },
        rows.filter((r) => r.sourceId === c.id),
      ),
    })),
  ].filter((source) => source.availablePaise > 0);
}

/** PLAN §8.5: apply available credit to the oldest invoices; the balance does not change. */
async function applyAvailableCredit(tx: Tx, s: Seed, customerId: string) {
  const open = await openInvoices(tx, customerId);
  const result = applyCredit(await creditSources(tx, customerId), open);
  if (!result.ok) throw new Error(`applyCredit: ${result.error.code}`);
  await insertAllocations(
    tx,
    s,
    customerId,
    open,
    result.value.allocations.map((a) => ({ ...a, kind: "credit_application" as const })),
  );
  await tx
    .update(customerBalances)
    .set({
      creditPaise: sql`${customerBalances.creditPaise} - ${result.value.appliedPaise}`,
      updatedAt: sql`now()`,
    })
    .where(eq(customerBalances.customerId, customerId));
}

/** PLAN §8.2 for one customer: invoice + lines + ledger + balance, then credit application. */
async function issueInvoice(
  tx: Tx,
  s: Seed,
  input: { customerId: string; period: string; rentPaise: number; debitAdjustmentIds?: string[] },
) {
  const { balancePaise } = await lockBalance(tx, s.operatorId, input.customerId);
  const pending = input.debitAdjustmentIds?.length
    ? await tx
        .select()
        .from(adjustments)
        .where(
          and(
            eq(adjustments.customerId, input.customerId),
            eq(adjustments.direction, "debit"),
            isNull(adjustments.invoiceId),
          ),
        )
    : [];
  const charges = input.rentPaise + pending.reduce((sum, a) => sum + a.amountPaise, 0);
  const invoiceId = uuidv7();
  const seq = await nextCounter(tx, s.operatorId, "invoice");
  await tx.insert(invoices).values({
    id: invoiceId,
    operatorId: s.operatorId,
    customerId: input.customerId,
    period: input.period,
    invoiceNumber: `INV-${input.period.slice(2, 4)}${input.period.slice(5, 7)}-${String(seq).padStart(5, "0")}`,
    openingBalancePaise: balancePaise,
    chargesPaise: charges,
    totalDuePaise: balancePaise + charges,
  });
  // Mark the debit adjustments billed first: invoice_lines_adjustment_fk needs it.
  for (const adjustment of pending) {
    await tx.update(adjustments).set({ invoiceId }).where(eq(adjustments.id, adjustment.id));
  }
  await tx.insert(invoiceLines).values([
    {
      id: uuidv7(),
      operatorId: s.operatorId,
      invoiceId,
      type: "rent",
      assignmentId: s.assignmentId,
      amountPaise: input.rentPaise,
    },
    ...pending.map((a) => ({
      id: uuidv7(),
      operatorId: s.operatorId,
      invoiceId,
      type: "adjustment" as const,
      assignmentId: a.assignmentId,
      adjustmentId: a.id,
      amountPaise: a.amountPaise,
    })),
  ]);
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId: s.operatorId,
    customerId: input.customerId,
    type: "invoice",
    amountPaise: charges,
    invoiceId,
  });
  await tx
    .update(customerBalances)
    .set({ balancePaise: sql`${customerBalances.balancePaise} + ${charges}` })
    .where(eq(customerBalances.customerId, input.customerId));
  await applyAvailableCredit(tx, s, input.customerId);
  return invoiceId;
}

/** PLAN §8.4: payment + ledger + oldest-first allocation + receipt + snapshots. */
async function postPayment(
  tx: Tx,
  s: Seed,
  input: { customerId: string; amountPaise: number; recordedAt: Date },
) {
  const before = await lockBalance(tx, s.operatorId, input.customerId);
  const open = await openInvoices(tx, input.customerId);
  const result = allocate(paise(input.amountPaise), open);
  if (!result.ok) throw new Error(`allocate: ${result.error.code}`);
  const paymentId = uuidv7();
  const balanceAfter = before.balancePaise - input.amountPaise;
  const creditAfter = before.creditPaise + result.value.creditPaise;
  await tx.insert(payments).values({
    id: paymentId,
    operatorId: s.operatorId,
    customerId: input.customerId,
    amountPaise: input.amountPaise,
    method: "cash",
    collectorId: s.linemanId,
    deviceId: s.deviceId,
    source: "android",
    recordedAt: input.recordedAt,
    businessDate: "2026-10-12",
    balanceAfterPaise: balanceAfter,
    creditAfterPaise: creditAfter,
  });
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId: s.operatorId,
    customerId: input.customerId,
    type: "payment",
    amountPaise: -input.amountPaise,
    paymentId,
  });
  await insertAllocations(
    tx,
    s,
    input.customerId,
    open,
    result.value.allocations.map((a) => ({
      ...a,
      sourceType: "payment" as const,
      sourceId: paymentId,
      kind: "posting" as const,
    })),
  );
  const seq = await nextCounter(tx, s.operatorId, "receipt");
  await tx.insert(receipts).values({
    id: uuidv7(),
    operatorId: s.operatorId,
    paymentId,
    receiptNumber: `R-2610-${String(seq).padStart(5, "0")}`,
    provisionalRef: "P-K7Q-0012",
  });
  await tx
    .update(customerBalances)
    .set({ balancePaise: balanceAfter, creditPaise: creditAfter })
    .where(eq(customerBalances.customerId, input.customerId));
  return paymentId;
}

/** A credit adjustment: a credit source with a `credit_adjustment` ledger entry (−amount). */
async function addCreditAdjustment(tx: Tx, s: Seed, customerId: string, amountPaise: number) {
  await lockBalance(tx, s.operatorId, customerId);
  const id = uuidv7();
  await tx.insert(adjustments).values({
    id,
    operatorId: s.operatorId,
    customerId,
    direction: "credit",
    amountPaise,
    source: "manual",
    reason: "Goodwill discount",
    createdBy: s.ownerId,
  });
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId: s.operatorId,
    customerId,
    type: "credit_adjustment",
    amountPaise: -amountPaise,
    adjustmentId: id,
  });
  await tx
    .update(customerBalances)
    .set({
      balancePaise: sql`${customerBalances.balancePaise} - ${amountPaise}`,
      creditPaise: sql`${customerBalances.creditPaise} + ${amountPaise}`,
    })
    .where(eq(customerBalances.customerId, customerId));
  return id;
}

/** PLAN §8.6: reversal row + ledger (+amount) + negative rows cancelling every allocation. */
async function reversePayment(tx: Tx, s: Seed, customerId: string, paymentId: string) {
  await lockBalance(tx, s.operatorId, customerId);
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) throw new Error("payment missing");
  const rows = (await allocationRows(tx, customerId)).filter((r) => r.sourceId === paymentId);
  const result = reverse(
    { id: paymentId, amountPaise: toPaise(payment.amountPaise), reversed: false },
    rows,
  );
  if (!result.ok) throw new Error(`reverse: ${result.error.code}`);
  const reversalId = uuidv7();
  await tx.insert(paymentReversals).values({
    id: reversalId,
    operatorId: s.operatorId,
    customerId,
    paymentId,
    reason: "Counted twice",
    actorId: s.ownerId,
  });
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId: s.operatorId,
    customerId,
    type: "payment_reversal",
    amountPaise: result.value.ledgerDeltaPaise,
    paymentReversalId: reversalId,
  });
  await insertAllocations(
    tx,
    s,
    customerId,
    await openInvoices(tx, customerId),
    result.value.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      sourceType: "payment" as const,
      sourceId: a.sourceId,
      amountPaise: a.amountPaise,
      kind: "reversal" as const,
      reversalId,
      reversesAllocationId: a.reversesAllocationId,
    })),
  );
  await tx
    .update(customerBalances)
    .set({
      balancePaise: sql`${customerBalances.balancePaise} + ${result.value.ledgerDeltaPaise}`,
      creditPaise: sql`${customerBalances.creditPaise} + ${result.value.creditDeltaPaise}`,
    })
    .where(eq(customerBalances.customerId, customerId));
  return reversalId;
}

/** Reads one customer's rows back and maps them onto T-041's `LedgerState`. */
async function ledgerState(tx: Tx, customerId: string): Promise<LedgerState> {
  const invoiceRows = await tx.select().from(invoices).where(eq(invoices.customerId, customerId));
  const paymentRows = await tx
    .select({ p: payments, reversalId: paymentReversals.id })
    .from(payments)
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(eq(payments.customerId, customerId));
  const creditRows = await tx
    .select()
    .from(adjustments)
    .where(and(eq(adjustments.customerId, customerId), eq(adjustments.direction, "credit")));
  const entryRows = await tx
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.customerId, customerId))
    .orderBy(asc(ledgerEntries.seq));
  const [balance] = await tx
    .select()
    .from(customerBalances)
    .where(eq(customerBalances.customerId, customerId));
  return {
    invoices: invoiceRows.map((i) => ({ id: i.id, chargesPaise: toPaise(i.chargesPaise) })),
    payments: paymentRows.map(({ p, reversalId }) => ({
      id: p.id,
      amountPaise: toPaise(p.amountPaise),
      reversed: reversalId !== null,
    })),
    creditAdjustments: creditRows.map((c) => ({ id: c.id, amountPaise: toPaise(c.amountPaise) })),
    allocations: (await allocationRows(tx, customerId)).map(({ kind: _kind, ...row }) => row),
    ledgerEntries: entryRows.map((e) => ({ type: e.type, amountPaise: toPaise(e.amountPaise) })),
    balancePaise: toPaise(balance?.balancePaise ?? 0),
    creditPaise: toPaise(balance?.creditPaise ?? 0),
  };
}

describeDb("allocations, ledger_entries and customer_balances", () => {
  const t = useTestDatabase();
  let a: Seed;
  let b: Seed;

  async function seed(): Promise<Seed> {
    const tenant = await createTenant(t.current);
    const owner = await createUser(t.current, { operatorId: tenant.operatorId });
    const lineman = await createUser(t.current, {
      operatorId: tenant.operatorId,
      role: "lineman",
    });
    const operatorId = tenant.operatorId;
    const customerIds: [string, string] = [uuidv7(), uuidv7()];
    const deviceId = uuidv7();
    const assignmentId = uuidv7();
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
      const vcAssetId = uuidv7();
      await tx.insert(vcAssets).values({ id: vcAssetId, operatorId, vcNumber: "VC1" });
      await tx.insert(vcAssignments).values({
        id: assignmentId,
        operatorId,
        vcAssetId,
        customerId: customerIds[0],
        startDate: "2026-09-01",
        rentalAmountPaise: 50_000,
      });
    });
    return {
      tenant,
      operatorId,
      ownerId: owner.userId,
      linemanId: lineman.userId,
      deviceId,
      customerIds,
      assignmentId,
    };
  }

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  describe("the schema maps onto T-041's ledger model", () => {
    it("invoice → payment → credit application → credit adjustment → reversal: checkLedger finds nothing", async () => {
      const s = await seed();
      const c = s.customerIds[0];
      const db = t.current.db;
      const tenant = <T>(fn: (tx: Tx) => Promise<T>) => db.withTenant(s.operatorId, fn);
      const healthy = async () => {
        const state = await db.withTenant(s.operatorId, (tx) => ledgerState(tx, c));
        expect(checkLedger(state)).toEqual([]);
        return state;
      };

      // October bill: ₹500.
      const oct = await db.withTenant(s.operatorId, (tx) =>
        issueInvoice(tx, s, { customerId: c, period: "2026-10-01", rentPaise: 50_000 }),
      );
      await healthy();

      // ₹700 cash: ₹500 pays October, ₹200 becomes credit.
      const paymentId = await db.withTenant(s.operatorId, (tx) =>
        postPayment(tx, s, { customerId: c, amountPaise: 70_000, recordedAt: new Date() }),
      );
      let state = await healthy();
      expect(state.balancePaise).toBe(-20_000);
      expect(state.creditPaise).toBe(20_000);
      const [posted] = await tenant((tx) =>
        tx.select().from(payments).where(eq(payments.id, paymentId)),
      );
      expect(posted?.balanceAfterPaise).toBe(-20_000);
      expect(posted?.creditAfterPaise).toBe(20_000);

      // A pending ₹100 debit adjustment, then the November bill (₹500 rent + ₹100): the ₹200
      // credit is applied to it straight away (PLAN §8.5).
      const debitId = uuidv7();
      await tenant((tx) =>
        tx.insert(adjustments).values({
          id: debitId,
          operatorId: s.operatorId,
          customerId: c,
          assignmentId: s.assignmentId,
          period: "2026-10-01",
          direction: "debit",
          amountPaise: 10_000,
          source: "plan_change",
        }),
      );
      const nov = await db.withTenant(s.operatorId, (tx) =>
        issueInvoice(tx, s, {
          customerId: c,
          period: "2026-11-01",
          rentPaise: 50_000,
          debitAdjustmentIds: [debitId],
        }),
      );
      state = await healthy();
      expect(state.balancePaise).toBe(40_000);
      expect(state.creditPaise).toBe(0);
      const [novRow] = await tenant((tx) => tx.select().from(invoices).where(eq(invoices.id, nov)));
      expect(novRow).toMatchObject({
        openingBalancePaise: -20_000,
        chargesPaise: 60_000,
        totalDuePaise: 40_000,
      });

      // ₹50 goodwill credit, applied to November.
      await db.withTenant(s.operatorId, async (tx) => {
        await addCreditAdjustment(tx, s, c, 5_000);
        await applyAvailableCredit(tx, s, c);
      });
      state = await healthy();
      expect(state.balancePaise).toBe(35_000);

      // The owner reverses the ₹700 payment: every row it had (posting and credit application)
      // is cancelled by a negative row; the originals are untouched.
      await db.withTenant(s.operatorId, (tx) => reversePayment(tx, s, c, paymentId));
      state = await healthy();
      expect(state.balancePaise).toBe(105_000);
      expect(state.creditPaise).toBe(0);
      const open = await db.withTenant(s.operatorId, (tx) => openInvoices(tx, c));
      expect(Object.fromEntries(open.map((o) => [o.id, o.outstandingPaise]))).toEqual({
        [oct]: 50_000,
        [nov]: 55_000,
      });
      const rows = await db.withTenant(s.operatorId, (tx) => allocationRows(tx, c));
      expect(rows.map((r) => [r.kind, r.amountPaise])).toEqual([
        ["posting", 50_000],
        ["credit_application", 20_000],
        ["credit_application", 5_000],
        ["reversal", -50_000],
        ["reversal", -20_000],
      ]);

      // The checker is live on these rows: a drifted read model is reported.
      await tenant((tx) =>
        tx
          .update(customerBalances)
          .set({ balancePaise: 105_001 })
          .where(eq(customerBalances.customerId, c)),
      );
      const drifted = await db.withTenant(s.operatorId, (tx) => ledgerState(tx, c));
      expect(checkLedger(drifted).map((v) => v.code)).toEqual(["BALANCE_MISMATCH"]);
    });
  });

  describe("allocations", () => {
    let customerId: string;
    let invoiceId: string;
    let paymentId: string;
    let allocationId: string;
    let reversalId: string;
    let creditAdjustmentId: string;
    let otherAllocationId: string;

    beforeAll(async () => {
      customerId = a.customerIds[0];
      await t.current.db.withTenant(a.operatorId, async (tx) => {
        invoiceId = await issueInvoice(tx, a, {
          customerId,
          period: "2026-12-01",
          rentPaise: 50_000,
        });
        paymentId = await postPayment(tx, a, {
          customerId,
          amountPaise: 30_000,
          recordedAt: new Date(),
        });
        const otherPaymentId = await postPayment(tx, a, {
          customerId,
          amountPaise: 20_000,
          recordedAt: new Date(),
        });
        const [other] = await tx
          .select()
          .from(allocations)
          .where(eq(allocations.paymentId, otherPaymentId));
        if (!other) throw new Error("no allocation");
        otherAllocationId = other.id;
        creditAdjustmentId = await addCreditAdjustment(tx, a, customerId, 1_000);
        reversalId = uuidv7();
        await tx.insert(paymentReversals).values({
          id: reversalId,
          operatorId: a.operatorId,
          customerId,
          paymentId,
          reason: "test",
          actorId: a.ownerId,
        });
      });
      const [row] = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(allocations).where(eq(allocations.paymentId, paymentId)),
      );
      if (!row) throw new Error("no allocation");
      allocationId = row.id;
    });

    const insert = (values: Partial<typeof allocations.$inferInsert>, s: Seed = a) =>
      t.current.db.withTenant(s.operatorId, (tx) =>
        tx.insert(allocations).values({
          id: uuidv7(),
          operatorId: s.operatorId,
          customerId,
          invoiceId,
          sourceType: "payment",
          paymentId,
          kind: "credit_application",
          amountPaise: 100,
          outstandingAfterPaise: 0,
          ...values,
        }),
      );

    it("source_id is generated from the one source column", async () => {
      const rows = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(allocations).where(eq(allocations.id, allocationId)),
      );
      expect(rows[0]?.sourceId).toBe(paymentId);
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.execute(sql`update allocations set source_id = ${uuidv7()} where false`),
        ),
      ).rejects.toSatisfy(failsWith("428C9"));
    });

    it("exactly one source column, matching source_type", async () => {
      await expect(insert({ paymentId: null })).rejects.toSatisfy(failsWith("23502"));
      await expect(insert({ creditAdjustmentId })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_one_source"),
      );
      await expect(
        insert({ sourceType: "credit_adjustment", paymentId: null, creditAdjustmentId }),
      ).resolves.toBeDefined();
      await expect(insert({ sourceType: "credit_adjustment" })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_one_source"),
      );
    });

    it("signs: zero never, negative only on reversal rows, posting only for payments", async () => {
      await expect(insert({ amountPaise: 0 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_amount_not_zero"),
      );
      await expect(insert({ amountPaise: -100 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_reversal_shape"),
      );
      await expect(insert({ reversalId })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_reversal_shape"),
      );
      await expect(
        insert({
          kind: "reversal",
          amountPaise: 100,
          reversalId,
          reversesAllocationId: allocationId,
        }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "allocations_reversal_shape"));
      await expect(
        insert({
          kind: "posting",
          sourceType: "credit_adjustment",
          paymentId: null,
          creditAdjustmentId,
        }),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "allocations_posting_is_payment"));
      await expect(insert({ outstandingAfterPaise: -1 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_outstanding_after_not_negative"),
      );
    });

    it("a reversal row cancels one positive row of the same invoice and payment, exactly and once", async () => {
      const reversal = (values: Partial<typeof allocations.$inferInsert>) =>
        insert({
          kind: "reversal",
          amountPaise: -30_000,
          reversalId,
          reversesAllocationId: allocationId,
          ...values,
        });
      await expect(reversal({ amountPaise: -29_999 })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_reversal_cancels_original"),
      );
      // Another payment's reversal can't be used (FK includes the payment).
      await expect(reversal({ reversalId: uuidv7() })).rejects.toSatisfy(failsWith(FK_VIOLATION));
      // The cancelled row must exist …
      await expect(reversal({ reversesAllocationId: uuidv7() })).rejects.toSatisfy(
        violates(CHECK_VIOLATION, "allocations_reversal_cancels_original"),
      );
      // … and be this invoice's and payment's (self FK), not another payment's row.
      await expect(
        reversal({ reversesAllocationId: otherAllocationId, amountPaise: -20_000 }),
      ).rejects.toSatisfy(violates(FK_VIOLATION, "allocations_reverses_fk"));
      await expect(reversal({})).resolves.toBeDefined();
      await expect(reversal({})).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "allocations_reverses_unique"),
      );
    });

    it("invoice and source must belong to the row's customer", async () => {
      // Customer 1 has no such invoice / payment: the same-customer composite FKs refuse.
      await expect(insert({ customerId: a.customerIds[1] })).rejects.toSatisfy(
        failsWith(FK_VIOLATION),
      );
      const otherInvoice = await t.current.db.withTenant(a.operatorId, (tx) =>
        issueInvoice(tx, a, {
          customerId: a.customerIds[1],
          period: "2026-12-01",
          rentPaise: 1_000,
        }),
      );
      await expect(insert({ invoiceId: otherInvoice })).rejects.toSatisfy(failsWith(FK_VIOLATION));
    });

    it("is append-only for every role", async () => {
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.update(allocations).set({ amountPaise: 1 }).where(eq(allocations.id, allocationId)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.delete(allocations).where(eq(allocations.id, allocationId)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.admin.query("UPDATE allocations SET kind = 'posting' WHERE id = $1", [
          allocationId,
        ]),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE allocations CASCADE")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("is tenant-scoped", async () => {
      const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(allocations).where(eq(allocations.id, allocationId)),
      );
      expect(seenByB).toEqual([]);
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.insert(allocations).values({
            id: uuidv7(),
            operatorId: a.operatorId,
            customerId,
            invoiceId,
            sourceType: "payment",
            paymentId,
            kind: "credit_application",
            amountPaise: 1,
            outstandingAfterPaise: 0,
          }),
        ),
      ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
      // B's row can't point at A's invoice / payment (composite FKs).
      await expect(insert({ operatorId: b.operatorId }, b)).rejects.toSatisfy(
        failsWith(FK_VIOLATION),
      );
    });
  });

  describe("ledger_entries", () => {
    let invoiceId: string;
    let paymentId: string;
    const customerOf = () => b.customerIds[0];

    beforeAll(async () => {
      await t.current.db.withTenant(b.operatorId, async (tx) => {
        invoiceId = await issueInvoice(tx, b, {
          customerId: customerOf(),
          period: "2026-10-01",
          rentPaise: 50_000,
        });
        paymentId = await postPayment(tx, b, {
          customerId: customerOf(),
          amountPaise: 10_000,
          recordedAt: new Date(),
        });
      });
    });

    const insert = (values: Partial<typeof ledgerEntries.$inferInsert>) =>
      t.current.db.withTenant(b.operatorId, (tx) =>
        tx
          .insert(ledgerEntries)
          .values({
            id: uuidv7(),
            operatorId: b.operatorId,
            customerId: customerOf(),
            type: "invoice",
            amountPaise: 1,
            ...values,
          })
          .returning(),
      );

    it("each type needs its own reference and sign", async () => {
      const cases: Array<[Partial<typeof ledgerEntries.$inferInsert>, string]> = [
        [{ type: "invoice", amountPaise: -1, invoiceId }, "ledger_entries_reference_and_sign"],
        [{ type: "invoice", paymentId }, "ledger_entries_reference_and_sign"],
        [
          { type: "opening_balance", amountPaise: -1, invoiceId },
          "ledger_entries_reference_and_sign",
        ],
        [{ type: "payment", amountPaise: 1, paymentId }, "ledger_entries_reference_and_sign"],
        [{ type: "payment", amountPaise: -1, invoiceId }, "ledger_entries_reference_and_sign"],
        [
          { type: "debit_adjustment", amountPaise: -1, adjustmentId: uuidv7() },
          "ledger_entries_reference_and_sign",
        ],
        [
          { type: "credit_adjustment", amountPaise: 1, adjustmentId: uuidv7() },
          "ledger_entries_reference_and_sign",
        ],
        [
          { type: "payment_reversal", amountPaise: -1, paymentReversalId: uuidv7() },
          "ledger_entries_reference_and_sign",
        ],
        [{ type: "debit_adjustment", amountPaise: 1 }, "ledger_entries_one_reference"],
        [{ type: "invoice", invoiceId, paymentId }, "ledger_entries_one_reference"],
      ];
      for (const [values, constraint] of cases) {
        await expect(insert(values), JSON.stringify(values)).rejects.toSatisfy(
          violates(CHECK_VIOLATION, constraint),
        );
      }
    });

    it("posts each document at most once", async () => {
      await expect(insert({ type: "invoice", amountPaise: 50_000, invoiceId })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "ledger_entries_one_per_invoice"),
      );
      await expect(insert({ type: "payment", amountPaise: -10_000, paymentId })).rejects.toSatisfy(
        violates(UNIQUE_VIOLATION, "ledger_entries_one_per_payment"),
      );
    });

    it("references must be the customer's own documents", async () => {
      // An invoice of customer 0 that has no ledger entry yet.
      const unposted = uuidv7();
      await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.insert(invoices).values({
          id: unposted,
          operatorId: b.operatorId,
          customerId: customerOf(),
          period: "2026-09-01",
          invoiceNumber: "OLD-1",
          kind: "opening_balance",
          openingBalancePaise: 0,
          chargesPaise: 1,
          totalDuePaise: 1,
        }),
      );
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.insert(ledgerEntries).values({
            id: uuidv7(),
            operatorId: b.operatorId,
            customerId: b.customerIds[1],
            type: "opening_balance",
            amountPaise: 1,
            invoiceId: unposted,
          }),
        ),
      ).rejects.toSatisfy(violates(FK_VIOLATION, "ledger_entries_invoice_fk"));
    });

    it("seq gives the posting order; Σ amounts = the stored balance", async () => {
      const rows = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.customerId, customerOf()))
          .orderBy(asc(ledgerEntries.seq)),
      );
      expect(rows.map((r) => r.type)).toEqual(["invoice", "payment"]);
      expect(rows[0]?.seq).toBeLessThan(rows[1]?.seq ?? 0);
      const [balance] = await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.select().from(customerBalances).where(eq(customerBalances.customerId, customerOf())),
      );
      expect(balance?.balancePaise).toBe(rows.reduce((sum, r) => sum + r.amountPaise, 0));
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.execute(sql`insert into ledger_entries (id, operator_id, customer_id, seq, type,
            amount_paise, invoice_id) values (${uuidv7()}, ${b.operatorId}, ${customerOf()}, 1,
            'opening_balance', 0, ${invoiceId})`),
        ),
      ).rejects.toSatisfy(failsWith("428C9"));
    });

    it("is append-only for every role", async () => {
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx
            .update(ledgerEntries)
            .set({ amountPaise: 0 })
            .where(eq(ledgerEntries.customerId, customerOf())),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.delete(ledgerEntries).where(eq(ledgerEntries.customerId, customerOf())),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("DELETE FROM ledger_entries")).rejects.toSatisfy(
        isImmutableRowError,
      );
      await expect(t.current.admin.query("TRUNCATE ledger_entries")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("is tenant-scoped", async () => {
      const seenByA = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(ledgerEntries).where(eq(ledgerEntries.customerId, customerOf())),
      );
      expect(seenByA).toEqual([]);
    });
  });

  describe("customer_balances", () => {
    it("is updated in place, never deleted, and keeps its customer and tenant", async () => {
      const customerId = b.customerIds[1];
      await t.current.db.withTenant(b.operatorId, (tx) =>
        tx.insert(customerBalances).values({ customerId, operatorId: b.operatorId }),
      );
      await t.current.db.withTenant(b.operatorId, (tx) =>
        tx
          .update(customerBalances)
          .set({ balancePaise: 500, oldestDuePeriod: "2026-10-01" })
          .where(eq(customerBalances.customerId, customerId)),
      );
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx
            .update(customerBalances)
            .set({ creditPaise: -1 })
            .where(eq(customerBalances.customerId, customerId)),
        ),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "customer_balances_credit_not_negative"));
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx
            .update(customerBalances)
            .set({ oldestDuePeriod: "2026-10-02" })
            .where(eq(customerBalances.customerId, customerId)),
        ),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, "customer_balances_oldest_due_first_day"));
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.delete(customerBalances).where(eq(customerBalances.customerId, customerId)),
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(
        t.current.admin.query(
          "UPDATE customer_balances SET customer_id = $1 WHERE customer_id = $2",
          [b.customerIds[0], customerId],
        ),
      ).rejects.toSatisfy(isImmutableRowError);
      await expect(t.current.admin.query("TRUNCATE customer_balances")).rejects.toSatisfy(
        isImmutableRowError,
      );
    });

    it("is tenant-scoped and must point at the tenant's own customer", async () => {
      const seenByA = await t.current.db.withTenant(a.operatorId, (tx) =>
        tx.select().from(customerBalances).where(eq(customerBalances.customerId, b.customerIds[1])),
      );
      expect(seenByA).toEqual([]);
      const stranger = uuidv7();
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.insert(customerBalances).values({ customerId: stranger, operatorId: a.operatorId }),
        ),
      ).rejects.toSatisfy(failsWith(FK_VIOLATION));
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx
            .insert(customerBalances)
            .values({ customerId: b.customerIds[0], operatorId: b.operatorId }),
        ),
      ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    });
  });
});

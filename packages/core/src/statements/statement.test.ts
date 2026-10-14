/**
 * The customer statement and Bills tab services (T-049) against a real database, on books made by
 * the real services: billing runs (T-044, real job worker) for October, November and December,
 * counter and lineman payments (T-046) incl. one posted just after midnight IST and taken the day
 * before, an overpayment that becomes credit, an undone payment, a discount (credit bill change)
 * and an extra charge (debit bill change), and old dues brought in by a migration
 * (`opening_balance` bill).
 *
 * The statement must agree with the ledger exactly: closing as of now = `customer_balances` = Σ
 * ledger, every line's balance = Σ of the ledger up to it, consecutive months chain (closing of
 * October = opening of November), IST day boundaries decide the month, and T-041 `checkLedger`
 * finds nothing wrong with the books the statement reads.
 */
import {
  adjustments,
  areas,
  customerBalances,
  customers,
  invoices,
  ledgerEntries,
  type Tx,
  uuidv7,
} from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { startBillingRun } from "../billing/services";
import {
  addAdjustment,
  addConnection,
  drainBillingJobs,
  insertCustomer,
  readLedgerState,
} from "../billing/test-support";
import type { TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import { reversePayment } from "../payments/reverse-payment";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { customerBills } from "./bills";
import { customerStatement } from "./statement";
import type { CustomerStatementView } from "./types";

const SEP_20 = new Date("2026-09-20T06:00:00.000Z");
const SEP_25 = new Date("2026-09-25T06:00:00.000Z");
const OCT_1 = new Date("2026-10-01T03:00:00.000Z"); // 08:30 IST
const OCT_10 = new Date("2026-10-10T06:00:00.000Z");
const OCT_15 = new Date("2026-10-15T06:00:00.000Z");
const OCT_20 = new Date("2026-10-20T06:00:00.000Z");
/** 23:45 IST on 31 Oct. */
const OCT_31_LATE = new Date("2026-10-31T18:15:00.000Z");
/** 00:15 IST on 1 Nov (still 31 Oct in UTC). */
const NOV_1_EARLY = new Date("2026-10-31T18:45:00.000Z");
/** 22:30 IST on 31 Oct: when the lineman took the money. */
const OCT_31_FIELD = new Date("2026-10-31T17:00:00.000Z");
const NOV_1 = new Date("2026-11-01T03:00:00.000Z");
const NOV_5 = new Date("2026-11-05T06:00:00.000Z");
const NOV_6 = new Date("2026-11-06T06:00:00.000Z");
const DEC_1 = new Date("2026-12-01T03:00:00.000Z");
const DEC_2 = new Date("2026-12-02T06:00:00.000Z");

describeDb("customer statement services", () => {
  const t = useTestDatabase();
  const rt = (now: Date) => testRuntime(t.current.db, { now: () => now });

  interface World {
    tenant: SeededTenant;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
    asha: string;
    bina: string;
    empty: string;
    cashPaymentId: string;
    reversalReason: string;
  }

  async function bill(period: string, at: Date, owner: TenantContext) {
    const started = await startBillingRun.call(rt(at), owner, { period });
    if (!started.ok) throw new Error(`start ${period}: ${started.error.code}`);
    const report = await drainBillingJobs(t.current.db, () => at);
    expect(report.failed).toBe(0);
  }

  async function pay(
    at: Date,
    ctx: TenantContext,
    customerId: string,
    amountPaise: number,
    method: "cash" | "upi",
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = uuidv7();
    const posted = await postPayment.call(rt(at), ctx, {
      id,
      customerId,
      amountPaise,
      method,
      ...(method === "upi" ? { upiReference: "998877665544" } : {}),
      ...extra,
    });
    if (!posted.ok) throw new Error(`pay: ${posted.error.code}`);
    return id;
  }

  /** A discount (credit bill change) posted at `at`, as T-045 will: ledger −amount, credit +amount. */
  async function discount(
    op: string,
    customerId: string,
    amountPaise: number,
    at: Date,
    by: string,
  ) {
    await t.current.db.withTenant(op, async (tx: Tx) => {
      await tx
        .insert(customerBalances)
        .values({ customerId, operatorId: op })
        .onConflictDoNothing();
      await tx.execute(
        sql`SELECT 1 FROM customer_balances WHERE customer_id = ${customerId} FOR UPDATE`,
      );
      const id = uuidv7();
      await tx.insert(adjustments).values({
        id,
        operatorId: op,
        customerId,
        direction: "credit",
        amountPaise,
        source: "manual",
        reason: "Box was off for a week",
        createdBy: by,
        createdAt: at,
      });
      await tx.insert(ledgerEntries).values({
        id: uuidv7(),
        operatorId: op,
        customerId,
        type: "credit_adjustment",
        amountPaise: -amountPaise,
        adjustmentId: id,
        at,
      });
      await tx
        .update(customerBalances)
        .set({
          balancePaise: sql`${customerBalances.balancePaise} - ${amountPaise}`,
          creditPaise: sql`${customerBalances.creditPaise} + ${amountPaise}`,
        })
        .where(eq(customerBalances.customerId, customerId));
    });
  }

  /** Old dues brought in by the migration (T-092): an opening-balance bill and its ledger entry. */
  async function oldDues(op: string, customerId: string, amountPaise: number, at: Date) {
    await t.current.db.withTenant(op, async (tx: Tx) => {
      const id = uuidv7();
      await tx.insert(invoices).values({
        id,
        operatorId: op,
        customerId,
        period: "2026-09-01",
        invoiceNumber: `OLD-${id.slice(-5)}`,
        kind: "opening_balance",
        openingBalancePaise: 0,
        chargesPaise: amountPaise,
        totalDuePaise: amountPaise,
        issuedAt: at,
      });
      await tx.insert(ledgerEntries).values({
        id: uuidv7(),
        operatorId: op,
        customerId,
        type: "opening_balance",
        amountPaise,
        invoiceId: id,
        at,
      });
      await tx.insert(customerBalances).values({
        customerId,
        operatorId: op,
        balancePaise: amountPaise,
        oldestDuePeriod: "2026-09-01",
        updatedAt: at,
      });
    });
  }

  async function world(): Promise<World> {
    const tenant = await seedTenant(t.current);
    const op = tenant.operatorId;
    await t.current.admin.query("UPDATE operators SET created_at = $2 WHERE id = $1", [
      op,
      "2026-09-15T06:00:00Z",
    ]);
    const base = rt(OCT_1);
    const owner = await contextFor(base, tenant, "owner");
    const staff = await contextFor(base, tenant, "staff");
    const lineman = await contextFor(base, tenant, "lineman");
    const ids = await t.current.db.withTenant(op, async (tx: Tx) => {
      const areaId = uuidv7();
      await tx.insert(areas).values({ id: areaId, operatorId: op, name: "North" });
      const asha = await insertCustomer(tx, op);
      await tx
        .update(customers)
        .set({ customerCode: "A-1", name: "Asha Devi", areaId, phone: "9876543210" })
        .where(eq(customers.id, asha));
      await addConnection(tx, op, asha, { startDate: "2026-10-01", rentalPaise: 30_000 });
      await addConnection(tx, op, asha, { startDate: "2026-10-01", rentalPaise: 20_000 });
      const bina = await insertCustomer(tx, op);
      await tx
        .update(customers)
        .set({ customerCode: "B-2", name: "Bina Rao" })
        .where(eq(customers.id, bina));
      await addConnection(tx, op, bina, { startDate: "2026-10-01", rentalPaise: 25_000 });
      const empty = await insertCustomer(tx, op);
      return { asha, bina, empty };
    });

    // September: Bina's old dues (migration); a ₹50 discount for Asha.
    await oldDues(op, ids.bina, 15_000, SEP_20);
    await discount(op, ids.asha, 5_000, SEP_25, tenant.users.owner);

    // October bills (the discount pays ₹50 of Asha's), payments.
    await bill("2026-10-01", OCT_1, owner);
    const cashPaymentId = await pay(OCT_10, owner, ids.asha, 30_000, "cash");
    await t.current.db.withTenant(op, (tx: Tx) =>
      addAdjustment(tx, op, {
        customerId: ids.asha,
        direction: "debit",
        amountPaise: 2_500,
        source: "manual",
        createdBy: tenant.users.owner,
        reason: "Repair visit",
        at: OCT_15,
      }),
    );
    await pay(OCT_20, staff, ids.bina, 60_000, "cash"); // old dues + October + ₹200 credit
    await pay(OCT_31_LATE, staff, ids.asha, 10_000, "upi");
    // The lineman took ₹50 at 22:30 IST on 31 Oct; the phone sent it at 00:15 IST on 1 Nov.
    await pay(NOV_1_EARLY, lineman, ids.asha, 5_000, "cash", {
      recordedAt: OCT_31_FIELD.toISOString(),
      provisionalRef: "P-ABC-0001",
    });

    // November bills (+ the ₹25 repair), an overpayment, then the Owner undoes the 10 Oct payment.
    await bill("2026-11-01", NOV_1, owner);
    await pay(NOV_5, owner, ids.asha, 100_000, "cash");
    const reversalReason = "Counted twice";
    const undone = await reversePayment.call(rt(NOV_6), owner, {
      paymentId: cashPaymentId,
      reason: reversalReason,
    });
    if (!undone.ok) throw new Error(`reverse: ${undone.error.code}`);
    return { tenant, owner, staff, lineman, ...ids, cashPaymentId, reversalReason };
  }

  async function statementOf(
    ctx: TenantContext,
    customerId: string,
    range: { from?: string; to?: string } = {},
    now = DEC_2,
  ): Promise<CustomerStatementView> {
    const result = await customerStatement.call(rt(now), ctx, { customerId, ...range });
    if (!result.ok) throw new Error(`statement: ${result.error.code}`);
    return result.value;
  }

  /** Σ ledger entries of the customer with seq ≤ each seq (the ledger's own running balance). */
  async function ledgerRunning(op: string, customerId: string): Promise<Map<number, number>> {
    const rows = await t.current.db.withTenant(op, (tx: Tx) =>
      tx
        .select({ seq: ledgerEntries.seq, amount: ledgerEntries.amountPaise })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.operatorId, op), eq(ledgerEntries.customerId, customerId)))
        .orderBy(asc(ledgerEntries.seq)),
    );
    const sums = new Map<number, number>();
    let sum = 0;
    for (const row of rows) {
      sum += row.amount;
      sums.set(row.seq, sum);
    }
    return sums;
  }

  async function booksAreRight(op: string, customerId: string) {
    const state = await t.current.db.withTenant(op, (tx: Tx) => readLedgerState(tx, customerId));
    expect(checkLedger(state)).toEqual([]);
    return state;
  }

  it("agrees with the ledger and customer_balances on realistic books", async () => {
    const w = await world();
    const op = w.tenant.operatorId;

    // --- Before December: dues and credit side by side after the undo (T-041 Q-B). ---
    const midNov = await statementOf(w.owner, w.asha, {}, NOV_6);
    expect(midNov.closingBalancePaise).toBe(-17_500);
    expect(midNov.now).toEqual({
      balancePaise: -17_500,
      creditPaise: 47_500,
      oldestDuePeriod: "2026-10-01",
      ledgerPaise: -17_500,
    });
    const billsNov = await customerBills.call(rt(NOV_6), w.staff, { customerId: w.asha });
    if (!billsNov.ok) throw new Error(billsNov.error.code);
    expect(
      billsNov.value.rows.map((row) => [row.period, row.payState, row.outstandingPaise]),
    ).toEqual([
      ["2026-11-01", "paid", 0],
      ["2026-10-01", "part_paid", 30_000],
    ]);
    // Σ still due on the bills − unused credit = the balance.
    expect(billsNov.value.totals.outstandingPaise - billsNov.value.creditPaise).toBe(
      billsNov.value.balancePaise,
    );
    expect(billsNov.value.pendingChargesPaise).toBe(0);

    // --- December bills: the credit pays October's reopened due, then December. ---
    await bill("2026-12-01", DEC_1, w.owner);
    await booksAreRight(op, w.asha);
    await booksAreRight(op, w.bina);

    const all = await statementOf(w.owner, w.asha);
    expect(all.range).toEqual({ from: null, to: "2026-12-02", today: "2026-12-02", asOfNow: true });
    expect(all.openingBalancePaise).toBe(0);
    expect(all.hiddenLines).toBe(0);
    expect(all.closingBalancePaise).toBe(32_500);
    expect(all.now.balancePaise).toBe(all.closingBalancePaise);
    expect(all.now.ledgerPaise).toBe(all.closingBalancePaise);
    expect(all.now.creditPaise).toBe(0);
    expect(all.customer).toMatchObject({
      id: w.asha,
      code: "A-1",
      name: "Asha Devi",
      areaName: "North",
    });
    expect(all.operator.language).toBe("hi");

    // Every line's balance is the ledger's own running sum at that line.
    const running = await ledgerRunning(op, w.asha);
    for (const line of all.lines) expect(line.balanceAfterPaise).toBe(running.get(line.seq));
    expect(
      all.lines.map((line) => [line.date, line.type, line.amountPaise, line.balanceAfterPaise]),
    ).toEqual([
      ["2026-09-25", "credit_adjustment", -5_000, -5_000],
      ["2026-10-01", "invoice", 50_000, 45_000],
      ["2026-10-10", "payment", -30_000, 15_000],
      ["2026-10-31", "payment", -10_000, 5_000],
      ["2026-11-01", "payment", -5_000, 0],
      ["2026-11-01", "invoice", 52_500, 52_500],
      ["2026-11-05", "payment", -100_000, -47_500],
      ["2026-11-06", "payment_reversal", 30_000, -17_500],
      ["2026-12-01", "invoice", 50_000, 32_500],
    ]);
    expect(all.totals).toEqual({
      billedPaise: 152_500,
      paidPaise: 145_000,
      undonePaise: 30_000,
      discountPaise: 5_000,
    });

    // What each line names.
    const [discountLine, octBill, cashLine, upiLine, fieldLine, novBill, , undoLine] = all.lines;
    expect(discountLine?.adjustment).toMatchObject({
      direction: "credit",
      source: "manual",
      reason: "Box was off for a week",
    });
    expect(octBill?.bill).toMatchObject({
      period: "2026-10-01",
      kind: "regular",
      status: "issued",
    });
    expect(octBill?.bill?.invoiceNumber).toMatch(/^INV-2610-\d{5}$/);
    expect(cashLine?.payment).toMatchObject({
      id: w.cashPaymentId,
      method: "cash",
      source: "web",
      amountPaise: 30_000,
      businessDate: "2026-10-10",
      reversed: true,
    });
    expect(cashLine?.payment?.receiptNumber).toMatch(/^R-2610-\d{5}$/);
    expect(cashLine?.payment?.collectorName).toEqual(expect.any(String));
    expect(upiLine?.payment).toMatchObject({
      method: "upi",
      reversed: false,
      businessDate: "2026-10-31",
    });
    // Posted on 1 Nov (IST), taken on 31 Oct.
    expect(fieldLine?.payment).toMatchObject({ source: "android", businessDate: "2026-10-31" });
    expect(novBill?.bill?.period).toBe("2026-11-01");
    expect(undoLine?.reversal).toMatchObject({ reason: w.reversalReason });
    expect(undoLine?.payment).toMatchObject({
      id: w.cashPaymentId,
      amountPaise: 30_000,
      reversed: true,
    });

    // --- Months chain, and IST decides the month. ---
    const oct = await statementOf(w.staff, w.asha, { from: "2026-10-01", to: "2026-10-31" });
    expect(oct.range.asOfNow).toBe(false);
    expect(oct.openingBalancePaise).toBe(-5_000);
    expect(oct.lines.map((line) => line.amountPaise)).toEqual([50_000, -30_000, -10_000]);
    expect(oct.closingBalancePaise).toBe(5_000);
    expect(oct.totals).toEqual({
      billedPaise: 50_000,
      paidPaise: 40_000,
      undonePaise: 0,
      discountPaise: 0,
    });
    const nov = await statementOf(w.staff, w.asha, { from: "2026-11-01", to: "2026-11-30" });
    expect(nov.openingBalancePaise).toBe(oct.closingBalancePaise);
    expect(nov.lines.map((line) => line.type)).toEqual([
      "payment",
      "invoice",
      "payment",
      "payment_reversal",
    ]);
    expect(nov.closingBalancePaise).toBe(-17_500);
    const dec = await statementOf(w.staff, w.asha, { from: "2026-12-01" });
    expect(dec.openingBalancePaise).toBe(nov.closingBalancePaise);
    expect(dec.closingBalancePaise).toBe(all.now.balancePaise);
    expect(dec.range.asOfNow).toBe(true);
    // 1 Nov alone: the 00:15 IST payment and the 08:30 IST bill.
    const firstNov = await statementOf(w.owner, w.asha, { from: "2026-11-01", to: "2026-11-01" });
    expect(firstNov.lines.map((line) => line.at.toISOString())).toEqual([
      NOV_1_EARLY.toISOString(),
      NOV_1.toISOString(),
    ]);
    // 31 Oct alone: only the 23:45 IST UPI payment.
    const lastOct = await statementOf(w.owner, w.asha, { from: "2026-10-31", to: "2026-10-31" });
    expect(lastOct.lines.map((line) => line.at.toISOString())).toEqual([OCT_31_LATE.toISOString()]);
    expect(lastOct.closingBalancePaise).toBe(oct.closingBalancePaise);
    // A range ending in the future is "as of now".
    const future = await statementOf(w.owner, w.asha, { from: "2026-12-01", to: "2027-03-31" });
    expect(future.range).toMatchObject({ to: "2026-12-02", asOfNow: true });
    expect(future.closingBalancePaise).toBe(32_500);

    // --- Bills tab after December. ---
    const bills = await customerBills.call(rt(DEC_2), w.owner, { customerId: w.asha });
    if (!bills.ok) throw new Error(bills.error.code);
    expect(
      bills.value.rows.map((row) => [row.period, row.chargesPaise, row.paidPaise, row.payState]),
    ).toEqual([
      ["2026-12-01", 50_000, 17_500, "part_paid"],
      ["2026-11-01", 52_500, 52_500, "paid"],
      ["2026-10-01", 50_000, 50_000, "paid"],
    ]);
    expect(bills.value.totals).toEqual({
      count: 3,
      chargesPaise: 152_500,
      paidPaise: 120_000,
      outstandingPaise: 32_500,
    });
    expect(bills.value.totals.outstandingPaise - bills.value.creditPaise).toBe(
      bills.value.balancePaise,
    );
    expect(bills.value.balancePaise).toBe(all.closingBalancePaise);

    // --- Bina: old dues, overpayment, credit used by the next bills. ---
    const bina = await statementOf(w.owner, w.bina);
    expect(bina.lines.map((line) => [line.type, line.amountPaise, line.balanceAfterPaise])).toEqual(
      [
        ["opening_balance", 15_000, 15_000],
        ["invoice", 25_000, 40_000],
        ["payment", -60_000, -20_000],
        ["invoice", 25_000, 5_000],
        ["invoice", 25_000, 30_000],
      ],
    );
    expect(bina.lines[0]?.bill).toMatchObject({ kind: "opening_balance", period: "2026-09-01" });
    expect(bina.closingBalancePaise).toBe(bina.now.balancePaise);
    expect(bina.now.ledgerPaise).toBe(30_000);
    expect(bina.totals.billedPaise).toBe(90_000);
    const binaBills = await customerBills.call(rt(DEC_2), w.owner, { customerId: w.bina });
    if (!binaBills.ok) throw new Error(binaBills.error.code);
    expect(
      binaBills.value.rows.map((row) => [row.kind, row.payState, row.outstandingPaise]),
    ).toEqual([
      ["regular", "unpaid", 25_000],
      ["regular", "part_paid", 5_000],
      ["regular", "paid", 0],
      ["opening_balance", "paid", 0],
    ]);
    expect(binaBills.value.totals.outstandingPaise - binaBills.value.creditPaise).toBe(30_000);

    // --- A customer with nothing yet. ---
    const nothing = await statementOf(w.owner, w.empty);
    expect(nothing).toMatchObject({ lines: [], openingBalancePaise: 0, closingBalancePaise: 0 });
    expect(nothing.now).toEqual({
      balancePaise: 0,
      creditPaise: 0,
      oldestDuePeriod: null,
      ledgerPaise: 0,
    });
    const noBills = await customerBills.call(rt(DEC_2), w.owner, { customerId: w.empty });
    expect(noBills.ok && noBills.value.rows).toEqual([]);
  }, 120_000);

  it("shows a debit bill change waiting for the next bill", async () => {
    const tenant = await seedTenant(t.current);
    const op = tenant.operatorId;
    const owner = await contextFor(rt(OCT_1), tenant, "owner");
    const customerId = await t.current.db.withTenant(op, async (tx: Tx) => {
      const id = await insertCustomer(tx, op);
      await addAdjustment(tx, op, {
        customerId: id,
        direction: "debit",
        amountPaise: 4_000,
        source: "manual",
        createdBy: tenant.users.owner,
      });
      return id;
    });
    const bills = await customerBills.call(rt(OCT_1), owner, { customerId });
    expect(bills.ok && bills.value).toMatchObject({ rows: [], pendingChargesPaise: 4_000 });
    // Not on the statement yet: a debit bill change reaches the ledger through the next bill.
    const statement = await customerStatement.call(rt(OCT_1), owner, { customerId });
    expect(statement.ok && statement.value.lines).toEqual([]);
  }, 60_000);

  describe("who may read it, and bad input", () => {
    it("Owner and Staff only; unknown ids, bad dates and backwards ranges are refused", async () => {
      const tenant = await seedTenant(t.current);
      const op = tenant.operatorId;
      const now = rt(OCT_1);
      const owner = await contextFor(now, tenant, "owner");
      const lineman = await contextFor(now, tenant, "lineman");
      const customerId = await t.current.db.withTenant(op, (tx: Tx) => insertCustomer(tx, op));

      const asLineman = await customerStatement.call(now, lineman, { customerId });
      expect(asLineman.ok ? "ok" : asLineman.error.code).toBe("FORBIDDEN");
      const billsAsLineman = await customerBills.call(now, lineman, { customerId });
      expect(billsAsLineman.ok ? "ok" : billsAsLineman.error.code).toBe("FORBIDDEN");

      const unknown = await customerStatement.call(now, owner, { customerId: uuidv7() });
      expect(unknown.ok ? "ok" : unknown.error.code).toBe("NOT_FOUND");
      const unknownBills = await customerBills.call(now, owner, { customerId: uuidv7() });
      expect(unknownBills.ok ? "ok" : unknownBills.error.code).toBe("NOT_FOUND");

      for (const bad of [
        { from: "2026-10-32" },
        { to: "31-10-2026" },
        { from: "2026-10-05", to: "2026-10-04" },
      ]) {
        const result = await customerStatement.call(now, owner, { customerId, ...bad });
        expect(result.ok ? "ok" : result.error.code).toBe("VALIDATION");
      }
      // A start after today (with no end) is a backwards range too.
      const tomorrow = await customerStatement.call(now, owner, { customerId, from: "2026-10-02" });
      expect(tomorrow.ok ? "ok" : tomorrow.error.code).toBe("VALIDATION");
    }, 60_000);
  });
});

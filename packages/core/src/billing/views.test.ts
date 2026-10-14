/**
 * The Bills read services (T-047) against a real database: a November run made through the real
 * services and job worker, payments posted and undone through T-046's services, then the
 * calendar, the run's problems, the register (filters, pages, totals) and one bill (lines per VC,
 * bill changes, payments, balance) are read back as Owner and Staff.
 */
import { areas, customers, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import { reversePayment } from "../payments/reverse-payment";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { startBillingRun } from "./services";
import { addAdjustment, addConnection, drainBillingJobs, insertCustomer } from "./test-support";
import {
  billingCustomerLabels,
  billingMonths,
  billingRunProblems,
  billPayState,
  getBill,
  listBills,
} from "./views";

const OCT = "2026-10-01";
const NOV = "2026-11-01";
const DEC = "2026-12-01";
const NOV_1 = new Date("2026-11-01T03:00:00.000Z");
const NOV_5 = new Date("2026-11-05T06:00:00.000Z");

describe("billPayState", () => {
  it("names how much of a bill is paid", () => {
    expect(billPayState("void", 100, 0)).toBe("void");
    expect(billPayState("issued", 0, 0)).toBe("no_charge");
    expect(billPayState("issued", 100, 0)).toBe("unpaid");
    expect(billPayState("issued", 100, 40)).toBe("part_paid");
    expect(billPayState("issued", 100, 100)).toBe("paid");
  });
});

describeDb("bills read services", () => {
  const t = useTestDatabase();

  interface World {
    tenant: SeededTenant;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
    areaId: string;
    asha: string;
    bina: string;
    drifted: string;
    vc1: string;
    vc2: string;
    runId: string;
  }

  const rt = (now: Date) => testRuntime(t.current.db, { now: () => now });

  async function world(): Promise<World> {
    const tenant = await seedTenant(t.current);
    const op = tenant.operatorId;
    // The tenant started in September (so November is runnable whatever the real date).
    await t.current.admin.query("UPDATE operators SET created_at = $2 WHERE id = $1", [
      op,
      "2026-09-15T06:00:00Z",
    ]);
    const runtime = rt(NOV_1);
    const owner = await contextFor(runtime, tenant, "owner");
    const staff = await contextFor(runtime, tenant, "staff");
    const lineman = await contextFor(runtime, tenant, "lineman");
    const ids = await t.current.db.withTenant(op, async (tx: Tx) => {
      const areaId = uuidv7();
      await tx.insert(areas).values({ id: areaId, operatorId: op, name: "North" });
      const asha = await insertCustomer(tx, op);
      await tx
        .update(customers)
        .set({
          customerCode: "A-1",
          name: "Asha Devi",
          areaId,
          phone: "9876543210",
          address: "Gali 4",
        })
        .where(eq(customers.id, asha));
      const vc1 = await addConnection(tx, op, asha, { startDate: OCT, rentalPaise: 30_000 });
      const vc2 = await addConnection(tx, op, asha, { startDate: OCT, rentalPaise: 20_000 });
      await addAdjustment(tx, op, {
        customerId: asha,
        direction: "debit",
        amountPaise: 5_000,
        source: "plan_change",
        assignmentId: vc1,
        period: NOV,
      });
      await addAdjustment(tx, op, {
        customerId: asha,
        direction: "debit",
        amountPaise: 2_500,
        source: "manual",
        createdBy: tenant.users.owner,
        reason: "Repair visit",
      });
      const bina = await insertCustomer(tx, op);
      await tx
        .update(customers)
        .set({ customerCode: "B-2", name: "Bina Rao" })
        .where(eq(customers.id, bina));
      await addConnection(tx, op, bina, { startDate: OCT, rentalPaise: 25_000 });
      const drifted = await insertCustomer(tx, op);
      await tx
        .update(customers)
        .set({ customerCode: "C-3", name: "Chandu" })
        .where(eq(customers.id, drifted));
      await addConnection(tx, op, drifted, { startDate: OCT, rentalPaise: 10_000 });
      return { areaId, asha, bina, drifted, vc1, vc2 };
    });
    await t.current.admin.query(
      "INSERT INTO customer_balances (customer_id, operator_id, balance_paise) VALUES ($1, $2, 123)",
      [ids.drifted, op],
    );
    const started = await startBillingRun.call(runtime, owner, { period: NOV });
    if (!started.ok) throw new Error(`start: ${started.error.code}`);
    const report = await drainBillingJobs(t.current.db, () => NOV_1);
    expect(report.failed).toBe(0);

    // Asha pays ₹400 cash, then ₹100 UPI that the Owner undoes.
    const later = rt(NOV_5);
    const cash = await postPayment.call(later, owner, {
      id: uuidv7(),
      customerId: ids.asha,
      amountPaise: 40_000,
      method: "cash",
    });
    if (!cash.ok) throw new Error(`cash: ${cash.error.code}`);
    const upiId = uuidv7();
    const upi = await postPayment.call(later, owner, {
      id: upiId,
      customerId: ids.asha,
      amountPaise: 10_000,
      method: "upi",
      upiReference: "123456789012",
    });
    if (!upi.ok) throw new Error(`upi: ${upi.error.code}`);
    const undone = await reversePayment.call(later, owner, {
      paymentId: upiId,
      reason: "Wrong customer",
    });
    if (!undone.ok) throw new Error(`reverse: ${undone.error.code}`);
    return { tenant, owner, staff, lineman, ...ids, runId: started.value.run.id };
  }

  it("reads the calendar, problems, register and one bill", async () => {
    const w = await world();
    const now = rt(NOV_5);

    // Calendar.
    const months = await billingMonths.call(now, w.staff, { from: OCT, to: DEC });
    if (!months.ok) throw new Error(months.error.code);
    expect(months.value.currentPeriod).toBe(NOV);
    expect(months.value.firstPeriod).toBe("2026-09-01");
    expect(months.value.tenantMode).toBe("normal");
    expect(months.value.months.map((m) => m.period)).toEqual([OCT, NOV, DEC]);
    const [oct, nov] = months.value.months;
    expect(oct).toMatchObject({ run: null, billCount: 0, billTotalPaise: 0 });
    expect(nov?.run).toMatchObject({
      id: w.runId,
      status: "completed_with_errors",
      createdCount: 2,
      failedCount: 1,
    });
    expect(nov).toMatchObject({
      billCount: 2,
      billTotalPaise: 30_000 + 20_000 + 5_000 + 2_500 + 25_000,
    });
    const tooMany = await billingMonths.call(now, w.owner, { from: "2024-12-01", to: DEC });
    expect(tooMany.ok ? "ok" : tooMany.error.code).toBe("VALIDATION");
    const backwards = await billingMonths.call(now, w.owner, { from: DEC, to: OCT });
    expect(backwards.ok ? "ok" : backwards.error.code).toBe("VALIDATION");

    // Problems of the run, with names.
    const problems = await billingRunProblems.call(now, w.staff, { runId: w.runId });
    if (!problems.ok) throw new Error(problems.error.code);
    expect(problems.value.failedCount).toBe(1);
    expect(problems.value.problems).toEqual([
      expect.objectContaining({
        customer: { id: w.drifted, code: "C-3", name: "Chandu", areaName: null },
        reason: "balance_mismatch",
        attempts: 1,
      }),
    ]);
    const unknownRun = await billingRunProblems.call(now, w.owner, { runId: uuidv7() });
    expect(unknownRun.ok ? "ok" : unknownRun.error.code).toBe("NOT_FOUND");

    // Labels for preview problems.
    const labels = await billingCustomerLabels.call(now, w.owner, {
      customerIds: [w.bina, w.asha, w.asha],
    });
    expect(labels.ok && labels.value).toEqual([
      { id: w.asha, code: "A-1", name: "Asha Devi", areaName: "North" },
      { id: w.bina, code: "B-2", name: "Bina Rao", areaName: null },
    ]);
    const unknownLabel = await billingCustomerLabels.call(now, w.owner, {
      customerIds: [w.asha, uuidv7()],
    });
    expect(unknownLabel.ok ? "ok" : unknownLabel.error.code).toBe("NOT_FOUND");

    // Register.
    const all = await listBills.call(now, w.staff, { period: NOV });
    if (!all.ok) throw new Error(all.error.code);
    const ashaCharges = 30_000 + 20_000 + 5_000 + 2_500;
    expect(all.value.areas).toEqual([{ id: w.areaId, name: "North" }]);
    expect(
      all.value.rows.map((r) => [r.customer.code, r.chargesPaise, r.paidPaise, r.payState]),
    ).toEqual([
      ["A-1", ashaCharges, 40_000, "part_paid"],
      ["B-2", 25_000, 0, "unpaid"],
    ]);
    expect(all.value.rows[0]?.invoiceNumber).toMatch(/^INV-2611-\d{5}$/);
    expect(all.value.rows[0]?.outstandingPaise).toBe(ashaCharges - 40_000);
    expect(all.value.totals).toEqual({
      count: 2,
      chargesPaise: ashaCharges + 25_000,
      paidPaise: 40_000,
      outstandingPaise: ashaCharges + 25_000 - 40_000,
    });
    const north = await listBills.call(now, w.owner, { period: NOV, areaId: w.areaId });
    expect(north.ok && north.value.rows.map((r) => r.customer.code)).toEqual(["A-1"]);
    const unpaid = await listBills.call(now, w.owner, { period: NOV, payState: "unpaid" });
    expect(unpaid.ok && unpaid.value.rows.map((r) => r.customer.code)).toEqual(["B-2"]);
    expect(unpaid.ok && unpaid.value.totals.count).toBe(1);
    const page2 = await listBills.call(now, w.owner, { period: NOV, page: 2 });
    expect(page2.ok && page2.value.rows).toEqual([]);
    expect(page2.ok && page2.value.totals.count).toBe(2);
    const octBills = await listBills.call(now, w.owner, { period: OCT });
    expect(octBills.ok && octBills.value.totals.count).toBe(0);
    const otherArea = await listBills.call(now, w.owner, { period: NOV, areaId: uuidv7() });
    expect(otherArea.ok ? "ok" : otherArea.error.code).toBe("NOT_FOUND");

    // One bill.
    const ashaBill = all.value.rows[0];
    const detail = await getBill.call(now, w.staff, { invoiceId: String(ashaBill?.id) });
    if (!detail.ok) throw new Error(detail.error.code);
    const d = detail.value;
    expect(d.bill).toMatchObject({
      period: NOV,
      kind: "regular",
      status: "issued",
      openingBalancePaise: 0,
      chargesPaise: ashaCharges,
      totalDuePaise: ashaCharges,
      paidPaise: 40_000,
      outstandingPaise: ashaCharges - 40_000,
      payState: "part_paid",
    });
    expect(d.customer).toMatchObject({
      code: "A-1",
      name: "Asha Devi",
      areaName: "North",
      phone: "9876543210",
      address: "Gali 4",
    });
    expect(d.operator).toMatchObject({ language: "hi", footer: null });
    expect(d.connections.map((c) => [c.assignmentId, c.totalPaise])).toEqual([
      [w.vc1, 35_000],
      [w.vc2, 20_000],
    ]);
    expect(d.connections[0]?.vcNumber).toMatch(/^VC/);
    expect(
      d.connections[0]?.lines.map((l) => [l.type, l.amountPaise, l.adjustment?.source ?? null]),
    ).toEqual([
      ["rent", 30_000, null],
      ["adjustment", 5_000, "plan_change"],
    ]);
    expect(d.otherLines).toEqual([
      expect.objectContaining({
        type: "adjustment",
        amountPaise: 2_500,
        adjustment: expect.objectContaining({ source: "manual", reason: "Repair visit" }),
      }),
    ]);
    expect(
      d.payments.map((p) => [
        p.sourceType,
        p.payment?.method,
        p.amountPaise,
        p.undonePaise,
        p.payment?.reversed,
      ]),
    ).toEqual([
      ["payment", "cash", 40_000, 0, false],
      ["payment", "upi", 10_000, 10_000, true],
    ]);
    expect(d.payments[0]?.payment?.receiptNumber).toMatch(/^R-2611-\d{5}$/);
    expect(d.balance).toEqual({ balancePaise: ashaCharges - 40_000, creditPaise: 0 });

    const unknownBill = await getBill.call(now, w.owner, { invoiceId: uuidv7() });
    expect(unknownBill.ok ? "ok" : unknownBill.error.code).toBe("NOT_FOUND");

    // Linemen don't read the Bills pages.
    const forbidden = await listBills.call(now, w.lineman, { period: NOV });
    expect(forbidden.ok ? "ok" : forbidden.error.code).toBe("FORBIDDEN");
  }, 60_000);
});

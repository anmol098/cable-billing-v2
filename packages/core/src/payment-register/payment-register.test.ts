/**
 * The office payment pages' services against a real database (T-048): the register (filters,
 * totals without cancelled payments, paging, order), one payment's details before and after the
 * Owner undoes it, the printable receipt, marking a flagged payment as checked (the only change
 * the append-only trigger allows), and the counter form's double submit (same id → one payment).
 */
import { auditEvents, customers, payments, receipts, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import { reversePayment } from "../payments/reverse-payment";
import { insertCustomer, issueInvoice, readLedgerState } from "../payments/test-support";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import { getPayment, getPaymentReceipt, listPayments } from "./queries";
import { resolvePaymentReview } from "./review";

/** 13 Oct 2026, 11:30 IST. */
const NOW = new Date("2026-10-13T06:00:00.000Z");
const TODAY = "2026-10-13";
const YESTERDAY = "2026-10-12";

describeDb("office payment pages (T-048)", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(now: Date = NOW): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db, { now: () => now });
    return {
      tenant,
      rt,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
      lineman: await contextFor(rt, tenant, "lineman"),
    };
  }

  const tenantTx = <T>(s: Setup, fn: (tx: Tx) => Promise<T>) =>
    t.current.db.withTenant(s.tenant.operatorId, fn);

  async function customer(
    s: Setup,
    options: { bills?: [string, number][]; status?: "active" | "inactive"; name?: string } = {},
  ) {
    return tenantTx(s, async (tx) => {
      const id = await insertCustomer(
        tx,
        s.tenant.operatorId,
        options.status ? { status: options.status } : {},
      );
      if (options.name)
        await tx.update(customers).set({ name: options.name }).where(eq(customers.id, id));
      for (const [period, chargesPaise] of options.bills ?? []) {
        await issueInvoice(tx, s.tenant.operatorId, id, { period, chargesPaise });
      }
      return id;
    });
  }

  /** A counter payment (web) by `ctx`. */
  async function counter(
    s: Setup,
    ctx: TenantContext,
    customerId: string,
    amountPaise: number,
    method: "cash" | "upi" = "cash",
  ) {
    const r = await postPayment.call(s.rt, ctx, {
      id: uuidv7(),
      customerId,
      amountPaise,
      method,
      ...(method === "upi" ? { upiReference: "412345678901" } : {}),
    });
    if (!r.ok) throw new Error(`post: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  /** A lineman's field payment recorded at `recordedAt`. */
  async function field(s: Setup, customerId: string, amountPaise: number, recordedAt: Date) {
    const r = await postPayment.call(s.rt, s.lineman, {
      id: uuidv7(),
      customerId,
      amountPaise,
      method: "cash",
      recordedAt: recordedAt.toISOString(),
      provisionalRef: "P-K7Q-0042",
      claimedCollectorId: s.tenant.users.lineman,
      claimedDeviceId: s.tenant.deviceId,
    });
    if (!r.ok) throw new Error(`field post: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  async function list(s: Setup, input: Parameters<typeof listPayments.call>[2] = {}) {
    const r = await listPayments.call(s.rt, s.staff, input);
    if (!r.ok) throw new Error(`list: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  it("lists payments newest first with totals that leave cancelled payments out", async () => {
    const s = await setup();
    const asha = await customer(s, { name: "Asha Devi", bills: [["2026-10-01", 40_000]] });
    const ravi = await customer(s, { name: "Ravi Kumar" });
    const first = await counter(s, s.staff, asha, 40_000, "cash");
    const second = await counter(s, s.owner, ravi, 25_000, "upi");
    const third = await counter(s, s.staff, ravi, 10_000, "cash");
    const undo = await reversePayment.call(s.rt, s.owner, {
      paymentId: third.payment.id,
      reason: "wrong_amount",
    });
    expect(undo.ok).toBe(true);

    const all = await list(s, { from: TODAY, to: TODAY });
    expect(all.rows.map((r) => r.id)).toEqual([
      third.payment.id,
      second.payment.id,
      first.payment.id,
    ]);
    expect(all.totals).toEqual({
      count: 3,
      cashPaise: 40_000,
      upiPaise: 25_000,
      cancelledCount: 1,
      toCheckCount: 0,
    });
    expect(all.hasMore).toBe(false);
    const row = all.rows.find((r) => r.id === first.payment.id);
    expect(row).toMatchObject({
      customerId: asha,
      customerName: "Asha Devi",
      amountPaise: 40_000,
      method: "cash",
      source: "web",
      collectorId: s.tenant.users.staff,
      businessDate: TODAY,
      receiptNumber: first.receipt.receiptNumber,
      provisionalRef: null,
      reviewStatus: "none",
      cancelled: false,
    });
    expect(row?.collectorName).toBeTruthy();
    expect(all.rows[0]?.cancelled).toBe(true);
    // Every user of the business is offered as "Taken by".
    expect(all.collectors.map((c) => c.id).sort()).toEqual(Object.values(s.tenant.users).sort());

    expect((await list(s, { status: "counted" })).rows.map((r) => r.id)).toEqual([
      second.payment.id,
      first.payment.id,
    ]);
    expect((await list(s, { status: "cancelled" })).rows.map((r) => r.id)).toEqual([
      third.payment.id,
    ]);
    expect((await list(s, { method: "upi" })).rows.map((r) => r.id)).toEqual([second.payment.id]);
    expect((await list(s, { collectorId: s.tenant.users.owner })).rows.map((r) => r.id)).toEqual([
      second.payment.id,
    ]);
    expect((await list(s, { customerId: ravi })).rows.map((r) => r.id)).toEqual([
      third.payment.id,
      second.payment.id,
    ]);
    expect(
      (await list(s, { receiptNumber: first.receipt.receiptNumber.toLowerCase() })).rows.map(
        (r) => r.id,
      ),
    ).toEqual([first.payment.id]);
    expect((await list(s, { from: YESTERDAY, to: YESTERDAY })).rows).toEqual([]);
  }, 60_000);

  it("filters by IST business date, finds a phone's temporary number, and pages", async () => {
    const s = await setup();
    const asha = await customer(s);
    // 12 Oct 2026, 23:50 IST = 18:20 UTC: yesterday's business date.
    const late = await field(s, asha, 30_000, new Date("2026-10-12T18:20:00.000Z"));
    const today = await counter(s, s.staff, asha, 20_000);

    expect((await list(s, { from: YESTERDAY, to: YESTERDAY })).rows.map((r) => r.id)).toEqual([
      late.payment.id,
    ]);
    expect((await list(s, { from: TODAY })).rows.map((r) => r.id)).toEqual([today.payment.id]);
    expect((await list(s, { to: YESTERDAY })).totals.cashPaise).toBe(30_000);
    expect((await list(s, { receiptNumber: "p-k7q-0042" })).rows.map((r) => r.id)).toEqual([
      late.payment.id,
    ]);

    const page1 = await list(s, { limit: 1 });
    expect(page1.rows.map((r) => r.id)).toEqual([today.payment.id]);
    expect(page1.hasMore).toBe(true);
    // Totals cover every matching payment, not just the page.
    expect(page1.totals.count).toBe(2);
    const page2 = await list(s, { limit: 1, offset: 1 });
    expect(page2.rows.map((r) => r.id)).toEqual([late.payment.id]);
    expect(page2.hasMore).toBe(false);
  }, 60_000);

  it("refuses bad filters and other roles", async () => {
    const s = await setup();
    const bad = await listPayments.call(s.rt, s.staff, { from: TODAY, to: YESTERDAY });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe("VALIDATION");
      expect(bad.error.details?.fields).toEqual([expect.objectContaining({ path: "to" })]);
    }
    const unknownCollector = await listPayments.call(s.rt, s.staff, { collectorId: uuidv7() });
    expect(!unknownCollector.ok && unknownCollector.error.code).toBe("NOT_FOUND");
    const unknownCustomer = await listPayments.call(s.rt, s.staff, { customerId: uuidv7() });
    expect(!unknownCustomer.ok && unknownCustomer.error.code).toBe("NOT_FOUND");
    const lineman = await listPayments.call(s.rt, s.lineman, {});
    expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
    const owner = await listPayments.call(s.rt, s.owner, {});
    expect(owner.ok).toBe(true);
  }, 60_000);

  it("shows one payment: bills paid, advance, snapshots; then who undid it and why", async () => {
    const s = await setup();
    const asha = await customer(s, {
      name: "Asha Devi",
      bills: [
        ["2026-09-01", 30_000],
        ["2026-10-01", 30_000],
      ],
    });
    const posted = await counter(s, s.staff, asha, 70_000, "upi");

    const before = await getPayment.call(s.rt, s.staff, { paymentId: posted.payment.id });
    if (!before.ok) throw new Error(before.error.code);
    expect(before.value).toMatchObject({
      id: posted.payment.id,
      amountPaise: 70_000,
      method: "upi",
      upiReference: "412345678901",
      source: "web",
      customer: { id: asha, name: "Asha Devi", balancePaise: -10_000, creditPaise: 10_000 },
      collector: { id: s.tenant.users.staff },
      receipt: { receiptNumber: posted.receipt.receiptNumber, provisionalRef: null },
      creditAddedPaise: 10_000,
      balanceAfterPaise: -10_000,
      creditAfterPaise: 10_000,
      review: { status: "none", reason: null, reviewedBy: null, reviewedAt: null, note: null },
      cancellation: null,
    });
    expect(
      before.value.bills.map((b) => [b.period, b.amountPaise, b.outstandingAfterPaise]),
    ).toEqual([
      ["2026-09-01", 30_000, 0],
      ["2026-10-01", 30_000, 0],
    ]);

    const undone = await reversePayment.call(s.rt, s.owner, {
      paymentId: posted.payment.id,
      reason: "wrong_customer: paid for the neighbour",
    });
    expect(undone.ok).toBe(true);
    const after = await getPayment.call(s.rt, s.staff, { paymentId: posted.payment.id });
    if (!after.ok) throw new Error(after.error.code);
    // Balance now = balance before + amount (the bills are open again); the posting rows stay.
    expect(after.value.customer.balancePaise).toBe(60_000);
    expect(after.value.customer.creditPaise).toBe(0);
    expect(after.value.bills).toEqual(before.value.bills);
    expect(after.value.balanceAfterPaise).toBe(-10_000);
    expect(after.value.cancellation).toMatchObject({
      reason: "wrong_customer: paid for the neighbour",
      by: { id: s.tenant.users.owner },
    });
    expect(after.value.cancellation?.by.name).toBeTruthy();
    expect(checkLedger(await tenantTx(s, (tx) => readLedgerState(tx, asha)))).toEqual([]);

    const missing = await getPayment.call(s.rt, s.staff, { paymentId: uuidv7() });
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
    const lineman = await getPayment.call(s.rt, s.lineman, { paymentId: posted.payment.id });
    expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
  }, 60_000);

  it("gives the printable receipt (customer's view), Cancelled after an undo", async () => {
    const s = await setup();
    const asha = await customer(s, { name: "Shri Asha Devi", bills: [["2026-10-01", 30_000]] });
    const posted = await counter(s, s.staff, asha, 30_000);
    const receipt = await getPaymentReceipt.call(s.rt, s.staff, { paymentId: posted.payment.id });
    if (!receipt.ok) throw new Error(receipt.error.code);
    expect(receipt.value).toMatchObject({
      receiptNumber: posted.receipt.receiptNumber,
      amountPaise: 30_000,
      method: "cash",
      cancelled: false,
      customer: { firstName: "Asha" },
      bills: [{ period: "2026-10-01", leftPaise: 0 }],
      balanceAfter: { kind: "clear" },
    });
    await reversePayment.call(s.rt, s.owner, { paymentId: posted.payment.id, reason: "other" });
    const cancelled = await getPaymentReceipt.call(s.rt, s.owner, {
      paymentId: posted.payment.id,
    });
    expect(cancelled.ok && cancelled.value.cancelled).toBe(true);
    const missing = await getPaymentReceipt.call(s.rt, s.owner, { paymentId: uuidv7() });
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
  }, 60_000);

  it("marks a flagged payment as checked once; nothing else about the payment changes", async () => {
    const s = await setup();
    const closed = await customer(s, { status: "inactive" });
    const flagged = await counter(s, s.staff, closed, 15_000);
    expect(flagged.outcome).toBe("posted_needs_review");
    const open = await customer(s);
    const normal = await counter(s, s.staff, open, 15_000);

    const toCheck = await list(s, { status: "to_check" });
    expect(toCheck.rows.map((r) => r.id)).toEqual([flagged.payment.id]);
    expect(toCheck.rows[0]?.reviewReason).toBe("customer_inactive");
    expect(toCheck.totals.toCheckCount).toBe(1);

    const rowBefore = await tenantTx(s, (tx) =>
      tx.select().from(payments).where(eq(payments.id, flagged.payment.id)),
    );
    const done = await resolvePaymentReview.call(s.rt, s.staff, {
      paymentId: flagged.payment.id,
      note: "  Customer came back, re-opened tomorrow  ",
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    expect(done.value).toEqual({
      paymentId: flagged.payment.id,
      reviewStatus: "resolved",
      reviewedAt: NOW,
    });
    const [rowAfter] = await tenantTx(s, (tx) =>
      tx.select().from(payments).where(eq(payments.id, flagged.payment.id)),
    );
    expect(rowAfter).toEqual({
      ...rowBefore[0],
      reviewStatus: "resolved",
      reviewedBy: s.tenant.users.staff,
      reviewedAt: NOW,
      reviewNote: "Customer came back, re-opened tomorrow",
    });
    const audit = await tenantTx(s, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, flagged.payment.id)),
    );
    expect(audit.find((a) => a.action === "payments.resolve_review")).toMatchObject({
      entityType: "payment",
      actorId: s.tenant.users.staff,
      after: { review_status: "resolved", has_note: true },
    });
    expect((await list(s, { status: "to_check" })).rows).toEqual([]);
    const detail = await getPayment.call(s.rt, s.owner, { paymentId: flagged.payment.id });
    expect(detail.ok && detail.value.review).toMatchObject({
      status: "resolved",
      reason: "customer_inactive",
      reviewedBy: { id: s.tenant.users.staff },
      note: "Customer came back, re-opened tomorrow",
    });

    const again = await resolvePaymentReview.call(s.rt, s.owner, { paymentId: flagged.payment.id });
    expect(!again.ok && again.error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "already_resolved" },
    });
    const notFlagged = await resolvePaymentReview.call(s.rt, s.owner, {
      paymentId: normal.payment.id,
    });
    expect(!notFlagged.ok && notFlagged.error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "not_flagged" },
    });
    const lineman = await resolvePaymentReview.call(s.rt, s.lineman, {
      paymentId: flagged.payment.id,
    });
    expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
    const missing = await resolvePaymentReview.call(s.rt, s.owner, { paymentId: uuidv7() });
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
  }, 60_000);

  it("in read-only mode: counter payments and reads work, checking a payment does not", async () => {
    const s = await setup();
    const closed = await customer(s, { status: "inactive" });
    await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
    const flagged = await counter(s, s.staff, closed, 15_000);
    expect((await list(s, {})).rows).toHaveLength(1);
    const blocked = await resolvePaymentReview.call(s.rt, s.staff, {
      paymentId: flagged.payment.id,
    });
    expect(!blocked.ok && blocked.error.code).toBe("TENANT_READ_ONLY");
  }, 60_000);

  it("the counter's double submit: the same payment id twice is one payment and one receipt", async () => {
    const s = await setup();
    const asha = await customer(s, { bills: [["2026-10-01", 50_000]] });
    const input = { id: uuidv7(), customerId: asha, amountPaise: 50_000, method: "cash" as const };
    const [a, b] = await Promise.all([
      postPayment.call(s.rt, s.staff, input),
      postPayment.call(s.rt, s.staff, input),
    ]);
    const c = await postPayment.call(s.rt, s.staff, input);
    const outcomes = [a, b, c].map((r) => (r.ok ? r.value.outcome : r.error.code)).sort();
    expect(outcomes).toEqual(["duplicate", "duplicate", "posted"]);
    const receiptNumbers = new Set(
      [a, b, c].map((r) => (r.ok ? r.value.receipt.receiptNumber : null)),
    );
    expect(receiptNumbers.size).toBe(1);
    const stored = await tenantTx(s, (tx) =>
      tx.select().from(payments).where(eq(payments.customerId, asha)),
    );
    expect(stored).toHaveLength(1);
    const storedReceipts = await tenantTx(s, (tx) =>
      tx.select().from(receipts).where(eq(receipts.paymentId, input.id)),
    );
    expect(storedReceipts).toHaveLength(1);
    const register = await list(s, { customerId: asha });
    expect(register.rows.map((r) => r.id)).toEqual([input.id]);
    expect(register.totals.cashPaise).toBe(50_000);
  }, 60_000);

  it("only the Owner can undo a payment (Staff and linemen are refused by the server)", async () => {
    const s = await setup();
    const asha = await customer(s, { bills: [["2026-10-01", 50_000]] });
    const posted = await counter(s, s.staff, asha, 50_000);
    for (const ctx of [s.staff, s.lineman]) {
      const refused = await reversePayment.call(s.rt, ctx, {
        paymentId: posted.payment.id,
        reason: "wrong_amount",
      });
      expect(!refused.ok && refused.error.code).toBe("FORBIDDEN");
    }
    expect((await list(s, { status: "cancelled" })).rows).toEqual([]);
    const owner = await reversePayment.call(s.rt, s.owner, {
      paymentId: posted.payment.id,
      reason: "wrong_amount",
    });
    expect(owner.ok).toBe(true);
    const twice = await reversePayment.call(s.rt, s.owner, {
      paymentId: posted.payment.id,
      reason: "wrong_amount",
    });
    expect(!twice.ok && twice.error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "already_reversed" },
    });
    expect((await list(s, { status: "cancelled" })).rows.map((r) => r.id)).toEqual([
      posted.payment.id,
    ]);
  }, 60_000);
});

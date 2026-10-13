/**
 * `payments.reverse` against a real database (T-046, PLAN §8.6, BR-13, RULE-20): Owner only,
 * append-only (the original rows are byte-for-byte unchanged and the triggers refuse changes),
 * balances, credit and sessions restored, and T-041's `checkLedger` clean after every step.
 */
import { auditEvents, collectionSessions, customerBalances, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import { postPayment } from "./post-payment";
import { reversePayment } from "./reverse-payment";
import { insertCustomer, issueInvoice, readLedgerState } from "./test-support";
import type { PostPaymentResult, ReversePaymentResult } from "./types";

const NOW = new Date("2026-10-13T06:00:00.000Z");

describeDb("payments.reverse", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db, { now: () => NOW });
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

  async function customerWithBills(s: Setup, bills: [string, number][]) {
    return tenantTx(s, async (tx) => {
      const customerId = await insertCustomer(tx, s.tenant.operatorId);
      for (const [period, chargesPaise] of bills) {
        await issueInvoice(tx, s.tenant.operatorId, customerId, { period, chargesPaise });
      }
      return customerId;
    });
  }

  function fieldInput(s: Setup, customerId: string, amountPaise: number) {
    return {
      id: uuidv7(),
      customerId,
      amountPaise,
      method: "cash" as const,
      recordedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      provisionalRef: "P-K7Q-0042",
      claimedCollectorId: s.tenant.users.lineman,
      claimedDeviceId: s.tenant.deviceId,
    };
  }

  async function post(s: Setup, customerId: string, amountPaise: number) {
    const input = fieldInput(s, customerId, amountPaise);
    const r = await postPayment.call(s.rt, s.lineman, input);
    if (!r.ok) throw new Error(`post: ${r.error.code}`);
    return { input, result: r.value as PostPaymentResult };
  }

  async function reverse(s: Setup, paymentId: string): Promise<ReversePaymentResult> {
    const r = await reversePayment.call(s.rt, s.owner, { paymentId, reason: "Counted twice" });
    if (!r.ok) throw new Error(`reverse: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  async function healthy(s: Setup, customerId: string) {
    const state = await tenantTx(s, (tx) => readLedgerState(tx, customerId));
    expect(checkLedger(state)).toEqual([]);
    return state;
  }

  async function rows(sql: string, params: unknown[]) {
    return (await t.current.admin.query(sql, params)).rows;
  }

  /** Every row the posting wrote for a payment, as stored. */
  async function originals(paymentId: string) {
    return {
      payment: await rows("SELECT * FROM payments WHERE id = $1", [paymentId]),
      allocations: await rows(
        "SELECT * FROM allocations WHERE payment_id = $1 AND kind <> 'reversal' ORDER BY id",
        [paymentId],
      ),
      ledger: await rows("SELECT * FROM ledger_entries WHERE payment_id = $1", [paymentId]),
      receipt: await rows("SELECT * FROM receipts WHERE payment_id = $1", [paymentId]),
    };
  }

  async function balanceRow(s: Setup, customerId: string) {
    const [row] = await tenantTx(s, (tx) =>
      tx.select().from(customerBalances).where(eq(customerBalances.customerId, customerId)),
    );
    return row;
  }

  it("cancels every allocation, restores balance, credit, due period and session; originals untouched", async () => {
    const s = await setup();
    const customerId = await customerWithBills(s, [
      ["2026-09-01", 50_000],
      ["2026-10-01", 50_000],
    ]);
    const { result: paid } = await post(s, customerId, 120_000);
    expect(paid.credit).toBe(20_000);
    expect(await balanceRow(s, customerId)).toMatchObject({ oldestDuePeriod: null });
    const before = await originals(paid.payment.id);
    expect(before.allocations).toHaveLength(2);

    const r = await reverse(s, paid.payment.id);
    expect(r.reversal).toMatchObject({
      paymentId: paid.payment.id,
      customerId,
      reason: "Counted twice",
      actorId: s.tenant.users.owner,
    });
    expect(r.payment).toEqual(paid.payment);
    expect(
      r.allocations.map((a) => [
        a.period,
        a.amountPaise,
        a.outstandingAfterPaise,
        a.reversesAllocationId,
      ]),
    ).toEqual(
      [...paid.allocations]
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .map((a) => [a.period, -a.amountPaise, 50_000, a.id]),
    );
    expect(r.newBalance).toBe(100_000);
    expect(r.credit).toBe(0);
    expect(r.creditRemovedPaise).toBe(20_000);

    const state = await healthy(s, customerId);
    expect(state.balancePaise).toBe(100_000);
    expect(state.creditPaise).toBe(0);
    expect(state.ledgerEntries.at(-1)).toEqual({ type: "payment_reversal", amountPaise: 120_000 });
    expect(await balanceRow(s, customerId)).toMatchObject({ oldestDuePeriod: "2026-09-01" });
    const [session] = await tenantTx(s, (tx) => tx.select().from(collectionSessions));
    expect(session).toMatchObject({ cashExpectedPaise: 0, upiTotalPaise: 0, paymentCount: 0 });

    // Append-only: every original row is exactly as it was.
    expect(await originals(paid.payment.id)).toEqual(before);
    const audit = await tenantTx(s, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "payments.reverse")),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entityId).toBe(paid.payment.id);
  });

  it("the database refuses any change to the original rows (append-only triggers)", async () => {
    const s = await setup();
    const customerId = await customerWithBills(s, [["2026-10-01", 50_000]]);
    const { result: paid } = await post(s, customerId, 30_000);
    await reverse(s, paid.payment.id);
    const id = paid.payment.id;
    const attempts = [
      ["UPDATE payments SET amount_paise = 1 WHERE id = $1", "payments"],
      ["DELETE FROM payments WHERE id = $1", "payments"],
      ["UPDATE allocations SET amount_paise = 1 WHERE payment_id = $1", "allocations"],
      ["DELETE FROM allocations WHERE payment_id = $1", "allocations"],
      ["UPDATE ledger_entries SET amount_paise = -1 WHERE payment_id = $1", "ledger_entries"],
      ["DELETE FROM ledger_entries WHERE payment_id = $1", "ledger_entries"],
      ["UPDATE receipts SET receipt_number = 'X' WHERE payment_id = $1", "receipts"],
      ["DELETE FROM payment_reversals WHERE payment_id = $1", "payment_reversals"],
    ] as const;
    for (const [statement] of attempts) {
      // Even the owner/superuser connection is refused (SQLSTATE CB001).
      await expect(t.current.admin.query(statement, [id])).rejects.toMatchObject({ code: "CB001" });
    }
    await healthy(s, customerId);
  });

  it("also cancels the rows from later credit application, so the credit disappears", async () => {
    const s = await setup();
    const customerId = await customerWithBills(s, []);
    const { result: paid } = await post(s, customerId, 70_000);
    expect(paid.credit).toBe(70_000);
    // The November bill uses ₹500 of that credit (PLAN §8.5).
    await tenantTx(s, (tx) =>
      issueInvoice(tx, s.tenant.operatorId, customerId, {
        period: "2026-11-01",
        chargesPaise: 50_000,
      }),
    );
    let state = await healthy(s, customerId);
    expect(state.creditPaise).toBe(20_000);

    const r = await reverse(s, paid.payment.id);
    expect(r.allocations.map((a) => [a.period, a.amountPaise, a.outstandingAfterPaise])).toEqual([
      ["2026-11-01", -50_000, 50_000],
    ]);
    expect(r.creditRemovedPaise).toBe(20_000);
    state = await healthy(s, customerId);
    expect(state.balancePaise).toBe(50_000);
    expect(state.creditPaise).toBe(0);
  });

  it("refuses a second reversal (CONFLICT already_reversed); a replay of the post shows reversed", async () => {
    const s = await setup();
    const customerId = await customerWithBills(s, [["2026-10-01", 50_000]]);
    const { input, result: paid } = await post(s, customerId, 50_000);
    await reverse(s, paid.payment.id);
    const again = await reversePayment.call(s.rt, s.owner, {
      paymentId: paid.payment.id,
      reason: "Again",
    });
    expect(again.ok ? "ok" : again.error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "already_reversed" },
    });
    const replay = await postPayment.call(s.rt, s.lineman, input);
    expect(replay.ok && replay.value).toMatchObject({ outcome: "duplicate", reversed: true });
    expect(replay.ok && replay.value.receipt).toEqual(paid.receipt);
    await healthy(s, customerId);
  });

  it("reopened bills are paid by the next payment; other payments are not touched", async () => {
    const s = await setup();
    const customerId = await customerWithBills(s, [
      ["2026-09-01", 50_000],
      ["2026-10-01", 50_000],
    ]);
    const { result: first } = await post(s, customerId, 50_000);
    const { result: second } = await post(s, customerId, 50_000);
    const secondRows = await originals(second.payment.id);
    await reverse(s, first.payment.id);
    expect(await originals(second.payment.id)).toEqual(secondRows);
    await healthy(s, customerId);
    const { result: third } = await post(s, customerId, 50_000);
    expect(
      third.allocations.map((a) => [a.period, a.amountPaise, a.outstandingAfterPaise]),
    ).toEqual([["2026-09-01", 50_000, 0]]);
    const state = await healthy(s, customerId);
    expect(state.balancePaise).toBe(0);
    const [session] = await tenantTx(s, (tx) => tx.select().from(collectionSessions));
    expect(session).toMatchObject({ cashExpectedPaise: 100_000, paymentCount: 2 });
  });

  it("is Owner only, NOT_FOUND for unknown ids, VALIDATION without a reason, blocked when read-only", async () => {
    const s = await setup();
    const customerId = await customerWithBills(s, [["2026-10-01", 50_000]]);
    const { result: paid } = await post(s, customerId, 10_000);
    for (const ctx of [s.staff, s.lineman]) {
      const r = await reversePayment.call(s.rt, ctx, { paymentId: paid.payment.id, reason: "x" });
      expect(r.ok ? "ok" : r.error.code).toBe("FORBIDDEN");
    }
    const unknown = await reversePayment.call(s.rt, s.owner, { paymentId: uuidv7(), reason: "x" });
    expect(unknown.ok ? "ok" : unknown.error).toEqual({ code: "NOT_FOUND" });
    const blank = await reversePayment.call(s.rt, s.owner, {
      paymentId: paid.payment.id,
      reason: "  ",
    });
    expect(blank.ok ? "ok" : blank.error.code).toBe("VALIDATION");
    await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
    const readOnly = await reversePayment.call(s.rt, s.owner, {
      paymentId: paid.payment.id,
      reason: "x",
    });
    expect(readOnly.ok ? "ok" : readOnly.error.code).toBe("TENANT_READ_ONLY");
    expect(
      await rows("SELECT * FROM payment_reversals WHERE payment_id = $1", [paid.payment.id]),
    ).toEqual([]);
    await healthy(s, customerId);
  });

  it("reverses a web counter payment (no session to change)", async () => {
    const s = await setup();
    const customerId = await customerWithBills(s, [["2026-10-01", 50_000]]);
    const r = await postPayment.call(s.rt, s.staff, {
      id: uuidv7(),
      customerId,
      amountPaise: 50_000,
      method: "upi",
      upiReference: "998877665544",
    });
    if (!r.ok) throw new Error(r.error.code);
    const done = await reverse(s, r.value.payment.id);
    expect(done.newBalance).toBe(50_000);
    await healthy(s, customerId);
    expect(
      await rows("SELECT * FROM collection_sessions WHERE operator_id = $1", [s.tenant.operatorId]),
    ).toEqual([]);
  });
});

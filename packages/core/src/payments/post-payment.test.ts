/**
 * `payments.post` against a real database (T-046, PLAN §8.4): allocation, ledger, receipt,
 * balances, sessions, idempotency, review flags and validation. After every posting the customer's
 * rows are read back and T-041's `checkLedger` must find nothing.
 */
import { auditEvents, collectionSessions, customerBalances, type Tx, uuidv7 } from "@cb/db";
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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
import { MAX_FUTURE_SKEW_MS, MAX_RECORDED_AGE_MS } from "./review";
import { insertCustomer, issueInvoice, readLedgerState } from "./test-support";
import type { PostPaymentResult } from "./types";

const NOW = new Date("2026-10-13T06:00:00.000Z"); // 11:30 IST, 13 Oct 2026

describeDb("payments.post", () => {
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

  async function customerWithBills(s: Setup, bills: [string, number][], status?: "inactive") {
    return tenantTx(s, async (tx) => {
      const customerId = await insertCustomer(tx, s.tenant.operatorId, status ? { status } : {});
      const invoiceIds: string[] = [];
      for (const [period, chargesPaise] of bills) {
        invoiceIds.push(
          await issueInvoice(tx, s.tenant.operatorId, customerId, { period, chargesPaise }),
        );
      }
      return { customerId, invoiceIds };
    });
  }

  /** A mobile payment item as T-061 maps it from the contract. */
  function field(s: Setup, customerId: string, amountPaise: number, extra: object = {}) {
    return {
      id: uuidv7(),
      customerId,
      amountPaise,
      method: "cash" as const,
      recordedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      provisionalRef: "P-K7Q-0012",
      claimedCollectorId: s.tenant.users.lineman,
      claimedDeviceId: s.tenant.deviceId,
      ...extra,
    };
  }

  async function healthy(s: Setup, customerId: string) {
    const state = await tenantTx(s, (tx) => readLedgerState(tx, customerId));
    expect(checkLedger(state)).toEqual([]);
    return state;
  }

  async function count(table: string, operatorId: string): Promise<number> {
    const r = await t.current.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE operator_id = $1`,
      [operatorId],
    );
    return r.rows[0]?.n ?? -1;
  }

  async function counter(operatorId: string, name: string): Promise<number | null> {
    const r = await t.current.admin.query<{ v: string }>(
      "SELECT next_value AS v FROM counters WHERE operator_id = $1 AND name = $2",
      [operatorId, name],
    );
    return r.rows[0] ? Number(r.rows[0].v) : null;
  }

  async function posted(s: Setup, ctx: TenantContext, input: object): Promise<PostPaymentResult> {
    const result = await postPayment.call(s.rt, ctx, input as never);
    if (!result.ok) throw new Error(`post failed: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  describe("posting (PLAN §8.4)", () => {
    it("allocates oldest bill first, writes ledger, receipt, balance and the lineman's session", async () => {
      const s = await setup();
      const { customerId, invoiceIds } = await customerWithBills(s, [
        ["2026-10-01", 50_000],
        ["2026-09-01", 50_000],
      ]);
      const [oct, sep] = invoiceIds as [string, string];
      const input = field(s, customerId, 70_000);
      const r = await posted(s, s.lineman, input);

      expect(r.outcome).toBe("posted");
      expect(r.payment).toMatchObject({
        id: input.id,
        customerId,
        amountPaise: 70_000,
        method: "cash",
        collectorId: s.tenant.users.lineman,
        deviceId: s.tenant.deviceId,
        source: "android",
        businessDate: "2026-10-13",
        reviewStatus: "none",
        reviewReason: null,
      });
      expect(r.payment.recordedAt.toISOString()).toBe(input.recordedAt);
      expect(r.payment.postedAt.toISOString()).toBe(NOW.toISOString());
      // September first (oldest), then October partly: "Sep bill paid, Oct ₹300 left".
      expect(
        r.allocations.map((a) => [a.invoiceId, a.period, a.amountPaise, a.outstandingAfterPaise]),
      ).toEqual([
        [sep, "2026-09-01", 50_000, 0],
        [oct, "2026-10-01", 20_000, 30_000],
      ]);
      expect(r.allocations[0]?.invoiceNumber).toMatch(/^INV-2609-\d{5}$/);
      expect(r.allocations[0]?.invoiceKind).toBe("regular");
      expect(r.creditAddedPaise).toBe(0);
      expect(r.newBalance).toBe(30_000);
      expect(r.credit).toBe(0);
      expect(r.receipt).toMatchObject({
        receiptNumber: "R-2610-00001",
        provisionalRef: "P-K7Q-0012",
      });
      expect(r.reviewReasons).toEqual([]);
      expect(r.reversed).toBe(false);

      const state = await healthy(s, customerId);
      expect(state.balancePaise).toBe(30_000);
      expect(state.ledgerEntries.at(-1)).toEqual({ type: "payment", amountPaise: -70_000 });
      const [balance] = await tenantTx(s, (tx) =>
        tx.select().from(customerBalances).where(eq(customerBalances.customerId, customerId)),
      );
      expect(balance?.oldestDuePeriod).toBe("2026-10-01");

      const sessions = await tenantTx(s, (tx) => tx.select().from(collectionSessions));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        collectorId: s.tenant.users.lineman,
        businessDate: "2026-10-13",
        cashExpectedPaise: 70_000,
        upiTotalPaise: 0,
        paymentCount: 1,
        status: "open",
      });

      const audit = await tenantTx(s, (tx) =>
        tx.select().from(auditEvents).where(eq(auditEvents.entityId, input.id)),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "payments.post", entityType: "payment" });
    });

    it("turns the excess into credit and clears the oldest due period", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, [["2026-10-01", 50_000]]);
      const r = await posted(s, s.lineman, field(s, customerId, 80_000));
      expect(r.allocations.map((a) => a.amountPaise)).toEqual([50_000]);
      expect(r.creditAddedPaise).toBe(30_000);
      expect(r.newBalance).toBe(-30_000);
      expect(r.credit).toBe(30_000);
      await healthy(s, customerId);
      const [balance] = await tenantTx(s, (tx) =>
        tx.select().from(customerBalances).where(eq(customerBalances.customerId, customerId)),
      );
      expect(balance).toMatchObject({
        balancePaise: -30_000,
        creditPaise: 30_000,
        oldestDuePeriod: null,
      });
    });

    it("keeps a payment with no bills as credit; UPI goes to the session's UPI total", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      const r = await posted(
        s,
        s.lineman,
        field(s, customerId, 25_000, { method: "upi", upiReference: "  412345678901 " }),
      );
      expect(r.allocations).toEqual([]);
      expect(r.creditAddedPaise).toBe(25_000);
      expect(r.payment.upiReference).toBe("412345678901");
      await healthy(s, customerId);
      const [session] = await tenantTx(s, (tx) => tx.select().from(collectionSessions));
      expect(session).toMatchObject({
        cashExpectedPaise: 0,
        upiTotalPaise: 25_000,
        paymentCount: 1,
      });
    });

    it("pays the next bill with a later payment and numbers receipts gap-free", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, [
        ["2026-09-01", 50_000],
        ["2026-10-01", 50_000],
      ]);
      const numbers: string[] = [];
      for (const amount of [30_000, 30_000, 40_000]) {
        numbers.push(
          (await posted(s, s.lineman, field(s, customerId, amount))).receipt.receiptNumber,
        );
        await healthy(s, customerId);
      }
      expect(numbers).toEqual(["R-2610-00001", "R-2610-00002", "R-2610-00003"]);
      const state = await healthy(s, customerId);
      expect(state.balancePaise).toBe(0);
      const [session] = await tenantTx(s, (tx) => tx.select().from(collectionSessions));
      expect(session).toMatchObject({ cashExpectedPaise: 100_000, paymentCount: 3 });
    });

    it("dates the payment and its receipt by the IST day of recorded_at", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      // 31 Oct 19:00 UTC = 1 Nov 00:30 IST.
      const s2 = {
        ...s,
        rt: testRuntime(t.current.db, { now: () => new Date("2026-11-01T01:00:00Z") }),
      };
      const r = await posted(
        s2,
        s.lineman,
        field(s, customerId, 10_000, { recordedAt: "2026-10-31T19:00:00.000Z" }),
      );
      expect(r.payment.businessDate).toBe("2026-11-01");
      expect(r.receipt.receiptNumber).toBe("R-2611-00001");
    });

    it("records a web counter payment: server time, no device, no session, no provisional ref", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, [["2026-10-01", 50_000]]);
      for (const ctx of [s.owner, s.staff]) {
        const r = await posted(s, ctx, {
          id: uuidv7(),
          customerId,
          amountPaise: 10_000,
          method: "cash",
          notes: "Paid at office",
        });
        expect(r.outcome).toBe("posted");
        expect(r.payment).toMatchObject({
          source: "web",
          deviceId: null,
          collectorId: ctx.userId,
          notes: "Paid at office",
          businessDate: "2026-10-13",
        });
        expect(r.payment.recordedAt.toISOString()).toBe(NOW.toISOString());
        expect(r.receipt.provisionalRef).toBeNull();
      }
      expect(await count("collection_sessions", s.tenant.operatorId)).toBe(0);
      await healthy(s, customerId);
    });

    it("is allowed for a read-only tenant (D-13: collections continue)", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, [["2026-10-01", 50_000]]);
      await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
      expect((await posted(s, s.lineman, field(s, customerId, 50_000))).outcome).toBe("posted");
      expect(
        (await posted(s, s.owner, { id: uuidv7(), customerId, amountPaise: 100, method: "cash" }))
          .outcome,
      ).toBe("posted");
      await healthy(s, customerId);
    });
  });

  describe("idempotency (FR-015, PRD §15 #8)", () => {
    it("a replay returns the stored result as duplicate and writes nothing", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, [
        ["2026-09-01", 50_000],
        ["2026-10-01", 50_000],
      ]);
      const input = field(s, customerId, 70_000);
      const first = await posted(s, s.lineman, input);
      // Later events must not change the replayed snapshot: another payment, a new bill.
      await posted(s, s.lineman, field(s, customerId, 10_000));
      await tenantTx(s, (tx) =>
        issueInvoice(tx, s.tenant.operatorId, customerId, {
          period: "2026-11-01",
          chargesPaise: 50_000,
        }),
      );
      const tables = ["payments", "receipts", "allocations", "ledger_entries", "audit_events"];
      const before = await Promise.all(tables.map((x) => count(x, s.tenant.operatorId)));
      const receiptCounter = await counter(s.tenant.operatorId, "receipt");

      const replayLater = {
        ...s,
        rt: testRuntime(t.current.db, { now: () => new Date(NOW.getTime() + 3_600_000) }),
      };
      const again = await posted(replayLater, s.lineman, input);
      expect(again).toEqual({ ...first, outcome: "duplicate" });
      expect(await Promise.all(tables.map((x) => count(x, s.tenant.operatorId)))).toEqual(before);
      expect(await counter(s.tenant.operatorId, "receipt")).toBe(receiptCounter);
      const [session] = await tenantTx(s, (tx) => tx.select().from(collectionSessions));
      expect(session).toMatchObject({ cashExpectedPaise: 80_000, paymentCount: 2 });
      await healthy(s, customerId);
    });

    it("a replay sent by another user of the tenant is still the same payment", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      const input = field(s, customerId, 5_000);
      const first = await posted(s, s.lineman, input);
      const again = await posted(s, s.owner, {
        id: input.id,
        customerId,
        amountPaise: 5_000,
        method: "cash",
        recordedAt: input.recordedAt,
        provisionalRef: input.provisionalRef,
      });
      expect(again).toEqual({ ...first, outcome: "duplicate" });
    });

    it("ids are compared in canonical lower case (an upper-case replay is the same payment)", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      const input = field(s, customerId, 5_000, {
        id: uuidv7().toUpperCase(),
        claimedCollectorId: s.tenant.users.lineman.toUpperCase(),
        claimedDeviceId: s.tenant.deviceId.toUpperCase(),
      });
      const first = await posted(s, s.lineman, input);
      expect(first.outcome).toBe("posted"); // no false collector/device mismatch
      expect(first.payment.id).toBe(input.id.toLowerCase());
      const again = await posted(s, s.lineman, { ...input, customerId: customerId.toUpperCase() });
      expect(again).toEqual({ ...first, outcome: "duplicate" });
    });

    it("the same id with different data is refused (ID_REUSED_WITH_DIFFERENT_DATA) and writes nothing", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, [["2026-10-01", 50_000]]);
      const other = await tenantTx(s, (tx) => insertCustomer(tx, s.tenant.operatorId));
      const input = field(s, customerId, 20_000);
      await posted(s, s.lineman, input);
      const before = await count("payments", s.tenant.operatorId);
      const variants: [object, string][] = [
        [{ amountPaise: 20_100 }, "amountPaise"],
        [{ customerId: other }, "customerId"],
        [{ method: "upi" }, "method"],
        [{ notes: "changed" }, "notes"],
        [{ provisionalRef: "P-K7Q-0013" }, "provisionalRef"],
        [{ recordedAt: NOW.toISOString() }, "recordedAt"],
      ];
      for (const [change, fieldName] of variants) {
        const r = await postPayment.call(s.rt, s.lineman, { ...input, ...change } as never);
        expect(r.ok).toBe(false);
        if (r.ok) continue;
        expect(r.error.code).toBe("ID_REUSED_WITH_DIFFERENT_DATA");
        expect(r.error.details?.fields).toEqual([fieldName]);
      }
      expect(await count("payments", s.tenant.operatorId)).toBe(before);
      expect(await count("collection_sessions", s.tenant.operatorId)).toBe(1);
      await healthy(s, customerId);
    });

    it("an id used by another tenant is a separate payment (keys are per tenant, nothing leaks)", async () => {
      const a = await setup();
      const b = await setup();
      const ca = (await customerWithBills(a, [])).customerId;
      const cb = (await customerWithBills(b, [])).customerId;
      const id = uuidv7();
      const ra = await posted(a, a.lineman, { ...field(a, ca, 1_000), id });
      const rb = await posted(b, b.lineman, { ...field(b, cb, 2_000), id });
      expect(ra.outcome).toBe("posted");
      expect(rb.outcome).toBe("posted");
      expect(rb.payment.customerId).toBe(cb);
      expect(rb.receipt.receiptNumber).toBe("R-2610-00001");
    });
  });

  describe("rejections", () => {
    it("NOT_FOUND for an unknown customer or another tenant's customer; nothing written", async () => {
      const a = await setup();
      const b = await setup();
      const theirs = (await customerWithBills(b, [["2026-10-01", 50_000]])).customerId;
      for (const customerId of [theirs, uuidv7()]) {
        const r = await postPayment.call(a.rt, a.lineman, field(a, customerId, 1_000));
        expect(r.ok ? "ok" : r.error).toEqual({ code: "NOT_FOUND" });
      }
      for (const table of ["payments", "customer_balances", "collection_sessions", "counters"]) {
        expect(await count(table, a.tenant.operatorId)).toBe(0);
      }
    });

    it("VALIDATION for bad input, before anything is written", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      const bad: object[] = [
        { amountPaise: 0 },
        { amountPaise: -100 },
        { amountPaise: 10.5 },
        { method: "cheque" },
        { upiReference: "1234" }, // only with UPI
        { provisionalRef: "P-k7q-12" },
        { recordedAt: "2026-10-13T11:30:00+05:30" }, // offsets refused, UTC only
        { id: "not-a-uuid" },
      ];
      for (const change of bad) {
        const r = await postPayment.call(s.rt, s.lineman, {
          ...field(s, customerId, 1_000),
          ...change,
        } as never);
        expect(r.ok ? "ok" : r.error.code).toBe("VALIDATION");
      }
      expect(await count("payments", s.tenant.operatorId)).toBe(0);
    });

    it("mobile payments need recordedAt and provisionalRef; the web may not claim a device", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      const { recordedAt: _r, provisionalRef: _p, ...bare } = field(s, customerId, 1_000);
      const r = await postPayment.call(s.rt, s.lineman, bare);
      expect(r.ok ? "ok" : r.error).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "recordedAt" }, { path: "provisionalRef" }] },
      });
      const web = await postPayment.call(s.rt, s.owner, {
        id: uuidv7(),
        customerId,
        amountPaise: 1_000,
        method: "cash",
        claimedDeviceId: s.tenant.deviceId,
      });
      expect(web.ok ? "ok" : web.error.code).toBe("VALIDATION");
      expect(await count("payments", s.tenant.operatorId)).toBe(0);
    });
  });

  describe("review flags (PLAN §10.4): posted, never rejected", () => {
    it("flags an inactive customer", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, [["2026-10-01", 50_000]], "inactive");
      const r = await posted(s, s.lineman, field(s, customerId, 50_000));
      expect(r.outcome).toBe("posted_needs_review");
      expect(r.payment).toMatchObject({
        reviewStatus: "needs_review",
        reviewReason: "customer_inactive",
      });
      expect(r.allocations).toHaveLength(1);
      await healthy(s, customerId);
    });

    it("flags recorded_at more than 10 min ahead or more than 7 days old, not at the bounds", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
      const cases: [string, string | null][] = [
        [at(MAX_FUTURE_SKEW_MS), null],
        [at(MAX_FUTURE_SKEW_MS + 1_000), "recorded_at_out_of_range"],
        [at(-MAX_RECORDED_AGE_MS), null],
        [at(-MAX_RECORDED_AGE_MS - 1_000), "recorded_at_out_of_range"],
      ];
      for (const [recordedAt, reason] of cases) {
        const r = await posted(s, s.lineman, field(s, customerId, 1_000, { recordedAt }));
        expect(r.payment.reviewReason).toBe(reason);
        expect(r.outcome).toBe(reason ? "posted_needs_review" : "posted");
      }
      await healthy(s, customerId);
    });

    it("flags a different, disabled or unknown claimed collector, and a different device", async () => {
      const s = await setup();
      const { customerId } = await customerWithBills(s, []);
      const other = await createUser(t.current, {
        operatorId: s.tenant.operatorId,
        role: "lineman",
      });
      const gone = await createUser(t.current, {
        operatorId: s.tenant.operatorId,
        role: "lineman",
      });
      await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
        gone.userId,
      ]);
      const foreign = await setup();
      const cases: [object, string[]][] = [
        [{ claimedCollectorId: other.userId }, ["collector_mismatch"]],
        [{ claimedCollectorId: gone.userId }, ["collector_inactive", "collector_mismatch"]],
        [{ claimedCollectorId: foreign.tenant.users.lineman }, ["collector_mismatch"]],
        [{ claimedDeviceId: uuidv7() }, ["device_mismatch"]],
      ];
      for (const [change, reasons] of cases) {
        const r = await posted(s, s.lineman, field(s, customerId, 1_000, change));
        expect(r.reviewReasons).toEqual(reasons);
        expect(r.payment.reviewReason).toBe(reasons[0]);
        // Attribution never follows the claim.
        expect(r.payment.collectorId).toBe(s.tenant.users.lineman);
        expect(r.payment.deviceId).toBe(s.tenant.deviceId);
      }
      await healthy(s, customerId);
      const [session] = await tenantTx(s, (tx) =>
        tx
          .select()
          .from(collectionSessions)
          .where(
            and(
              eq(collectionSessions.collectorId, s.tenant.users.lineman),
              eq(collectionSessions.businessDate, "2026-10-13"),
            ),
          ),
      );
      expect(session?.paymentCount).toBe(4);
    });
  });
});

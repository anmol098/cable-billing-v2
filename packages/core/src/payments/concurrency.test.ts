/**
 * Concurrency of the money path (T-046 acceptance; PRD §15 #8 server side; PLAN §8.4 "lock
 * customer_balances row (FOR UPDATE): serialises allocations per customer").
 *
 * The calls run truly in parallel: a dedicated client with a pool larger than the number of
 * callers, so every call holds its own connection and transaction. No sleeps or timing windows:
 * the database's row locks and unique keys decide.
 */
import { createDb, type DbClient, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { postPayment } from "./post-payment";
import { reversePayment } from "./reverse-payment";
import { insertCustomer, issueInvoice, readLedgerState } from "./test-support";

const NOW = new Date("2026-10-13T06:00:00.000Z");
const PARALLEL = 10;

describeDb("payments: concurrency", () => {
  const t = useTestDatabase();
  let db: DbClient;

  beforeAll(() => {
    db = createDb({
      connectionString: t.current.url,
      driver: "pg",
      max: PARALLEL + 4,
      onIdleError: () => {},
    });
  });
  afterAll(async () => {
    await db?.end();
  });

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    lineman: TenantContext;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(db, { now: () => NOW });
    return {
      tenant,
      rt,
      owner: await contextFor(rt, tenant, "owner"),
      lineman: await contextFor(rt, tenant, "lineman"),
    };
  }

  const tenantTx = <T>(s: Setup, fn: (tx: Tx) => Promise<T>) =>
    db.withTenant(s.tenant.operatorId, fn);

  async function customerWithBills(s: Setup, bills: [string, number][]) {
    return tenantTx(s, async (tx) => {
      const customerId = await insertCustomer(tx, s.tenant.operatorId);
      for (const [period, chargesPaise] of bills) {
        await issueInvoice(tx, s.tenant.operatorId, customerId, { period, chargesPaise });
      }
      return customerId;
    });
  }

  function fieldInput(s: Setup, customerId: string, amountPaise: number, id = uuidv7()) {
    return {
      id,
      customerId,
      amountPaise,
      method: "cash" as const,
      recordedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      provisionalRef: "P-K7Q-0099",
      claimedCollectorId: s.tenant.users.lineman,
      claimedDeviceId: s.tenant.deviceId,
    };
  }

  async function count(table: string, s: Setup, where = "true", params: unknown[] = []) {
    const r = await t.current.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE operator_id = $1 AND ${where}`,
      [s.tenant.operatorId, ...params],
    );
    return r.rows[0]?.n ?? -1;
  }

  async function healthy(s: Setup, customerId: string) {
    const state = await tenantTx(s, (tx) => readLedgerState(tx, customerId));
    expect(checkLedger(state)).toEqual([]);
    return state;
  }

  describe("PRD §15 #8: the same payment sent many times at once", () => {
    it(`${PARALLEL} concurrent identical posts create exactly one payment and one receipt`, async () => {
      const s = await setup();
      const customerId = await customerWithBills(s, [
        ["2026-09-01", 50_000],
        ["2026-10-01", 50_000],
      ]);
      const input = fieldInput(s, customerId, 70_000);
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () => postPayment.call(s.rt, s.lineman, input)),
      );
      const values = results.map((r) => {
        if (!r.ok) throw new Error(`unexpected ${JSON.stringify(r.error)}`);
        return r.value;
      });
      expect(values.filter((v) => v.outcome === "posted")).toHaveLength(1);
      expect(values.filter((v) => v.outcome === "duplicate")).toHaveLength(PARALLEL - 1);
      const winner = values.find((v) => v.outcome === "posted");
      // Every caller got the same result (receipt number, allocations, balances).
      for (const v of values) expect({ ...v, outcome: "posted" }).toEqual(winner);

      expect(await count("payments", s)).toBe(1);
      expect(await count("receipts", s)).toBe(1);
      expect(await count("ledger_entries", s, "payment_id IS NOT NULL")).toBe(1);
      expect(await count("allocations", s)).toBe(2);
      expect(await count("audit_events", s, "action = 'payments.post'")).toBe(1);
      expect(winner?.receipt.receiptNumber).toBe("R-2610-00001");
      const counter = await t.current.admin.query<{ v: string }>(
        "SELECT next_value AS v FROM counters WHERE operator_id = $1 AND name = 'receipt'",
        [s.tenant.operatorId],
      );
      expect(Number(counter.rows[0]?.v)).toBe(2); // one number taken, no gaps
      const session = await t.current.admin.query(
        "SELECT cash_expected_paise::int AS cash, payment_count AS n FROM collection_sessions WHERE operator_id = $1",
        [s.tenant.operatorId],
      );
      expect(session.rows).toEqual([{ cash: 70_000, n: 1 }]);
      const state = await healthy(s, customerId);
      expect(state.balancePaise).toBe(30_000);
    }, 60_000);

    it("the same id raced for different customers: one is posted, the others are refused", async () => {
      const s = await setup();
      const customers = await Promise.all(
        Array.from({ length: 4 }, () => customerWithBills(s, [["2026-10-01", 50_000]])),
      );
      const id = uuidv7();
      const results = await Promise.all(
        customers.map((c) => postPayment.call(s.rt, s.lineman, fieldInput(s, c, 10_000, id))),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((x) => !x.ok)) {
        expect(r.ok ? "ok" : r.error.code).toBe("ID_REUSED_WITH_DIFFERENT_DATA");
      }
      expect(await count("payments", s)).toBe(1);
      expect(await count("receipts", s)).toBe(1);
      for (const c of customers) await healthy(s, c);
    }, 60_000);
  });

  describe("serialised per customer", () => {
    it(`${PARALLEL} different concurrent payments for one customer allocate without overpaying any bill`, async () => {
      const s = await setup();
      const customerId = await customerWithBills(s, [
        ["2026-08-01", 30_000],
        ["2026-09-01", 30_000],
        ["2026-10-01", 30_000],
      ]);
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          postPayment.call(s.rt, s.lineman, fieldInput(s, customerId, 10_000)),
        ),
      );
      expect(results.every((r) => r.ok && r.value.outcome === "posted")).toBe(true);
      const receiptNumbers = results.map((r) => (r.ok ? r.value.receipt.receiptNumber : "")).sort();
      expect(receiptNumbers).toEqual(
        Array.from({ length: PARALLEL }, (_, i) => `R-2610-${String(i + 1).padStart(5, "0")}`),
      );
      const state = await healthy(s, customerId);
      expect(state.balancePaise).toBe(-10_000);
      expect(state.creditPaise).toBe(10_000);
      // Balance snapshots: each payment saw the one before it (a strict sequence, no lost update).
      const snapshots = results.map((r) => (r.ok ? r.value.newBalance : 0)).sort((a, b) => b - a);
      expect(snapshots).toEqual(Array.from({ length: PARALLEL }, (_, i) => 80_000 - i * 10_000));
    }, 60_000);

    it("payments and reversals racing on one customer keep the ledger consistent", async () => {
      const s = await setup();
      const customerId = await customerWithBills(s, [
        ["2026-09-01", 50_000],
        ["2026-10-01", 50_000],
      ]);
      const first = await Promise.all(
        Array.from({ length: 4 }, () =>
          postPayment.call(s.rt, s.lineman, fieldInput(s, customerId, 20_000)),
        ),
      );
      const paymentIds = first.map((r) => (r.ok ? r.value.payment.id : ""));
      const mixed = await Promise.all([
        ...paymentIds
          .slice(0, 2)
          .map((paymentId) =>
            reversePayment.call(s.rt, s.owner, { paymentId, reason: "Wrong customer" }),
          ),
        // The same payment reversed twice at once: exactly one wins.
        ...[0, 1].map(() =>
          reversePayment.call(s.rt, s.owner, {
            paymentId: paymentIds[2] as string,
            reason: "Twice",
          }),
        ),
        ...Array.from({ length: 4 }, () =>
          postPayment.call(s.rt, s.lineman, fieldInput(s, customerId, 15_000)),
        ),
      ]);
      const failures = mixed.filter((r) => !r.ok);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok ? "ok" : failures[0]?.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "already_reversed" },
      });
      expect(await count("payment_reversals", s)).toBe(3);
      const state = await healthy(s, customerId);
      // 100,000 billed − 80,000 paid + 60,000 reversed − 60,000 paid.
      expect(state.balancePaise).toBe(20_000);
      const session = await t.current.admin.query(
        "SELECT cash_expected_paise::int AS cash, payment_count AS n FROM collection_sessions WHERE operator_id = $1",
        [s.tenant.operatorId],
      );
      expect(session.rows).toEqual([{ cash: 80_000, n: 5 }]);
    }, 60_000);
  });
});

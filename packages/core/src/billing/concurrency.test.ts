/**
 * Concurrency of the billing run (T-044 acceptance: "Running the same period twice concurrently
 * creates no duplicates", PRD §15 #4; PLAN §8.2 "two concurrent runs cannot double-bill").
 *
 * Real parallel transactions: a dedicated client whose pool is larger than the number of callers.
 * No sleeps or timing windows: the balance row locks, the run row lock and the RULE-05 UNIQUE
 * decide. Where a test needs a transaction to be blocked, it waits for Postgres to report the
 * lock wait (pg_stat_activity), with a timeout.
 */
import { createDb, type DbClient, invoices, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TenantContext } from "../context/tenant-context";
import { enqueueJob } from "../jobs/queue";
import { postPayment } from "../payments/post-payment";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { billCustomer } from "./customer";
import { billingRunJob } from "./job";
import { ensureRun } from "./runs";
import { scheduleBillingRuns } from "./scheduler";
import { startBillingRun } from "./services";
import { addConnection, drainBillingJobs, insertCustomer, readLedgerState } from "./test-support";

const NOV = "2026-11-01";
const NOV_1 = new Date("2026-11-01T03:00:00.000Z");
const PARALLEL = 6;

describeDb("billing run: concurrency", () => {
  const t = useTestDatabase();
  let db: DbClient;

  beforeAll(() => {
    db = createDb({
      connectionString: t.current.url,
      driver: "pg",
      max: PARALLEL * 3 + 4,
      onIdleError: () => {},
    });
  });
  afterAll(async () => {
    await db?.end();
  });

  interface Setup {
    tenant: SeededTenant;
    owner: TenantContext;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(db, { now: () => NOV_1 });
    return { tenant, owner: await contextFor(rt, tenant, "owner") };
  }
  const op = (s: Setup) => s.tenant.operatorId;
  const tenantTx = <T>(s: Setup, fn: (tx: Tx) => Promise<T>) => db.withTenant(op(s), fn);

  async function customers(s: Setup, n: number, rentalPaise = 30_000): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push(
        await tenantTx(s, async (tx) => {
          const id = await insertCustomer(tx, op(s));
          await addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise });
          return id;
        }),
      );
    }
    return ids;
  }

  async function rows<T>(text: string, params: unknown[]): Promise<T[]> {
    return (await t.current.admin.query(text, params)).rows as T[];
  }

  async function assertBilledOnce(s: Setup, ids: string[], chargesPaise = 30_000) {
    const invoiceRows = await rows<{ customer_id: string; invoice_number: string; n: number }>(
      `SELECT customer_id, invoice_number, charges_paise::int AS n FROM invoices
        WHERE operator_id = $1 AND period = $2 ORDER BY invoice_number`,
      [op(s), NOV],
    );
    expect(invoiceRows.map((r) => r.customer_id).sort()).toEqual([...ids].sort());
    expect(invoiceRows.every((r) => r.n === chargesPaise)).toBe(true);
    // Gap-free numbers, each used once.
    expect(invoiceRows.map((r) => r.invoice_number)).toEqual(
      ids.map((_, i) => `INV-2611-${String(i + 1).padStart(5, "0")}`),
    );
    const ledger = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE operator_id = $1 AND type = 'invoice'",
      [op(s)],
    );
    expect(ledger[0]?.n).toBe(ids.length);
    for (const id of ids) {
      const state = await tenantTx(s, (tx) => readLedgerState(tx, id));
      expect(checkLedger(state)).toEqual([]);
    }
  }

  it("two jobs working the same run at once bill every customer exactly once", async () => {
    const s = await setup();
    const ids = await customers(s, 12);
    const started = await startBillingRun.call(testRuntime(db, { now: () => NOV_1 }), s.owner, {
      period: NOV,
    });
    if (!started.ok) throw new Error(started.error.code);
    // A second (and third) job for the same run, as if a lost job had been re-queued while the
    // first still ran: bypasses the one-live-job rule on purpose.
    for (let i = 0; i < 2; i += 1) {
      await db.withPlatform((tx) =>
        enqueueJob(
          tx,
          billingRunJob,
          { runId: started.value.run.id, period: NOV, mode: "run" },
          { operatorId: op(s), runAfter: NOV_1 },
        ),
      );
    }
    const reports = await Promise.all(
      ["w1", "w2", "w3"].map((workerId) => drainBillingJobs(db, () => NOV_1, { workerId })),
    );
    expect(reports.reduce((n, r) => n + r.succeeded, 0)).toBe(3);
    expect(reports.reduce((n, r) => n + r.failed, 0)).toBe(0);
    await assertBilledOnce(s, ids);
    const [run] = await rows<Record<string, unknown>>(
      "SELECT status, created_count, already_exists_count, failed_count FROM billing_runs WHERE operator_id = $1",
      [op(s)],
    );
    expect(run).toEqual({
      status: "completed",
      created_count: 12,
      already_exists_count: 0,
      failed_count: 0,
    });
  }, 60_000);

  it("the same customer billed by many callers at once gets one invoice; the rest see it", async () => {
    const s = await setup();
    const [id] = await customers(s, 1);
    if (!id) throw new Error("no customer");
    const run = await tenantTx(s, (tx) =>
      ensureRun(tx, {
        operatorId: op(s),
        period: NOV as never,
        trigger: "cron",
        actorId: null,
        now: NOV_1,
      }),
    );
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        billCustomer((fn) => db.withTenant(op(s), fn), {
          operatorId: op(s),
          runId: run.row.id,
          period: NOV as never,
          customerId: id,
          invoicePrefix: "INV",
          now: NOV_1,
        }),
      ),
    );
    expect(results.every((r) => r.outcome === "created")).toBe(true);
    expect(new Set(results.map((r) => r.invoiceId)).size).toBe(1);
    await assertBilledOnce(s, [id]);
  }, 60_000);

  it("concurrent Owner starts and scheduler passes queue one job for the run", async () => {
    const s = await setup();
    const ids = await customers(s, 3);
    const rt = testRuntime(db, { now: () => NOV_1 });
    const log = rt.logger;
    const results = await Promise.all([
      ...Array.from({ length: PARALLEL }, () => startBillingRun.call(rt, s.owner, { period: NOV })),
      scheduleBillingRuns({ db, now: NOV_1, log }),
      scheduleBillingRuns({ db, now: NOV_1, log }),
    ]);
    const starts = results.slice(0, PARALLEL).map((r) => {
      if (!("ok" in r) || !r.ok) throw new Error("start failed");
      return r.value.outcome;
    });
    expect(starts.filter((o) => o === "started").length).toBeLessThanOrEqual(1);
    const jobs = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE operator_id = $1 AND type = 'billing.run'",
      [op(s)],
    );
    expect(jobs[0]?.n).toBe(1);
    const runs = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM billing_runs WHERE operator_id = $1",
      [op(s)],
    );
    expect(runs[0]?.n).toBe(1);
    await drainBillingJobs(db, () => NOV_1);
    await assertBilledOnce(s, ids);
  }, 60_000);

  it("payments posted while the run bills the same customers keep every ledger consistent", async () => {
    const s = await setup();
    const ids = await customers(s, PARALLEL);
    const rt = testRuntime(db, { now: () => NOV_1 });
    const started = await startBillingRun.call(rt, s.owner, { period: NOV });
    expect(started.ok).toBe(true);
    const [, ...payments] = await Promise.all([
      drainBillingJobs(db, () => NOV_1),
      ...ids.map((customerId) =>
        postPayment.call(rt, s.owner, {
          id: uuidv7(),
          customerId,
          amountPaise: 40_000,
          method: "cash",
        }),
      ),
    ]);
    expect(payments.every((p) => p.ok)).toBe(true);
    await assertBilledOnce(s, ids);
    // Whatever the order, each customer owes 300 − 400 = −100: ₹100 credit, bill fully paid.
    for (const id of ids) {
      const state = await tenantTx(s, (tx) => readLedgerState(tx, id));
      expect(state).toMatchObject({ balancePaise: -10_000, creditPaise: 10_000 });
    }
  }, 60_000);

  it("RULE-05 backstop: a writer that skipped the lock wins the race, the run records already_exists", async () => {
    const s = await setup();
    const [id] = await customers(s, 1);
    if (!id) throw new Error("no customer");
    const run = await tenantTx(s, (tx) =>
      ensureRun(tx, {
        operatorId: op(s),
        period: NOV as never,
        trigger: "cron",
        actorId: null,
        now: NOV_1,
      }),
    );
    // An uncommitted regular invoice for the customer and period, inserted without the lock.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let foreignId = "";
    const foreign = db.withTenant(op(s), async (tx) => {
      foreignId = uuidv7();
      await tx.insert(invoices).values({
        id: foreignId,
        operatorId: op(s),
        customerId: id,
        period: NOV,
        invoiceNumber: "LEGACY-1",
        openingBalancePaise: 0,
        chargesPaise: 0,
        totalDuePaise: 0,
      });
      await gate;
    });
    await waitFor(
      async () =>
        (
          await rows(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND query ILIKE '%insert into \"invoices\"%'",
            [],
          )
        ).length > 0,
    );
    const billing = billCustomer((fn) => db.withTenant(op(s), fn), {
      operatorId: op(s),
      runId: run.row.id,
      period: NOV as never,
      customerId: id,
      invoicePrefix: "INV",
      now: NOV_1,
    });
    // The run's invoice insert now waits on the uncommitted row's unique key.
    await waitFor(
      async () =>
        (
          await rows(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%insert into \"invoices\"%'",
            [],
          )
        ).length > 0,
    );
    release();
    await foreign;
    const result = await billing;
    expect(result).toMatchObject({ outcome: "already_exists", invoiceId: foreignId });
    const [item] = await rows<{ outcome: string; invoice_id: string }>(
      "SELECT outcome, invoice_id FROM billing_run_items WHERE run_id = $1",
      [run.row.id],
    );
    expect(item).toEqual({ outcome: "already_exists", invoice_id: foreignId });
    // The run's failed attempt rolled back completely: no number taken, no ledger entry.
    const counter = await rows<{ n: number }>(
      "SELECT coalesce((SELECT next_value::int FROM counters WHERE operator_id = $1 AND name = 'invoice'), 1) AS n",
      [op(s)],
    );
    expect(counter[0]?.n).toBe(1);
    const ledger = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE customer_id = $1",
      [id],
    );
    expect(ledger[0]?.n).toBe(0);
  }, 60_000);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

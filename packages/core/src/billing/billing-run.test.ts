/**
 * The billing run against a real database (T-044; PLAN §8.2, §8.5; FR-009, FR-011, FR-012; J-03;
 * PRD §15 #3, #4; D-13, D-25). Runs go through the services and the real job worker (fixed
 * clock). After every run each customer's rows are read back into T-041's `LedgerState` and
 * `checkLedger` must find nothing.
 */
import { type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import { missedRuns, previewBillingRun, retryFailedItems, startBillingRun } from "./services";
import {
  addAdjustment,
  addConnection,
  drainBillingJobs,
  insertCustomer,
  readLedgerState,
} from "./test-support";
import type { BillingPreview, StartBillingRunResult } from "./types";

const NOV = "2026-11-01";
const DEC = "2026-12-01";
const NOV_1 = new Date("2026-11-01T03:00:00.000Z"); // 08:30 IST, 1 Nov 2026
const NOV_10 = new Date("2026-11-10T06:00:00.000Z");
const NOV_20 = new Date("2026-11-20T06:00:00.000Z");
const DEC_1 = new Date("2026-12-01T03:00:00.000Z");

interface InvoiceRow {
  id: string;
  customer_id: string;
  period: string;
  invoice_number: string;
  opening_balance_paise: number;
  charges_paise: number;
  total_due_paise: number;
}

describeDb("billing run", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    owner: TenantContext;
    staff: TenantContext;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db, { now: () => NOV_1 });
    return {
      tenant,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
    };
  }

  const rtAt = (now: Date) => testRuntime(t.current.db, { now: () => now });
  const tenantTx = <T>(s: Setup, fn: (tx: Tx) => Promise<T>) =>
    t.current.db.withTenant(s.tenant.operatorId, fn);
  const op = (s: Setup) => s.tenant.operatorId;

  async function customer(s: Setup, fn?: (tx: Tx, customerId: string) => Promise<unknown>) {
    return tenantTx(s, async (tx) => {
      const id = await insertCustomer(tx, op(s));
      if (fn) await fn(tx, id);
      return id;
    });
  }

  /** Starts the period's run as the Owner at `now` and works the queue with the same clock. */
  async function runPeriod(s: Setup, period: string, now: Date): Promise<StartBillingRunResult> {
    const started = await startBillingRun.call(rtAt(now), s.owner, { period });
    if (!started.ok) throw new Error(`startBillingRun: ${JSON.stringify(started.error)}`);
    const report = await drainBillingJobs(t.current.db, () => now);
    expect(report.failed).toBe(0);
    return started.value;
  }

  async function rows<T>(text: string, params: unknown[]): Promise<T[]> {
    return (await t.current.admin.query(text, params)).rows as T[];
  }

  const invoicesOf = (s: Setup, period?: string) =>
    rows<InvoiceRow>(
      `SELECT id, customer_id, period::text, invoice_number,
              opening_balance_paise::int, charges_paise::int, total_due_paise::int
         FROM invoices WHERE operator_id = $1 ${period ? "AND period = $2" : ""}
        ORDER BY invoice_number`,
      period ? [op(s), period] : [op(s)],
    );

  const linesOf = (invoiceId: string) =>
    rows<{
      type: string;
      assignment_id: string | null;
      adjustment_id: string | null;
      amount_paise: number;
    }>(
      `SELECT type, assignment_id, adjustment_id, amount_paise::int FROM invoice_lines
        WHERE invoice_id = $1 ORDER BY type, id`,
      [invoiceId],
    );

  const runOf = async (s: Setup, period: string) => {
    const [run] = await rows<Record<string, unknown>>(
      `SELECT id, status, trigger, skip_reason, customer_count, created_count, already_exists_count,
              skipped_count, failed_count, total_charges_paise::int AS total, actor_id,
              finished_at IS NOT NULL AS finished
         FROM billing_runs WHERE operator_id = $1 AND period = $2`,
      [op(s), period],
    );
    return run;
  };

  const itemsOf = (s: Setup, runId: unknown) =>
    rows<{
      customer_id: string;
      outcome: string;
      invoice_id: string | null;
      reason: string | null;
      details: Record<string, unknown>;
      attempts: number;
      updated_at: Date;
    }>(
      `SELECT customer_id, outcome, invoice_id, reason, details, attempts, updated_at
         FROM billing_run_items WHERE operator_id = $1 AND run_id = $2`,
      [op(s), runId],
    );

  async function healthy(s: Setup, customerId: string) {
    const state = await tenantTx(s, (tx) => readLedgerState(tx, customerId));
    expect(checkLedger(state)).toEqual([]);
    return state;
  }

  describe("one run", () => {
    it("bills each customer once: one consolidated invoice, a rent line per billable VC", async () => {
      const s = await setup();
      let first = "";
      let second = "";
      const twoVcs = await customer(s, async (tx, id) => {
        second = await addConnection(tx, op(s), id, {
          startDate: "2026-10-20",
          rentalPaise: 20_000,
        });
        first = await addConnection(tx, op(s), id, {
          startDate: "2026-10-05",
          rentalPaise: 30_000,
        });
      });
      const suspended = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, {
          startDate: "2026-09-01",
          rentalPaise: 25_000,
          events: [{ type: "suspended", date: "2026-10-10" }],
        }),
      );
      const disconnected = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, {
          startDate: "2026-09-01",
          rentalPaise: 25_000,
          events: [{ type: "disconnected", date: "2026-10-20" }],
        }),
      );
      const startsOnFirst = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: NOV, rentalPaise: 15_000 }),
      );
      const startsLater = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-11-05", rentalPaise: 15_000 }),
      );

      const started = await runPeriod(s, NOV, NOV_1);
      expect(started.outcome).toBe("started");
      expect(started.run).toMatchObject({ period: NOV, trigger: "manual", status: "pending" });

      const invoices = await invoicesOf(s);
      expect(invoices.map((i) => [i.customer_id, i.invoice_number, i.charges_paise])).toEqual([
        [twoVcs, "INV-2611-00001", 50_000],
        [startsOnFirst, "INV-2611-00002", 15_000],
      ]);
      for (const inv of invoices) {
        expect(inv).toMatchObject({ opening_balance_paise: 0, total_due_paise: inv.charges_paise });
      }
      const [twoVcsInvoice] = invoices;
      expect(await linesOf(twoVcsInvoice?.id ?? "")).toEqual([
        { type: "rent", assignment_id: first, adjustment_id: null, amount_paise: 30_000 },
        { type: "rent", assignment_id: second, adjustment_id: null, amount_paise: 20_000 },
      ]);

      const run = await runOf(s, NOV);
      expect(run).toMatchObject({
        status: "completed",
        trigger: "manual",
        actor_id: s.tenant.users.owner,
        customer_count: 3,
        created_count: 2,
        skipped_count: 1,
        failed_count: 0,
        already_exists_count: 0,
        total: 65_000,
        finished: true,
      });
      const items = await itemsOf(s, run?.id);
      const byCustomer = new Map(items.map((i) => [i.customer_id, i]));
      expect(byCustomer.get(suspended)).toMatchObject({
        outcome: "skipped",
        reason: "nothing_to_bill",
      });
      expect(byCustomer.has(disconnected)).toBe(false);
      expect(byCustomer.has(startsLater)).toBe(false);
      expect(byCustomer.get(twoVcs)).toMatchObject({
        outcome: "created",
        invoice_id: twoVcsInvoice?.id,
      });

      const state = await healthy(s, twoVcs);
      expect(state.balancePaise).toBe(50_000);
      const [balance] = await rows<{ oldest: string }>(
        "SELECT oldest_due_period::text AS oldest FROM customer_balances WHERE customer_id = $1",
        [twoVcs],
      );
      expect(balance?.oldest).toBe(NOV);
      for (const c of [suspended, startsOnFirst]) await healthy(s, c);

      const audits = await rows<{ action: string; actor_id: string | null }>(
        "SELECT action, actor_id FROM audit_events WHERE operator_id = $1 AND entity_type = 'billing_run' ORDER BY at, id",
        [op(s)],
      );
      expect(audits).toEqual([
        { action: "billing.run_started", actor_id: s.tenant.users.owner },
        { action: "billing.run_completed", actor_id: null },
      ]);
    }, 60_000);

    it("running the same period again bills nobody twice (PRD §15 #4, FR-009)", async () => {
      const s = await setup();
      const a = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 30_000 }),
      );
      await runPeriod(s, NOV, NOV_1);
      // A customer who becomes billable for November later (a back-dated connection).
      const late = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-15", rentalPaise: 10_000 }),
      );
      const again = await runPeriod(s, NOV, NOV_10);
      expect(again.outcome).toBe("started");
      await runPeriod(s, NOV, NOV_20);

      const invoices = await invoicesOf(s, NOV);
      expect(invoices.map((i) => [i.customer_id, i.invoice_number])).toEqual([
        [a, "INV-2611-00001"],
        [late, "INV-2611-00002"],
      ]);
      const counter = await rows<{ v: number }>(
        "SELECT next_value::int AS v FROM counters WHERE operator_id = $1 AND name = 'invoice'",
        [op(s)],
      );
      expect(counter[0]?.v).toBe(3); // two numbers taken, no gaps
      expect(await runOf(s, NOV)).toMatchObject({
        status: "completed",
        created_count: 2,
        total: 40_000,
      });
      for (const c of [a, late]) {
        const state = await healthy(s, c);
        expect(state.ledgerEntries).toHaveLength(1);
      }
    }, 60_000);

    it("pending debit adjustments become lines; later-period ones stay pending; credits pay", async () => {
      const s = await setup();
      let assignmentId = "";
      const ids: Record<string, string> = {};
      const c = await customer(s, async (tx, id) => {
        assignmentId = await addConnection(tx, op(s), id, {
          startDate: "2026-10-01",
          rentalPaise: 40_000,
        });
        ids.change = await addAdjustment(tx, op(s), {
          customerId: id,
          direction: "debit",
          amountPaise: 10_000,
          source: "plan_change",
          assignmentId,
          period: "2026-10-01",
        });
        ids.manual = await addAdjustment(tx, op(s), {
          customerId: id,
          direction: "debit",
          amountPaise: 5_000,
          source: "manual",
          createdBy: s.tenant.users.owner,
        });
        ids.later = await addAdjustment(tx, op(s), {
          customerId: id,
          direction: "debit",
          amountPaise: 7_000,
          source: "plan_change",
          assignmentId,
          period: DEC,
        });
        ids.credit = await addAdjustment(tx, op(s), {
          customerId: id,
          direction: "credit",
          amountPaise: 12_000,
          source: "manual",
          createdBy: s.tenant.users.owner,
        });
      });
      const adjustmentOnly = await customer(s, (tx, id) =>
        addAdjustment(tx, op(s), {
          customerId: id,
          direction: "debit",
          amountPaise: 3_000,
          source: "manual",
          createdBy: s.tenant.users.owner,
        }),
      );
      await runPeriod(s, NOV, NOV_1);

      const [inv, onlyAdj] = await invoicesOf(s, NOV);
      expect(inv).toMatchObject({
        customer_id: c,
        opening_balance_paise: -12_000,
        charges_paise: 55_000,
        total_due_paise: 43_000,
      });
      expect(await linesOf(inv?.id ?? "")).toEqual([
        { type: "rent", assignment_id: assignmentId, adjustment_id: null, amount_paise: 40_000 },
        // No period first, then oldest period.
        { type: "adjustment", assignment_id: null, adjustment_id: ids.manual, amount_paise: 5_000 },
        {
          type: "adjustment",
          assignment_id: assignmentId,
          adjustment_id: ids.change,
          amount_paise: 10_000,
        },
      ]);
      const pending = await rows<{ id: string; invoice_id: string | null }>(
        "SELECT id, invoice_id FROM adjustments WHERE customer_id = $1 ORDER BY id",
        [c],
      );
      expect(Object.fromEntries(pending.map((p) => [p.id, p.invoice_id]))).toEqual({
        [ids.change ?? ""]: inv?.id,
        [ids.manual ?? ""]: inv?.id,
        [ids.later ?? ""]: null,
        [ids.credit ?? ""]: null,
      });
      // PLAN §8.5: the credit adjustment paid ₹120 of the new bill; ledger unchanged by it.
      const allocs = await rows<{
        source_type: string;
        amount_paise: number;
        outstanding_after_paise: number;
      }>(
        "SELECT source_type, amount_paise::int, outstanding_after_paise::int FROM allocations WHERE customer_id = $1",
        [c],
      );
      expect(allocs).toEqual([
        { source_type: "credit_adjustment", amount_paise: 12_000, outstanding_after_paise: 43_000 },
      ]);
      const state = await healthy(s, c);
      expect(state).toMatchObject({ balancePaise: 43_000, creditPaise: 0 });

      expect(onlyAdj).toMatchObject({ customer_id: adjustmentOnly, charges_paise: 3_000 });
      await healthy(s, adjustmentOnly);
    }, 60_000);

    it("never charges a VC twice when a mid-month-start adjustment already charges it (T-040 Q-4, T-042 Q-2)", async () => {
      const s = await setup();
      let fullMonth = "";
      let normal = "";
      let adjustmentId = "";
      const c = await customer(s, async (tx, id) => {
        normal = await addConnection(tx, op(s), id, {
          startDate: "2026-10-01",
          rentalPaise: 20_000,
        });
        // Started on the 1st after the customer was looked at; the D-18 hook charged the month.
        fullMonth = await addConnection(tx, op(s), id, { startDate: NOV, rentalPaise: 30_000 });
        adjustmentId = await addAdjustment(tx, op(s), {
          customerId: id,
          direction: "debit",
          amountPaise: 30_000,
          source: "mid_month_start",
          assignmentId: fullMonth,
          period: NOV,
        });
      });
      await runPeriod(s, NOV, NOV_1);
      const [inv] = await invoicesOf(s, NOV);
      expect(inv?.charges_paise).toBe(50_000);
      expect(await linesOf(inv?.id ?? "")).toEqual([
        { type: "rent", assignment_id: normal, adjustment_id: null, amount_paise: 20_000 },
        {
          type: "adjustment",
          assignment_id: fullMonth,
          adjustment_id: adjustmentId,
          amount_paise: 30_000,
        },
      ]);
      const run = await runOf(s, NOV);
      const [item] = await itemsOf(s, run?.id);
      expect(item?.details).toEqual({ midMonthStartAssignmentIds: [fullMonth] });
      await healthy(s, c);

      // The December run bills both VCs normally (the guard is per period).
      await runPeriod(s, DEC, DEC_1);
      const [dec] = await invoicesOf(s, DEC);
      expect(dec?.charges_paise).toBe(50_000);
      expect((await linesOf(dec?.id ?? "")).map((l) => l.type)).toEqual(["rent", "rent"]);
    }, 60_000);

    it("a late run uses the rental in force at the end of the period (T-042 Q-3, BR-07); ₹0 rentals give ₹0 bills", async () => {
      const s = await setup();
      const changed = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, {
          startDate: "2026-10-01",
          rentalPaise: 30_000,
          events: [
            { type: "plan_changed", date: "2026-11-10", fromPaise: 30_000, toPaise: 45_000 },
          ],
        }),
      );
      const free = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 0 }),
      );
      await runPeriod(s, NOV, NOV_20);
      const invoices = await invoicesOf(s, NOV);
      expect(invoices.map((i) => [i.customer_id, i.charges_paise])).toEqual([
        [changed, 45_000],
        [free, 0],
      ]);
      for (const c of [changed, free]) await healthy(s, c);
    }, 60_000);

    it("uses the operator's invoice prefix", async () => {
      const s = await setup();
      await t.current.admin.query(
        `UPDATE operators SET settings = settings || '{"invoice_prefix": "CB"}'::jsonb WHERE id = $1`,
        [op(s)],
      );
      await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 30_000 }),
      );
      await runPeriod(s, NOV, NOV_1);
      expect((await invoicesOf(s)).map((i) => i.invoice_number)).toEqual(["CB-2611-00001"]);
    }, 60_000);
  });

  describe("FR-012: arrears and credit carry forward", () => {
    it("the opening balance of N+1 is the closing balance of N", async () => {
      const s = await setup();
      const under = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 50_000 }),
      );
      const over = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 50_000 }),
      );
      await runPeriod(s, NOV, NOV_1);
      const pay = async (customerId: string, amountPaise: number) => {
        const r = await postPayment.call(rtAt(NOV_10), s.owner, {
          id: uuidv7(),
          customerId,
          amountPaise,
          method: "cash",
        });
        expect(r.ok).toBe(true);
      };
      await pay(under, 20_000);
      await pay(over, 70_000);
      const closing = new Map<string, number>();
      for (const c of [under, over]) closing.set(c, (await healthy(s, c)).balancePaise);
      expect(Object.fromEntries(closing)).toEqual({ [under]: 30_000, [over]: -20_000 });

      await runPeriod(s, DEC, DEC_1);
      const dec = await invoicesOf(s, DEC);
      const nov = await invoicesOf(s, NOV);
      for (const inv of dec) {
        const before = nov.find((n) => n.customer_id === inv.customer_id);
        expect(inv.opening_balance_paise).toBe(closing.get(inv.customer_id));
        // Closing of November = its total due − what was paid in between.
        const paid = inv.customer_id === under ? 20_000 : 70_000;
        expect(inv.opening_balance_paise).toBe((before?.total_due_paise ?? 0) - paid);
        expect(inv.total_due_paise).toBe(inv.opening_balance_paise + inv.charges_paise);
      }
      expect(dec.map((i) => [i.invoice_number, i.charges_paise])).toEqual([
        ["INV-2612-00003", 50_000],
        ["INV-2612-00004", 50_000],
      ]);
      // The ₹200 advance paid ₹200 of December's bill (credit application, oldest source first).
      const overState = await healthy(s, over);
      expect(overState).toMatchObject({ balancePaise: 30_000, creditPaise: 0 });
      const decOver = dec.find((i) => i.customer_id === over);
      const applied = await rows<{ kind: string; amount_paise: number }>(
        "SELECT kind, amount_paise::int FROM allocations WHERE invoice_id = $1",
        [decOver?.id],
      );
      expect(applied).toEqual([{ kind: "credit_application", amount_paise: 20_000 }]);
      const underState = await healthy(s, under);
      expect(underState.balancePaise).toBe(80_000);
      const [oldest] = await rows<{ oldest: string }>(
        "SELECT oldest_due_period::text AS oldest FROM customer_balances WHERE customer_id = $1",
        [under],
      );
      expect(oldest?.oldest).toBe(NOV);
    }, 60_000);
  });

  describe("failures and retry (J-03)", () => {
    it("records failed customers, finishes with errors, and retryFailedItems re-runs only them", async () => {
      const s = await setup();
      const good = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 30_000 }),
      );
      const drifted = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 30_000 }),
      );
      const broken = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, {
          startDate: "2026-10-01",
          rentalPaise: 30_000,
          events: [{ type: "suspended", date: "2026-09-15" }], // before the start
        }),
      );
      await t.current.admin.query(
        "INSERT INTO customer_balances (customer_id, operator_id, balance_paise) VALUES ($1, $2, 123)",
        [drifted, op(s)],
      );
      await runPeriod(s, NOV, NOV_1);
      const run = await runOf(s, NOV);
      expect(run).toMatchObject({
        status: "completed_with_errors",
        created_count: 1,
        failed_count: 2,
      });
      const items = new Map((await itemsOf(s, run?.id)).map((i) => [i.customer_id, i]));
      expect(items.get(drifted)).toMatchObject({
        outcome: "failed",
        reason: "balance_mismatch",
        details: { balancePaise: 123, ledgerPaise: 0 },
      });
      expect(items.get(broken)).toMatchObject({ outcome: "failed", reason: "event_before_start" });
      const goodItem = items.get(good);

      // Staff can't retry (D-16).
      const staffTry = await retryFailedItems.call(rtAt(NOV_10), s.staff, {
        runId: String(run?.id),
      });
      expect(staffTry.ok ? "ok" : staffTry.error.code).toBe("FORBIDDEN");

      await t.current.admin.query(
        "UPDATE customer_balances SET balance_paise = 0 WHERE customer_id = $1",
        [drifted],
      );
      const retried = await retryFailedItems.call(rtAt(NOV_10), s.owner, {
        runId: String(run?.id),
      });
      if (!retried.ok) throw new Error(retried.error.code);
      expect(retried.value).toMatchObject({ outcome: "started", failedCount: 2 });
      expect((await drainBillingJobs(t.current.db, () => NOV_10)).failed).toBe(0);

      const after = new Map((await itemsOf(s, run?.id)).map((i) => [i.customer_id, i]));
      expect(after.get(drifted)).toMatchObject({ outcome: "created", attempts: 2 });
      expect(after.get(broken)).toMatchObject({ outcome: "failed", attempts: 2 });
      // The billed customer's item was not touched.
      expect(after.get(good)).toEqual(goodItem);
      expect(await runOf(s, NOV)).toMatchObject({
        status: "completed_with_errors",
        trigger: "manual",
        created_count: 2,
        failed_count: 1,
        total: 60_000,
      });
      for (const c of [good, drifted, broken]) await healthy(s, c);
      expect((await invoicesOf(s, NOV)).map((i) => i.invoice_number)).toEqual([
        "INV-2611-00001",
        "INV-2611-00002",
      ]);

      const runId = String(run?.id);
      const otherRun = await retryFailedItems.call(rtAt(NOV_10), s.owner, { runId: uuidv7() });
      expect(otherRun.ok ? "ok" : otherRun.error.code).toBe("NOT_FOUND");
      // Nothing left that can succeed: retrying again re-runs the one failed item.
      const again = await retryFailedItems.call(rtAt(NOV_20), s.owner, { runId });
      expect(again.ok && again.value.outcome).toBe("started");
      // While it is queued, a second retry doesn't start anything.
      const busy = await retryFailedItems.call(rtAt(NOV_20), s.owner, { runId });
      expect(busy.ok && busy.value.outcome).toBe("already_running");
      await drainBillingJobs(t.current.db, () => NOV_20);
    }, 60_000);

    it("says nothing_to_retry when no item failed", async () => {
      const s = await setup();
      await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 30_000 }),
      );
      await runPeriod(s, NOV, NOV_1);
      const run = await runOf(s, NOV);
      const r = await retryFailedItems.call(rtAt(NOV_10), s.owner, { runId: String(run?.id) });
      expect(r.ok && r.value).toMatchObject({ outcome: "nothing_to_retry", failedCount: 0 });
      const audits = await rows<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE operator_id = $1 AND action LIKE 'billing.run_retry%'",
        [op(s)],
      );
      expect(audits[0]?.n).toBe(0);
    }, 60_000);
  });

  describe("read-only tenants (D-13) and missed runs (D-25)", () => {
    it("a run that finds the tenant read-only is recorded as skipped and billed only when the Owner starts it", async () => {
      const s = await setup();
      const c = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: 30_000 }),
      );
      const started = await startBillingRun.call(rtAt(NOV_1), s.owner, { period: NOV });
      expect(started.ok).toBe(true);
      await setSubscriptionStatus(t.current, op(s), "read_only");
      await drainBillingJobs(t.current.db, () => NOV_1);
      expect(await runOf(s, NOV)).toMatchObject({
        status: "skipped",
        skip_reason: "tenant_read_only",
        finished: true,
      });
      expect(await invoicesOf(s)).toEqual([]);

      for (const ctx of [s.owner, s.staff]) {
        const missed = await missedRuns.call(rtAt(NOV_10), ctx, {});
        if (!missed.ok) throw new Error(missed.error.code);
        expect(missed.value).toEqual([
          expect.objectContaining({
            period: NOV,
            skipReason: "tenant_read_only",
            skippedAt: NOV_1,
          }),
        ]);
      }
      const blocked = await startBillingRun.call(rtAt(NOV_10), s.owner, { period: NOV });
      expect(blocked.ok ? "ok" : blocked.error.code).toBe("TENANT_READ_ONLY");
      // The preview still works and says billing is paused.
      const preview = await previewBillingRun.call(rtAt(NOV_10), s.owner, { period: NOV });
      expect(preview.ok && preview.value).toMatchObject({
        tenantMode: "read_only",
        willBillCount: 1,
        run: { status: "skipped" },
      });

      await setSubscriptionStatus(t.current, op(s), "active");
      const missedRunId = (await runOf(s, NOV))?.id;
      const retry = await retryFailedItems.call(rtAt(NOV_10), s.owner, {
        runId: String(missedRunId),
      });
      expect(retry.ok ? "ok" : retry.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "run_skipped" },
      });
      const run = await runPeriod(s, NOV, NOV_10);
      expect(run.run).toMatchObject({ id: missedRunId, status: "pending", skipReason: null });
      expect((await invoicesOf(s)).map((i) => i.customer_id)).toEqual([c]);
      const after = await missedRuns.call(rtAt(NOV_10), s.owner, {});
      expect(after.ok && after.value).toEqual([]);
      await healthy(s, c);
    }, 60_000);
  });

  describe("periods and roles", () => {
    it("refuses future periods and periods before the tenant started; Staff can't run", async () => {
      const s = await setup();
      const future = await startBillingRun.call(rtAt(NOV_1), s.owner, { period: DEC });
      expect(future.ok ? "ok" : future.error).toMatchObject({
        code: "VALIDATION",
        details: { reason: "period_in_future" },
      });
      const old = await previewBillingRun.call(rtAt(NOV_1), s.owner, { period: "2026-08-01" });
      expect(old.ok ? "ok" : old.error).toMatchObject({
        code: "VALIDATION",
        details: { reason: "period_before_tenant" },
      });
      const notFirst = await startBillingRun.call(rtAt(NOV_1), s.owner, { period: "2026-11-02" });
      expect(notFirst.ok ? "ok" : notFirst.error.code).toBe("VALIDATION");
      const staff = await startBillingRun.call(rtAt(NOV_1), s.staff, { period: NOV });
      expect(staff.ok ? "ok" : staff.error.code).toBe("FORBIDDEN");
      // The tenant's own first month is allowed (it signed up in October).
      const october = await startBillingRun.call(rtAt(NOV_1), s.owner, { period: "2026-10-01" });
      expect(october.ok).toBe(true);
      await drainBillingJobs(t.current.db, () => NOV_1);
    }, 60_000);

    it("a second start while the run is queued is already_running", async () => {
      const s = await setup();
      const first = await startBillingRun.call(rtAt(NOV_1), s.owner, { period: NOV });
      const second = await startBillingRun.call(rtAt(NOV_1), s.owner, { period: NOV });
      expect(first.ok && first.value.outcome).toBe("started");
      expect(second.ok && second.value.outcome).toBe("already_running");
      const jobs = await rows<{ n: number }>(
        "SELECT count(*)::int AS n FROM jobs WHERE operator_id = $1 AND type = 'billing.run'",
        [op(s)],
      );
      expect(jobs[0]?.n).toBe(1);
      await drainBillingJobs(t.current.db, () => NOV_1);
      expect(await runOf(s, NOV)).toMatchObject({ status: "completed", customer_count: 0 });
    }, 60_000);
  });

  describe("preview", () => {
    it("is the run computed read-only: same count, total and problems; writes nothing", async () => {
      const s = await setup();
      for (const rental of [30_000, 45_000]) {
        await customer(s, (tx, id) =>
          addConnection(tx, op(s), id, { startDate: "2026-10-01", rentalPaise: rental }),
        );
      }
      const broken = await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, {
          startDate: "2026-10-01",
          rentalPaise: 30_000,
          events: [{ type: "reactivated", date: "2026-10-10" }], // never suspended
        }),
      );
      await customer(s, (tx, id) =>
        addConnection(tx, op(s), id, {
          startDate: "2026-10-01",
          rentalPaise: 30_000,
          events: [{ type: "suspended", date: "2026-10-10" }],
        }),
      );
      const before = await previewBillingRun.call(rtAt(NOV_1), s.staff, { period: NOV });
      if (!before.ok) throw new Error(before.error.code);
      const expected: BillingPreview = {
        period: NOV as BillingPreview["period"],
        tenantMode: "normal",
        run: null,
        customerCount: 4,
        willBillCount: 2,
        totalChargesPaise: 75_000 as BillingPreview["totalChargesPaise"],
        alreadyBilledCount: 0,
        nothingToBillCount: 1,
        problems: [
          {
            customerId: broken,
            reason: "invalid_transition",
            details: expect.objectContaining({ reason: "invalid_transition" }),
          },
        ],
      };
      expect(before.value).toEqual(expected);
      const written = await rows<{ n: number }>(
        "SELECT (SELECT count(*) FROM invoices WHERE operator_id = $1) + (SELECT count(*) FROM customer_balances WHERE operator_id = $1) + (SELECT count(*) FROM billing_runs WHERE operator_id = $1) AS n",
        [op(s)],
      );
      expect(Number(written[0]?.n)).toBe(0);

      await runPeriod(s, NOV, NOV_1);
      const run = await runOf(s, NOV);
      expect(run).toMatchObject({
        created_count: 2,
        total: 75_000,
        failed_count: 1,
        skipped_count: 1,
      });
      const afterRun = await previewBillingRun.call(rtAt(NOV_1), s.owner, { period: NOV });
      expect(afterRun.ok && afterRun.value).toMatchObject({
        willBillCount: 0,
        alreadyBilledCount: 2,
        totalChargesPaise: 0,
        run: { status: "completed_with_errors" },
      });
    }, 60_000);
  });
});

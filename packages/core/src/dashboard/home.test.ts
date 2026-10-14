/**
 * The Home page read against a real database (T-083): every number equals the service or the
 * ledger it stands for, for the same IST day (payment register, Bills calendar, missed runs,
 * Linemen page, payments to check, Σ positive ledger balances); another busy tenant changes
 * nothing; a new tenant gets zeros and an empty checklist that ticks itself as data arrives; roles
 * and read-only mode.
 */
import { plans, type Tx, uuidv7 } from "@cb/db";
import { createTenant, createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { businessDate, period } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { missedRuns } from "../billing/services";
import { billingMonths } from "../billing/views";
import { getLinemenDay } from "../collections/day";
import { submitHandover } from "../collections/handover";
import { postField, reverse } from "../collections/test-support";
import { newRequestId, type ServiceRuntime } from "../context/runtime";
import { resolveTenantContext, type TenantContext } from "../context/tenant-context";
import { listPayments } from "../payment-register/queries";
import { postPayment } from "../payments/post-payment";
import { insertCustomer, issueInvoice } from "../payments/test-support";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import { homeDashboard } from "./home";
import type { HomeDashboard } from "./types";

const NOW = new Date("2026-10-14T06:30:00.000Z"); // 12:00 IST, 14 Oct 2026
const TODAY = businessDate("2026-10-14");
const OCT = period("2026-10-01");
const SEP = period("2026-09-01");
const minutes = (n: number) => n * 60_000;

describe("dashboard.home", () => {
  describeDb("against a real database", () => {
    const t = useTestDatabase();
    const rtAt = (now: Date): ServiceRuntime => testRuntime(t.current.db, { now: () => now });

    async function home(ctx: TenantContext, rt = rtAt(NOW)): Promise<HomeDashboard> {
      const result = await homeDashboard.call(rt, ctx, {});
      if (!result.ok) throw new Error(`home: ${result.error.code}`);
      return result.value;
    }

    const insertRun = (operatorId: string, values: { period: string; status: string }) =>
      t.current.admin.query(
        `INSERT INTO billing_runs (id, operator_id, period, trigger, status, skip_reason,
           customer_count, created_count, total_charges_paise, started_at, finished_at)
         VALUES (gen_random_uuid(), $1, $2, 'cron', $3::billing_run_status,
           CASE WHEN $3 = 'skipped' THEN 'tenant_read_only'::billing_run_skip_reason END,
           2, 2, 80000, $4, $4) RETURNING id`,
        [operatorId, values.period, values.status, new Date(`${values.period}T00:30:00Z`)],
      );

    interface Busy {
      tenant: SeededTenant;
      owner: TenantContext;
      staff: TenantContext;
      lineman: TenantContext;
      runId: string;
    }

    /**
     * A busy tenant on 14 Oct 2026: October bills, field and counter payments today and earlier
     * this month, an undone payment, last month's payment, a flagged payment (closed customer), a
     * customer with an advance, a submitted handover, the October run and a missed August run.
     */
    async function busyTenant(): Promise<Busy> {
      const tenant = await seedTenant(t.current);
      const op = tenant.operatorId;
      const rt = rtAt(NOW);
      const owner = await contextFor(rt, tenant, "owner");
      const staff = await contextFor(rt, tenant, "staff");
      const lineman = await contextFor(rt, tenant, "lineman");
      const ids = await t.current.db.withTenant(op, async (tx: Tx) => {
        const asha = await insertCustomer(tx, op);
        const bina = await insertCustomer(tx, op);
        const chandu = await insertCustomer(tx, op, { status: "inactive" });
        const advance = await insertCustomer(tx, op);
        await issueInvoice(tx, op, asha, { period: SEP, chargesPaise: 20_000 });
        await issueInvoice(tx, op, asha, { period: OCT, chargesPaise: 50_000 });
        await issueInvoice(tx, op, bina, { period: OCT, chargesPaise: 30_000 });
        await issueInvoice(tx, op, chandu, { period: OCT, chargesPaise: 10_000 });
        return { asha, bina, chandu, advance };
      });
      const counter = async (
        rtx: ServiceRuntime,
        customerId: string,
        paise: number,
        upi = false,
      ) => {
        const id = uuidv7();
        const result = await postPayment.call(rtx, owner, {
          id,
          customerId,
          amountPaise: paise,
          method: upi ? "upi" : "cash",
          ...(upi ? { upiReference: "123456789012" } : {}),
        });
        if (!result.ok) throw new Error(`counter: ${result.error.code}`);
        return id;
      };
      // Today: ₹100 cash at the counter, ₹200 cash + ₹150 UPI in the field, ₹40 cash from the
      // closed customer (flagged, still counted), ₹700 cash from the advance customer.
      await counter(rt, ids.asha, 10_000);
      await postField(rt, lineman, ids.bina, 20_000, "cash", new Date(NOW.getTime() - minutes(90)));
      await postField(rt, lineman, ids.asha, 15_000, "upi", new Date(NOW.getTime() - minutes(80)));
      await counter(rt, ids.chandu, 4_000);
      await counter(rt, ids.advance, 70_000);
      // Undone today: never counted.
      const undone = await counter(rt, ids.bina, 7_000, true);
      await reverse(rt, owner, undone);
      // Earlier this month (3 Oct IST): ₹50 cash; last month (30 Sep IST): ₹999 cash.
      await counter(rtAt(new Date("2026-10-03T05:00:00Z")), ids.bina, 5_000);
      await counter(rtAt(new Date("2026-09-30T12:00:00Z")), ids.asha, 99_900);
      // The lineman hands over today's cash: waiting for the office.
      const handed = await submitHandover.call(rt, lineman, {
        businessDate: TODAY,
        submissionId: uuidv7(),
        cashHandedOverPaise: 20_000,
        unsyncedPaymentCount: 0,
        unsyncedCashPaise: 0,
      });
      if (!handed.ok) throw new Error(`handover: ${handed.error.code}`);
      const run = await insertRun(op, { period: OCT, status: "completed" });
      await insertRun(op, { period: "2026-08-01", status: "skipped" });
      await insertRun(op, { period: "2026-07-01", status: "skipped" });
      return { tenant, owner, staff, lineman, runId: run.rows[0]?.id as string };
    }

    /** Σ max(Σ ledger, 0) per customer, straight from the ledger (admin connection). */
    async function ledgerDue(operatorId: string): Promise<{ due: number; customers: number }> {
      const result = await t.current.admin.query<{ due: string; customers: number }>(
        `SELECT coalesce(sum(net), 0)::text AS due, count(*)::int AS customers
           FROM (SELECT sum(amount_paise) AS net FROM ledger_entries
                  WHERE operator_id = $1 GROUP BY customer_id) l
          WHERE net > 0`,
        [operatorId],
      );
      return { due: Number(result.rows[0]?.due), customers: Number(result.rows[0]?.customers) };
    }

    it("every number equals its source service or the ledger for the same day", async () => {
      const w = await busyTenant();
      // Another busy tenant on the same day changes none of the first tenant's numbers.
      await busyTenant();
      const rt = rtAt(NOW);
      const view = await home(w.owner);

      expect(view.today).toBe(TODAY);
      expect(view.period).toBe(OCT);

      // Today = the payment register for today (undone payment left out).
      const todayRegister = await listPayments.call(rt, w.staff, { from: TODAY, to: TODAY });
      if (!todayRegister.ok) throw new Error(todayRegister.error.code);
      const todayTotals = todayRegister.value.totals;
      expect(view.collectedToday).toEqual({
        cashPaise: todayTotals.cashPaise,
        upiPaise: todayTotals.upiPaise,
        paymentCount: todayTotals.count - todayTotals.cancelledCount,
      });
      expect(view.collectedToday).toEqual({
        cashPaise: 10_000 + 20_000 + 4_000 + 70_000,
        upiPaise: 15_000,
        paymentCount: 5,
      });

      // This month = the register from the 1st to today (September's payment left out).
      const month = await listPayments.call(rt, w.staff, { from: OCT, to: TODAY });
      if (!month.ok) throw new Error(month.error.code);
      expect(view.collectedThisMonth).toEqual({
        cashPaise: month.value.totals.cashPaise,
        upiPaise: month.value.totals.upiPaise,
        paymentCount: month.value.totals.count - month.value.totals.cancelledCount,
      });
      expect(view.collectedThisMonth.cashPaise).toBe(109_000);

      // Billed this month = the Bills calendar's October card.
      const months = await billingMonths.call(rt, w.staff, { from: OCT, to: OCT });
      if (!months.ok) throw new Error(months.error.code);
      const oct = months.value.months[0];
      expect(view.billedThisMonth).toEqual({
        billCount: oct?.billCount,
        totalPaise: oct?.billTotalPaise,
      });
      expect(view.billedThisMonth).toEqual({ billCount: 3, totalPaise: 90_000 });

      // Latest run = October's run as the Bills page shows it.
      expect(view.latestRun?.id).toBe(w.runId);
      expect(view.latestRun).toEqual(oct?.run);

      // Missed runs = billing.missed_runs.
      const missed = await missedRuns.call(rt, w.staff, {});
      if (!missed.ok) throw new Error(missed.error.code);
      expect(view.missedRuns).toEqual({
        count: missed.value.length,
        oldestPeriod: missed.value[0]?.period,
      });
      expect(view.missedRuns).toEqual({ count: 2, oldestPeriod: "2026-07-01" });

      // Due = Σ positive ledger balances (the advance customer counts 0, not minus).
      const ledger = await ledgerDue(w.tenant.operatorId);
      expect(view.due).toEqual({ duePaise: ledger.due, customerCount: ledger.customers });
      // Asha 200 + 500 − 100 − 150 − 999 (her September payment) → she has an advance; Bina
      // 300 − 200 − 50 = 50; Chandu 100 − 40 = 60.
      expect(view.due).toEqual({ duePaise: 11_000, customerCount: 2 });
      const balances = await t.current.admin.query<{ due: string }>(
        `SELECT coalesce(sum(greatest(balance_paise, 0)), 0)::text AS due
           FROM customer_balances WHERE operator_id = $1`,
        [w.tenant.operatorId],
      );
      expect(Number(balances.rows[0]?.due)).toBe(view.due.duePaise);

      // Handovers waiting = the Linemen page's "to check" for today (the only day with one).
      const day = await getLinemenDay.call(rt, w.staff, { businessDate: TODAY });
      if (!day.ok) throw new Error(day.error.code);
      expect(view.handoversWaiting).toEqual({
        count: day.value.totals.waitingCount,
        oldestDate: TODAY,
      });
      expect(view.handoversWaiting.count).toBe(1);

      // Payments to check = the register's "to check" list.
      const toCheck = await listPayments.call(rt, w.staff, { status: "to_check" });
      if (!toCheck.ok) throw new Error(toCheck.error.code);
      expect(view.paymentsToCheck).toBe(toCheck.value.totals.count);
      expect(view.paymentsToCheck).toBe(1);

      // seedTenant: an active subscription, a lineman with a phone; customers but no plans.
      expect(view.subscription).toMatchObject({ status: "active", mode: "normal" });
      expect(view.setup).toEqual({ plans: false, customers: true, linemen: true, app: true });

      // Staff see the same numbers.
      expect(await home(w.staff)).toEqual(view);
    }, 60_000);

    it("counts handovers waiting on any day, oldest first; not the accepted ones", async () => {
      const w = await busyTenant();
      const yesterday = rtAt(new Date("2026-10-13T10:00:00Z"));
      const lineman = await contextFor(yesterday, w.tenant, "lineman");
      const handed = await submitHandover.call(yesterday, lineman, {
        businessDate: "2026-10-12",
        submissionId: uuidv7(),
        cashHandedOverPaise: 0,
        unsyncedPaymentCount: 0,
        unsyncedCashPaise: 0,
      });
      if (!handed.ok) throw new Error(handed.error.code);
      const view = await home(w.owner);
      expect(view.handoversWaiting).toEqual({ count: 2, oldestDate: "2026-10-12" });
    }, 60_000);

    it("a new business: zeros, no run, and the checklist ticks itself as data arrives", async () => {
      const tenant = await createTenant(t.current);
      const op = tenant.operatorId;
      const user = await createUser(t.current, { operatorId: op, role: "owner" });
      await setSubscriptionStatus(t.current, op, "trialing");
      const rt = rtAt(NOW);
      const resolved = await resolveTenantContext(rt, {
        userId: user.userId,
        channel: "web",
        requestId: newRequestId(),
      });
      if (!resolved.ok) throw new Error(resolved.error.code);
      const owner = resolved.value;

      const fresh = await home(owner);
      expect(fresh).toMatchObject({
        collectedToday: { cashPaise: 0, upiPaise: 0, paymentCount: 0 },
        collectedThisMonth: { cashPaise: 0, upiPaise: 0, paymentCount: 0 },
        billedThisMonth: { billCount: 0, totalPaise: 0 },
        due: { duePaise: 0, customerCount: 0 },
        latestRun: null,
        missedRuns: { count: 0, oldestPeriod: null },
        handoversWaiting: { count: 0, oldestDate: null },
        paymentsToCheck: 0,
        setup: { plans: false, customers: false, linemen: false, app: false },
      });
      // setSubscriptionStatus: trial ends 30 days after the row was written (real clock).
      expect(fresh.subscription.status).toBe("trialing");
      expect(fresh.subscription.mode).toBe("normal");
      expect(fresh.subscription.trialEndsOn).not.toBeNull();

      await t.current.db.withTenant(op, async (tx) => {
        await tx
          .insert(plans)
          .values({ id: uuidv7(), operatorId: op, name: "Basic", monthlyAmountPaise: 25_000 });
        await insertCustomer(tx, op);
      });
      expect((await home(owner)).setup).toEqual({
        plans: true,
        customers: true,
        linemen: false,
        app: false,
      });
      const lineman = await createUser(t.current, { operatorId: op, role: "lineman" });
      expect((await home(owner)).setup.linemen).toBe(true);
      await t.current.admin.query(
        `INSERT INTO devices (id, operator_id, user_id, install_id, device_code)
         VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'H83')`,
        [op, lineman.userId],
      );
      expect((await home(owner)).setup).toEqual({
        plans: true,
        customers: true,
        linemen: true,
        app: true,
      });
    }, 60_000);

    it("works in read-only mode and says so; no subscription row is read-only", async () => {
      const tenant = await seedTenant(t.current, { subscription: "read_only" });
      const rt = rtAt(NOW);
      const owner = await contextFor(rt, tenant, "owner");
      expect((await home(owner)).subscription).toEqual({
        status: "read_only",
        mode: "read_only",
        trialEndsOn: null,
        trialDaysLeft: null,
        graceEndsOn: null,
      });
      const none = await seedTenant(t.current, { subscription: null });
      const staff = await contextFor(rt, none, "staff");
      expect((await home(staff)).subscription).toMatchObject({ status: null, mode: "read_only" });
    }, 60_000);

    it("the trial's days left are counted in IST days from the call's clock", async () => {
      const tenant = await seedTenant(t.current, { subscription: "trialing" });
      // Trial ends 20 Oct 2026, 23:00 IST.
      await t.current.admin.query(
        "UPDATE subscriptions SET trial_ends_at = $2 WHERE operator_id = $1",
        [tenant.operatorId, new Date("2026-10-20T17:30:00Z")],
      );
      const rt = rtAt(NOW);
      const owner = await contextFor(rt, tenant, "owner");
      expect((await home(owner)).subscription).toMatchObject({
        status: "trialing",
        trialEndsOn: "2026-10-20",
        trialDaysLeft: 6,
      });
    }, 60_000);

    it("Owner and Staff only", async () => {
      const tenant = await seedTenant(t.current);
      const rt = rtAt(NOW);
      const lineman = await contextFor(rt, tenant, "lineman");
      const result = await homeDashboard.call(rt, lineman, {});
      expect(!result.ok && result.error.code).toBe("FORBIDDEN");
      const staff = await contextFor(rt, tenant, "staff");
      const bad = await homeDashboard.call(rt, staff, { operatorId: tenant.operatorId } as never);
      expect(!bad.ok && bad.error.code).toBe("VALIDATION");
    }, 60_000);
  });
});

/**
 * PLAN §8.3 "Changes after the month's bill is issued": one integration scenario per row, named
 * after the row, on a real database with the real services (T-033 customers, T-034 connections and
 * their hooks, T-044 billing run, T-046 payments) and a fixed clock. After every scenario:
 * - no issued bill or bill line changed (D-14, RULE-10: `changedIssuedRows` is empty);
 * - every customer's books pass T-041 `checkLedger` (invariants 1–4 + read model);
 * - running the bill again for a month changes nothing (no double charge, FR-008, PRD §15 #5).
 */
import { auditEvents } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  changeConnectionPlan,
  disconnectConnection,
  reactivateConnection,
  suspendConnection,
} from "../connections/services";
import type { ConnectionSetup } from "../connections/test-support";
import { postPayment } from "../payments/post-payment";
import { backDatedConnectionChange, previewConnectionChange } from "./services";
import {
  adjustmentsOf,
  billsOf,
  changedIssuedRows,
  connect,
  issuedSnapshot,
  ist,
  ledgerOf,
  ledgerProblems,
  newCustomer,
  runBilling,
  setPolicy,
  setupTenant,
} from "./test-support";

const TIMEOUT = 120_000;

const AUG_1 = ist("2026-08-01");
const AUG_20 = ist("2026-08-20");
const SEP_1 = ist("2026-09-01", "08:30");
const SEP_20 = ist("2026-09-20");
const SEP_30 = ist("2026-09-30");
const OCT_1 = ist("2026-10-01", "08:30");
const OCT_1_NOON = ist("2026-10-01", "12:00");
const OCT_5 = ist("2026-10-05");
const OCT_6 = ist("2026-10-06");
const OCT_7 = ist("2026-10-07");
const OCT_10 = ist("2026-10-10");
const OCT_12 = ist("2026-10-12");
const OCT_14 = ist("2026-10-14");
const NOV_1 = ist("2026-11-01", "08:30");
const NOV_2 = ist("2026-11-02");

describeDb("PLAN §8.3 changes after the month's bill is issued", () => {
  const t = useTestDatabase();

  /** The checks every scenario ends with. */
  async function expectClean(
    s: ConnectionSetup,
    customers: readonly string[],
    issuedBefore: Awaited<ReturnType<typeof issuedSnapshot>>,
  ) {
    expect(changedIssuedRows(issuedBefore, await issuedSnapshot(s))).toEqual([]);
    expect(await ledgerProblems(s, customers)).toEqual({});
  }

  async function balanceOf(customerId: string) {
    const { rows } = await t.current.admin.query<{ balance_paise: string; credit_paise: string }>(
      "SELECT balance_paise, credit_paise FROM customer_balances WHERE customer_id = $1",
      [customerId],
    );
    return {
      balance: Number(rows[0]?.balance_paise ?? 0),
      credit: Number(rows[0]?.credit_paise ?? 0),
    };
  }

  describe("Plan change (D-14, BR-07): the full new rental applies to the current month; the issued invoice is never edited", () => {
    it(
      "nets every change in the month against what is already charged, and the next bill carries it once",
      async () => {
        const s = await setupTenant(t.current);
        const ravi = await newCustomer(s, SEP_1, "Ravi");
        const vc = await connect(s, ravi, "2026-09-01", SEP_1, 40_000);
        await runBilling(s, "2026-10-01", OCT_1);
        const issued = await issuedSnapshot(s);

        // The preview says it before anything is saved.
        const preview = await previewConnectionChange.call(s.rt(OCT_5), s.staff, {
          assignmentId: vc,
          effectiveDate: "2026-10-05",
          change: { kind: "plan", rentalPaise: 50_000 },
        });
        expect(preview.ok && preview.value).toMatchObject({
          backDated: false,
          noChange: false,
          fromRentalPaise: 40_000,
          toRentalPaise: 50_000,
          totalPaise: 10_000,
          months: [
            {
              period: "2026-10-01",
              scope: "change_month",
              outcome: { kind: "debit", amountPaise: 10_000 },
              chargedBeforePaise: 40_000,
              chargedAfterPaise: 50_000,
            },
          ],
        });

        // ₹400 billed → ₹500 → ₹300 → ₹450 → ₹450 again: +100, −200, +150, nothing.
        for (const [now, amount] of [
          [OCT_5, 50_000],
          [OCT_6, 30_000],
          [OCT_7, 45_000],
          [OCT_7, 45_000],
        ] as const) {
          const changed = await changeConnectionPlan.call(s.rt(now), s.staff, {
            assignmentId: vc,
            effectiveDate: now === OCT_5 ? "2026-10-05" : now === OCT_6 ? "2026-10-06" : "2026-10-07",
            rentalPaise: amount,
          });
          expect(changed.ok).toBe(true);
        }
        const made = await adjustmentsOf(s, ravi);
        expect(made.map((a) => [a.source, a.period, a.direction, a.amount, a.invoiceId])).toEqual([
          ["plan_change", "2026-10-01", "debit", 10_000, null],
          ["plan_change", "2026-10-01", "credit", 20_000, null],
          ["plan_change", "2026-10-01", "debit", 15_000, null],
        ]);
        expect(made.every((a) => a.assignmentId === vc && a.createdBy === s.staff.userId)).toBe(
          true,
        );
        // The credit paid the October bill at once (oldest first); the debits wait for the next bill.
        expect(await balanceOf(ravi)).toEqual({ balance: 20_000, credit: 0 });
        expect(await ledgerOf(s, ravi)).toEqual([
          { type: "invoice", amount: 40_000 },
          { type: "credit_adjustment", amount: -20_000 },
        ]);
        await expectClean(s, [ravi], issued);

        // November: rent at ₹450 + the two pending debits; October's rent ends at ₹450.
        await runBilling(s, "2026-11-01", NOV_1);
        const bills = await billsOf(s, ravi);
        expect(bills[1]).toMatchObject({
          period: "2026-11-01",
          opening: 20_000,
          charges: 70_000,
          lines: [
            { type: "adjustment", amount: 10_000 },
            { type: "adjustment", amount: 15_000 },
            { type: "rent", assignmentId: vc, amount: 45_000 },
          ],
        });
        // Billing November again changes nothing.
        const afterNov = await issuedSnapshot(s);
        await runBilling(s, "2026-11-01", NOV_2);
        expect(await billsOf(s, ravi)).toEqual(bills);
        await expectClean(s, [ravi], afterNov);
        expect(await balanceOf(ravi)).toEqual({ balance: 90_000, credit: 0 });
      },
      TIMEOUT,
    );

    it(
      "a plan change before the month is billed needs no adjustment: the bill charges the new amount",
      async () => {
        const s = await setupTenant(t.current);
        const c = await newCustomer(s, SEP_1);
        const vc = await connect(s, c, "2026-09-01", SEP_1, 30_000);
        const changed = await changeConnectionPlan.call(s.rt(SEP_20), s.staff, {
          assignmentId: vc,
          effectiveDate: "2026-09-20",
          rentalPaise: 35_000,
        });
        expect(changed.ok).toBe(true);
        expect(await adjustmentsOf(s, c)).toEqual([]);
        await runBilling(s, "2026-10-01", OCT_1);
        expect((await billsOf(s, c))[0]?.charges).toBe(35_000);
        expect(await ledgerProblems(s, [c])).toEqual({});
      },
      TIMEOUT,
    );
  });

  describe("New connection / reactivation mid-month (D-18): the operator setting decides", () => {
    it(
      "charge_full_month: a new connection mid-month gets a debit for the full rental, billed once on the next bill",
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, "charge_full_month");
        const c = await newCustomer(s, SEP_1);
        await runBilling(s, "2026-10-01", OCT_1);
        const issued = await issuedSnapshot(s);

        const preview = await connect(s, c, "2026-10-10", OCT_10, 30_000);
        expect(await adjustmentsOf(s, c)).toMatchObject([
          {
            assignmentId: preview,
            period: "2026-10-01",
            direction: "debit",
            amount: 30_000,
            source: "mid_month_start",
            invoiceId: null,
          },
        ]);
        // A debit reaches the ledger only through the bill (T-041 Q-A).
        expect(await ledgerOf(s, c)).toEqual([]);
        await expectClean(s, [c], issued);

        await runBilling(s, "2026-11-01", NOV_1);
        const [nov] = await billsOf(s, c);
        expect(nov).toMatchObject({
          period: "2026-11-01",
          charges: 60_000,
          lines: [
            { type: "adjustment", amount: 30_000 },
            { type: "rent", assignmentId: preview, amount: 30_000 },
          ],
        });
        // October again: nothing more (the start's own month is charged by its adjustment only).
        await runBilling(s, "2026-10-01", NOV_2);
        await runBilling(s, "2026-11-01", NOV_2);
        expect(await billsOf(s, c)).toEqual([nov]);
        expect(await ledgerProblems(s, [c])).toEqual({});
      },
      TIMEOUT,
    );

    it(
      "start_next_month: a new connection mid-month adds nothing now and is billed from the next month",
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, "start_next_month");
        const c = await newCustomer(s, SEP_1);
        await runBilling(s, "2026-10-01", OCT_1);
        const vc = await connect(s, c, "2026-10-10", OCT_10, 30_000);
        expect(await adjustmentsOf(s, c)).toEqual([]);
        await runBilling(s, "2026-11-01", NOV_1);
        expect(await billsOf(s, c)).toMatchObject([
          { period: "2026-11-01", charges: 30_000, lines: [{ type: "rent", assignmentId: vc }] },
        ]);
        expect(await ledgerProblems(s, [c])).toEqual({});
      },
      TIMEOUT,
    );

    it(
      "a start on the 1st before the month is billed is charged by the bill, not by an adjustment",
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, "charge_full_month");
        const c = await newCustomer(s, SEP_30);
        const vc = await connect(s, c, "2026-10-01", SEP_30, 30_000);
        expect(await adjustmentsOf(s, c)).toEqual([]);
        await runBilling(s, "2026-10-01", OCT_1);
        await runBilling(s, "2026-10-01", OCT_5);
        expect(await billsOf(s, c)).toMatchObject([
          { period: "2026-10-01", charges: 30_000, lines: [{ type: "rent", assignmentId: vc }] },
        ]);
        expect(await ledgerProblems(s, [c])).toEqual({});
      },
      TIMEOUT,
    );

    it(
      "a start on the 1st after the month is billed is charged once: the adjustment, never also a rent line (run and hook never both charge)",
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, "charge_full_month");
        // Billed: has another connection. Skipped: the run looked and had nothing to bill (a
        // stopped connection). Newcomer: the run never looked at them (no connection yet).
        const billed = await newCustomer(s, SEP_1, "Billed");
        const skipped = await newCustomer(s, SEP_1, "Skipped");
        const newcomer = await newCustomer(s, SEP_1, "Newcomer");
        const old = await connect(s, billed, "2026-09-01", SEP_1, 20_000);
        const stoppedVc = await connect(s, skipped, "2026-09-01", SEP_1, 20_000);
        const stopped = await suspendConnection.call(s.rt(SEP_20), s.staff, {
          assignmentId: stoppedVc,
          effectiveDate: "2026-09-20",
        });
        expect(stopped.ok).toBe(true);
        await runBilling(s, "2026-10-01", OCT_1);
        const issued = await issuedSnapshot(s);

        const newOnBilled = await connect(s, billed, "2026-10-01", OCT_1_NOON, 30_000);
        const newOnSkipped = await connect(s, skipped, "2026-10-01", OCT_1_NOON, 25_000);
        const newOnNewcomer = await connect(s, newcomer, "2026-10-01", OCT_1_NOON, 15_000);
        // The run has not looked at the newcomer: the month's bill will charge it (billed_by_run).
        expect(await adjustmentsOf(s, newcomer)).toEqual([]);
        expect(await adjustmentsOf(s, billed)).toMatchObject([
          { assignmentId: newOnBilled, period: "2026-10-01", amount: 30_000, source: "mid_month_start" },
        ]);
        expect(await adjustmentsOf(s, skipped)).toMatchObject([
          { assignmentId: newOnSkipped, period: "2026-10-01", amount: 25_000, source: "mid_month_start" },
        ]);

        // The Owner bills October again: the billed customer is done; the skipped one now gets an
        // October bill with the adjustment and no rent line for the same connection.
        await runBilling(s, "2026-10-01", OCT_5);
        await expectClean(s, [billed, skipped], issued);
        expect(await billsOf(s, billed)).toMatchObject([
          { period: "2026-10-01", charges: 20_000, lines: [{ type: "rent", assignmentId: old }] },
        ]);
        expect(await billsOf(s, skipped)).toMatchObject([
          {
            period: "2026-10-01",
            charges: 25_000,
            lines: [{ type: "adjustment", amount: 25_000 }],
          },
        ]);
        expect(await billsOf(s, newcomer)).toMatchObject([
          {
            period: "2026-10-01",
            charges: 15_000,
            lines: [{ type: "rent", assignmentId: newOnNewcomer, amount: 15_000 }],
          },
        ]);

        await runBilling(s, "2026-11-01", NOV_1);
        const billedBills = await billsOf(s, billed);
        expect(billedBills[1]).toMatchObject({
          period: "2026-11-01",
          charges: 80_000,
          lines: [
            { type: "adjustment", amount: 30_000 },
            { type: "rent", assignmentId: old, amount: 20_000 },
            { type: "rent", assignmentId: newOnBilled, amount: 30_000 },
          ],
        });
        expect((await billsOf(s, skipped))[1]).toMatchObject({ charges: 25_000 });
        await runBilling(s, "2026-10-01", NOV_2);
        await runBilling(s, "2026-11-01", NOV_2);
        expect(await billsOf(s, billed)).toEqual(billedBills);
        expect(await ledgerProblems(s, [billed, skipped, newcomer])).toEqual({});
      },
      TIMEOUT,
    );

    it(
      "reactivation mid-month: charge_full_month adds the full rental; start_next_month adds nothing",
      async () => {
        for (const policy of ["charge_full_month", "start_next_month"] as const) {
          const s = await setupTenant(t.current);
          await setPolicy(t.current, s.op, policy);
          const c = await newCustomer(s, AUG_1);
          const vc = await connect(s, c, "2026-08-01", AUG_1, 30_000);
          const stopped = await suspendConnection.call(s.rt(SEP_20), s.staff, {
            assignmentId: vc,
            effectiveDate: "2026-09-20",
          });
          expect(stopped.ok).toBe(true);
          await runBilling(s, "2026-10-01", OCT_1);
          const issued = await issuedSnapshot(s);
          const started = await reactivateConnection.call(s.rt(OCT_12), s.staff, {
            assignmentId: vc,
            effectiveDate: "2026-10-12",
          });
          expect(started.ok).toBe(true);
          const made = await adjustmentsOf(s, c);
          if (policy === "charge_full_month") {
            expect(made).toMatchObject([
              { period: "2026-10-01", direction: "debit", amount: 30_000, source: "mid_month_start" },
            ]);
          } else {
            expect(made).toEqual([]);
          }
          await runBilling(s, "2026-11-01", NOV_1);
          const nov = (await billsOf(s, c)).find((b) => b.period === "2026-11-01");
          expect(nov?.charges).toBe(policy === "charge_full_month" ? 60_000 : 30_000);
          await expectClean(s, [c], issued);
        }
      },
      TIMEOUT,
    );

    it(
      "a reactivation in a month that already has rent charges nothing again (billed on the 1st, stopped, started again)",
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, "charge_full_month");
        const c = await newCustomer(s, SEP_1);
        const vc = await connect(s, c, "2026-09-01", SEP_1, 30_000);
        await runBilling(s, "2026-10-01", OCT_1);
        const issued = await issuedSnapshot(s);
        for (const [now, date, service] of [
          [OCT_5, "2026-10-05", suspendConnection],
          [OCT_6, "2026-10-06", reactivateConnection],
          [OCT_7, "2026-10-07", suspendConnection],
          [OCT_10, "2026-10-10", reactivateConnection],
        ] as const) {
          const result = await service.call(s.rt(now), s.staff, {
            assignmentId: vc,
            effectiveDate: date,
          });
          expect(result.ok).toBe(true);
        }
        expect(await adjustmentsOf(s, c)).toEqual([]);
        await expectClean(s, [c], issued);
      },
      TIMEOUT,
    );
  });

  describe("Disconnection / suspension mid-month: the current month stays charged; rent stops from the next month", () => {
    it(
      "makes no adjustment and the next bill has no rent for it",
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, "charge_full_month");
        const c = await newCustomer(s, SEP_1);
        const stopVc = await connect(s, c, "2026-09-01", SEP_1, 30_000);
        const removeVc = await connect(s, c, "2026-09-01", SEP_1, 20_000);
        await runBilling(s, "2026-10-01", OCT_1);
        const issued = await issuedSnapshot(s);
        const stopped = await suspendConnection.call(s.rt(OCT_10), s.staff, {
          assignmentId: stopVc,
          effectiveDate: "2026-10-10",
        });
        const removed = await disconnectConnection.call(s.rt(OCT_12), s.staff, {
          assignmentId: removeVc,
          effectiveDate: "2026-10-12",
          reason: "moved_away",
        });
        expect(stopped.ok && removed.ok).toBe(true);
        const preview = await previewConnectionChange.call(s.rt(OCT_12), s.staff, {
          assignmentId: stopVc,
          effectiveDate: "2026-10-12",
          change: { kind: "disconnect", stopReason: "moved_away" },
        });
        expect(preview.ok && preview.value.months).toMatchObject([
          { period: "2026-10-01", outcome: { kind: "none" }, chargedAfterPaise: 30_000 },
        ]);
        expect(await adjustmentsOf(s, c)).toEqual([]);
        await runBilling(s, "2026-11-01", NOV_1);
        expect(await billsOf(s, c)).toHaveLength(1);
        await expectClean(s, [c], issued);
      },
      TIMEOUT,
    );
  });

  describe("Back-dated effective date into an already-billed period: not allowed for Staff; the Owner's guided flow creates explicit adjustments with a reason", () => {
    it(
      "plan change back-dated across two billed months: Staff refused, Owner nets each month with the reason",
      async () => {
        const s = await setupTenant(t.current);
        const c = await newCustomer(s, AUG_1);
        const vc = await connect(s, c, "2026-08-01", AUG_1, 30_000);
        await runBilling(s, "2026-09-01", SEP_1);
        await runBilling(s, "2026-10-01", OCT_1);
        const issued = await issuedSnapshot(s);

        const staffTry = await changeConnectionPlan.call(s.rt(OCT_14), s.staff, {
          assignmentId: vc,
          effectiveDate: "2026-09-15",
          rentalPaise: 40_000,
        });
        expect(!staffTry.ok && staffTry.error.details).toMatchObject({
          reason: "billed_period",
          period: "2026-10-01",
        });
        const staffFlow = await backDatedConnectionChange.call(s.rt(OCT_14), s.staff, {
          assignmentId: vc,
          effectiveDate: "2026-09-15",
          change: { kind: "plan", rentalPaise: 40_000 },
          reason: "Upgraded in September",
        });
        expect(!staffFlow.ok && staffFlow.error.code).toBe("FORBIDDEN");
        const noReason = await backDatedConnectionChange.call(s.rt(OCT_14), s.owner, {
          assignmentId: vc,
          effectiveDate: "2026-09-15",
          change: { kind: "plan", rentalPaise: 40_000 },
          reason: " ",
        });
        expect(!noReason.ok && noReason.error.code).toBe("VALIDATION");

        const input = {
          assignmentId: vc,
          effectiveDate: "2026-09-15",
          change: { kind: "plan" as const, rentalPaise: 40_000 },
        };
        const preview = await previewConnectionChange.call(s.rt(OCT_14), s.staff, input);
        expect(preview.ok && preview.value).toMatchObject({
          backDated: true,
          latestBilledPeriod: "2026-10-01",
          totalPaise: 20_000,
        });
        const done = await backDatedConnectionChange.call(s.rt(OCT_14), s.owner, {
          ...input,
          reason: "Upgraded in September",
        });
        expect(done.ok).toBe(true);
        if (!done.ok || !preview.ok) return;
        // What the preview said is what was done.
        expect(done.value.months).toEqual(preview.value.months);
        expect(done.value.totalPaise).toBe(20_000);
        expect(await adjustmentsOf(s, c)).toMatchObject([
          { period: "2026-09-01", direction: "debit", amount: 10_000, source: "plan_change", reason: "Upgraded in September", createdBy: s.owner.userId },
          { period: "2026-10-01", direction: "debit", amount: 10_000, source: "plan_change", reason: "Upgraded in September", createdBy: s.owner.userId },
        ]);
        const audit = await s.tx((tx) =>
          tx
            .select()
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.action, "adjustments.back_dated_change"),
                eq(auditEvents.entityId, vc),
              ),
            ),
        );
        expect(audit).toHaveLength(1);
        await expectClean(s, [c], issued);

        await runBilling(s, "2026-11-01", NOV_1);
        const nov = (await billsOf(s, c)).find((b) => b.period === "2026-11-01");
        expect(nov?.charges).toBe(60_000);
        await expectClean(s, [c], issued);
      },
      TIMEOUT,
    );

    it(
      "stop back-dated: its own month stays charged, later billed months are credited, and the credit pays the oldest bill first",
      async () => {
        const s = await setupTenant(t.current);
        const c = await newCustomer(s, AUG_1);
        const vc = await connect(s, c, "2026-08-01", AUG_1, 30_000);
        await runBilling(s, "2026-09-01", SEP_1);
        await runBilling(s, "2026-10-01", OCT_1);
        const issued = await issuedSnapshot(s);
        const [sep, oct] = await billsOf(s, c);

        const done = await backDatedConnectionChange.call(s.rt(OCT_14), s.owner, {
          assignmentId: vc,
          effectiveDate: "2026-09-20",
          change: { kind: "suspend", stopReason: "customer_asked" },
          reason: "Box came back on 20 Sep",
        });
        expect(done.ok).toBe(true);
        expect(await adjustmentsOf(s, c)).toMatchObject([
          { period: "2026-10-01", direction: "credit", amount: 30_000, source: "plan_change" },
        ]);
        // Oldest first: the credit pays September, October stays owed.
        const { rows } = await t.current.admin.query<{ invoice_id: string; amount_paise: string }>(
          "SELECT invoice_id, amount_paise FROM allocations WHERE customer_id = $1",
          [c],
        );
        expect(rows).toEqual([{ invoice_id: sep?.id, amount_paise: "30000" }]);
        expect(oct).toBeDefined();
        expect(await balanceOf(c)).toEqual({ balance: 30_000, credit: 0 });
        await expectClean(s, [c], issued);

        await runBilling(s, "2026-11-01", NOV_1);
        expect(await billsOf(s, c)).toHaveLength(2);
      },
      TIMEOUT,
    );

    it(
      "start again back-dated: later billed months get their rent as an explicit adjustment, and billing the month again never adds a second charge",
      async () => {
        const s = await setupTenant(t.current);
        const c = await newCustomer(s, AUG_1);
        const vc = await connect(s, c, "2026-08-01", AUG_1, 30_000);
        const stopped = await suspendConnection.call(s.rt(AUG_20), s.staff, {
          assignmentId: vc,
          effectiveDate: "2026-08-20",
        });
        expect(stopped.ok).toBe(true);
        await runBilling(s, "2026-09-01", SEP_1);
        await runBilling(s, "2026-10-01", OCT_1);
        expect(await billsOf(s, c)).toEqual([]);
        const issued = await issuedSnapshot(s);

        const done = await backDatedConnectionChange.call(s.rt(OCT_14), s.owner, {
          assignmentId: vc,
          effectiveDate: "2026-09-10",
          change: { kind: "reactivate" },
          reason: "Was watching since 10 Sep",
        });
        expect(done.ok).toBe(true);
        // September follows the policy (start_next_month: nothing); October should have had rent.
        expect(await adjustmentsOf(s, c)).toMatchObject([
          { period: "2026-10-01", direction: "debit", amount: 30_000, source: "mid_month_start" },
        ]);
        // The Owner bills October again: one charge for October, as the adjustment line.
        await runBilling(s, "2026-10-01", OCT_14);
        await runBilling(s, "2026-10-01", OCT_14);
        expect(await billsOf(s, c)).toMatchObject([
          { period: "2026-10-01", charges: 30_000, lines: [{ type: "adjustment", amount: 30_000 }] },
        ]);
        await runBilling(s, "2026-11-01", NOV_1);
        expect((await billsOf(s, c))[1]).toMatchObject({
          period: "2026-11-01",
          charges: 30_000,
          lines: [{ type: "rent", assignmentId: vc }],
        });
        await expectClean(s, [c], issued);
      },
      TIMEOUT,
    );

    it(
      "a payment made in between keeps every book consistent (credit adjustment after a payment)",
      async () => {
        const s = await setupTenant(t.current);
        const c = await newCustomer(s, AUG_1);
        const vc = await connect(s, c, "2026-08-01", AUG_1, 30_000);
        await runBilling(s, "2026-09-01", SEP_1);
        await runBilling(s, "2026-10-01", OCT_1);
        const paid = await postPayment.call(s.rt(OCT_5), s.staff, {
          id: "01900000-0000-7000-8000-00000000c045",
          customerId: c,
          amountPaise: 40_000,
          method: "cash",
        });
        expect(paid.ok).toBe(true);
        const issued = await issuedSnapshot(s);
        const done = await backDatedConnectionChange.call(s.rt(OCT_14), s.owner, {
          assignmentId: vc,
          effectiveDate: "2026-09-10",
          change: { kind: "plan", rentalPaise: 20_000 },
          reason: "Cheaper pack since September",
        });
        expect(done.ok && done.value.totalPaise).toBe(-20_000);
        expect(await balanceOf(c)).toEqual({ balance: 0, credit: 0 });
        await expectClean(s, [c], issued);
      },
      TIMEOUT,
    );
  });
});

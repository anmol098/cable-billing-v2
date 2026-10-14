/**
 * PLAN §8.3 "back-dated effective date into an already-billed period" for a **new connection**
 * (T-045a), on a real database with the real services (T-033 customers, T-034 connections and
 * their T-045 hooks, T-044 billing run) and a fixed clock. After every scenario:
 * - no issued bill or bill line changed (D-14, RULE-10: `changedIssuedRows` is empty);
 * - every customer's books pass T-041 `checkLedger`;
 * - billing a month again adds nothing (no double charge, FR-008, PRD §15 #5).
 *
 * The Owner's add always sends the total its preview showed (as the web form does).
 */

import { auditEvents, billingRuns, vcAssets, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import type { MidMonthStartPolicy } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { startBillingRun } from "../../billing/services";
import { drainBillingJobs } from "../../billing/test-support";
import { addConnection, disconnectConnection, suspendConnection } from "../../connections/services";
import { addPlan, type ConnectionSetup } from "../../connections/test-support";
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
} from "../test-support";
import { backDatedAddConnection, previewAddConnection } from "./services";

const TIMEOUT = 180_000;

const AUG_1 = ist("2026-08-01");
const SEP_1 = ist("2026-09-01", "08:30");
const SEP_20 = ist("2026-09-20");
const OCT_1 = ist("2026-10-01", "08:30");
const OCT_14 = ist("2026-10-14");
const OCT_15 = ist("2026-10-15");
const OCT_20 = ist("2026-10-20");
const NOV_1 = ist("2026-11-01", "08:30");
const NOV_14 = ist("2026-11-14");
const NOV_15 = ist("2026-11-15");
const DEC_1 = ist("2026-12-01", "08:30");
const DEC_2 = ist("2026-12-02");

const POLICIES: readonly MidMonthStartPolicy[] = ["charge_full_month", "start_next_month"];
/** A cursor after every uuid: a run whose cursor has passed every customer. */
const LAST_CURSOR = "ffffffff-ffff-7fff-bfff-ffffffffffff";

let vcSeq = 0;
const newVc = () => {
  vcSeq += 1;
  return `BDA${String(vcSeq).padStart(3, "0")}${Math.floor(Math.random() * 1e7)}`;
};

interface AddInput {
  readonly customerId: string;
  readonly vcNumber: string;
  readonly rentalPaise: number;
  readonly startDate: string;
  readonly reason: string;
}

describeDb("T-045a: the Owner's back-dated new connection (PLAN §8.1, §8.3, D-18)", () => {
  const t = useTestDatabase();

  async function expectClean(
    s: ConnectionSetup,
    customers: readonly string[],
    issuedBefore: Awaited<ReturnType<typeof issuedSnapshot>>,
  ) {
    expect(changedIssuedRows(issuedBefore, await issuedSnapshot(s))).toEqual([]);
    expect(await ledgerProblems(s, customers)).toEqual({});
  }

  async function assignmentsOf(s: ConnectionSetup, customerId: string) {
    return s.tx((tx) =>
      tx.select().from(vcAssignments).where(eq(vcAssignments.customerId, customerId)),
    );
  }

  async function backDatedAudit(s: ConnectionSetup, assignmentId: string) {
    return s.tx((tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "adjustments.back_dated_change"),
            eq(auditEvents.entityId, assignmentId),
          ),
        ),
    );
  }

  /** The Owner's form: preview, then save with the previewed total. */
  async function ownerAdd(s: ConnectionSetup, now: Date, input: AddInput) {
    const preview = await previewAddConnection.call(s.rt(now), s.owner, {
      customerId: input.customerId,
      rentalPaise: input.rentalPaise,
      startDate: input.startDate,
    });
    if (!preview.ok) throw new Error(`preview: ${JSON.stringify(preview.error)}`);
    const done = await backDatedAddConnection.call(s.rt(now), s.owner, {
      ...input,
      expectedTotalPaise: preview.value.totalPaise,
    });
    return { preview: preview.value, done };
  }

  /** Σ of what the customer's bills charged the connection (rent lines + its adjustment lines). */
  async function chargedOnBills(s: ConnectionSetup, customerId: string, assignmentId: string) {
    const bills = await billsOf(s, customerId);
    return bills.flatMap((b) =>
      b.lines
        .filter((l) => l.assignmentId === assignmentId)
        .map((l) => [b.period, l.type, l.amount]),
    );
  }

  for (const policy of POLICIES) {
    it(
      `${policy}: a start dated two billed months back charges the start month per D-18 and each later billed month its full rent, once`,
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, policy);
        const ravi = await newCustomer(s, AUG_1, "Ravi");
        const first = await connect(s, ravi, "2026-08-01", AUG_1, 40_000);
        await runBilling(s, "2026-09-01", SEP_1);
        await runBilling(s, "2026-10-01", OCT_1);
        await runBilling(s, "2026-11-01", NOV_1);
        const issued = await issuedSnapshot(s);
        const ledgerBefore = await ledgerOf(s, ravi);
        const vcNumber = newVc();
        const add = { customerId: ravi, vcNumber, rentalPaise: 30_000, startDate: "2026-09-10" };
        const sepCharge = policy === "charge_full_month" ? 30_000 : 0;
        const total = 60_000 + sepCharge;

        // Staff: still refused by connections.add, and can't call the Owner's flow.
        const staffAdd = await addConnection.call(s.rt(NOV_14), s.staff, add);
        expect(!staffAdd.ok && staffAdd.error).toMatchObject({
          code: "CONFLICT",
          details: { reason: "billed_period", period: "2026-11-01", earliestDate: "2026-11-01" },
        });
        const staffFlow = await backDatedAddConnection.call(s.rt(NOV_14), s.staff, {
          ...add,
          reason: "Box fitted on 10 Sep",
          expectedTotalPaise: total,
        });
        expect(!staffFlow.ok && staffFlow.error.code).toBe("FORBIDDEN");
        // The reason is required (blank, or too short).
        for (const reason of ["   ", "ok"]) {
          const noReason = await backDatedAddConnection.call(s.rt(NOV_14), s.owner, {
            ...add,
            reason,
            expectedTotalPaise: total,
          });
          expect(!noReason.ok && noReason.error).toMatchObject({
            code: "VALIDATION",
            details: { fields: [{ path: "reason" }] },
          });
        }
        // A total other than what the add would charge (the Owner saw old numbers).
        const stale = await backDatedAddConnection.call(s.rt(NOV_14), s.owner, {
          ...add,
          reason: "Box fitted on 10 Sep",
          expectedTotalPaise: total - 30_000,
        });
        expect(!stale.ok && stale.error).toMatchObject({
          code: "CONFLICT",
          details: { reason: "preview_stale", totalPaise: total },
        });
        expect(await assignmentsOf(s, ravi)).toHaveLength(1);
        expect(await adjustmentsOf(s, ravi)).toEqual([]);

        // The preview (Owner or Staff) says it month by month before anything is saved.
        const preview = await previewAddConnection.call(s.rt(NOV_14), s.staff, {
          customerId: ravi,
          rentalPaise: 30_000,
          startDate: "2026-09-10",
        });
        expect(preview.ok && preview.value).toEqual({
          customerId: ravi,
          startDate: "2026-09-10",
          rentalPaise: 30_000,
          backDated: true,
          latestBilledPeriod: "2026-11-01",
          policy,
          months: [
            {
              period: "2026-09-01",
              scope: "change_month",
              outcome:
                policy === "charge_full_month"
                  ? { kind: "debit", amountPaise: 30_000 }
                  : { kind: "none", reason: "start_next_month" },
              chargedBeforePaise: 0,
              chargedAfterPaise: sepCharge,
            },
            {
              period: "2026-10-01",
              scope: "later_month",
              outcome: { kind: "debit", amountPaise: 30_000 },
              chargedBeforePaise: 0,
              chargedAfterPaise: 30_000,
            },
            {
              period: "2026-11-01",
              scope: "later_month",
              outcome: { kind: "debit", amountPaise: 30_000 },
              chargedBeforePaise: 0,
              chargedAfterPaise: 30_000,
            },
          ],
          totalPaise: total,
        });

        // The Owner adds it, with the reason.
        const reason = "Box fitted on 10 Sep, entered late";
        const { preview: shown, done } = await ownerAdd(s, NOV_14, { ...add, reason });
        expect(done.ok).toBe(true);
        if (!done.ok) return;
        const added = done.value.connection.assignmentId;
        expect(done.value.connection).toMatchObject({
          customerId: ravi,
          vcNumber,
          status: "active",
          rentalPaise: 30_000,
          startDate: "2026-09-10",
        });
        // What the preview said is what was done.
        expect(done.value.months).toEqual(shown.months);
        expect(done.value.totalPaise).toBe(shown.totalPaise);

        const expected = [
          ...(policy === "charge_full_month" ? [["2026-09-01", 30_000]] : []),
          ["2026-10-01", 30_000],
          ["2026-11-01", 30_000],
        ];
        const made = await adjustmentsOf(s, ravi);
        expect(made.map((a) => [a.period, a.amount])).toEqual(expected);
        for (const a of made) {
          expect(a).toMatchObject({
            assignmentId: added,
            direction: "debit",
            source: "mid_month_start",
            reason,
            invoiceId: null,
            createdBy: s.owner.userId,
          });
        }
        expect(done.value.adjustments.map((a) => a.id)).toEqual(made.map((a) => a.id));

        // One audit event ties them together (besides connections.add and adjustments.create).
        const audit = await backDatedAudit(s, added);
        expect(audit).toHaveLength(1);
        expect(audit[0]?.after).toMatchObject({
          kind: "start",
          effectiveDate: "2026-09-10",
          reason,
          eventId: done.value.eventId,
          adjustmentIds: made.map((a) => a.id),
          totalPaise: total,
        });

        // Debits wait for the next bill: nothing reached the ledger; no issued bill changed.
        expect(await ledgerOf(s, ravi)).toEqual(ledgerBefore);
        await expectClean(s, [ravi], issued);

        // Sending the same add again (a second click) saves nothing more.
        const again = await backDatedAddConnection.call(s.rt(NOV_14), s.owner, {
          ...add,
          reason,
          expectedTotalPaise: total,
        });
        expect(!again.ok && again.error.details).toMatchObject({
          reason: "vc_in_use",
          sameCustomer: true,
        });
        expect(await adjustmentsOf(s, ravi)).toEqual(made);

        // Billing September, October and November again adds nothing.
        const bills = await billsOf(s, ravi);
        for (const period of ["2026-09-01", "2026-10-01", "2026-11-01"]) {
          await runBilling(s, period, NOV_15);
        }
        expect(await billsOf(s, ravi)).toEqual(bills);
        expect(await adjustmentsOf(s, ravi)).toEqual(made);
        await expectClean(s, [ravi], issued);

        // December: both rents, plus the waiting bill changes, once.
        await runBilling(s, "2026-12-01", DEC_1);
        const dec = (await billsOf(s, ravi)).find((b) => b.period === "2026-12-01");
        expect(dec).toMatchObject({
          charges: 70_000 + total,
          lines: [
            ...expected.map(() => ({ type: "adjustment", assignmentId: added, amount: 30_000 })),
            { type: "rent", assignmentId: added, amount: 30_000 },
            { type: "rent", assignmentId: first, amount: 40_000 },
          ],
        });
        const afterDec = await issuedSnapshot(s);
        await runBilling(s, "2026-12-01", DEC_2);
        await expectClean(s, [ravi], afterDec);
        expect((await billsOf(s, ravi)).filter((b) => b.period === "2026-12-01")).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      `${policy}: a later month the run skipped (nothing to bill) still gets its rent, and billing it again never charges twice`,
      async () => {
        const s = await setupTenant(t.current);
        await setPolicy(t.current, s.op, policy);
        const sita = await newCustomer(s, AUG_1, "Sita");
        const old = await connect(s, sita, "2026-08-01", AUG_1, 30_000);
        await runBilling(s, "2026-09-01", SEP_1);
        const stopped = await suspendConnection.call(s.rt(SEP_20), s.staff, {
          assignmentId: old,
          effectiveDate: "2026-09-20",
        });
        expect(stopped.ok).toBe(true);
        // October and November: the run looked at Sita and found nothing to bill (skipped).
        await runBilling(s, "2026-10-01", OCT_1);
        await runBilling(s, "2026-11-01", NOV_1);
        expect((await billsOf(s, sita)).map((b) => b.period)).toEqual(["2026-09-01"]);
        const issued = await issuedSnapshot(s);

        const { done } = await ownerAdd(s, NOV_14, {
          customerId: sita,
          vcNumber: newVc(),
          rentalPaise: 25_000,
          startDate: "2026-09-25",
          reason: "New box since 25 Sep",
        });
        expect(done.ok).toBe(true);
        if (!done.ok) return;
        const added = done.value.connection.assignmentId;
        const sepCharge = policy === "charge_full_month" ? 25_000 : 0;
        expect(done.value.months.map((m) => [m.period, m.scope, m.outcome])).toEqual([
          [
            "2026-09-01",
            "change_month",
            policy === "charge_full_month"
              ? { kind: "debit", amountPaise: 25_000 }
              : { kind: "none", reason: "start_next_month" },
          ],
          ["2026-10-01", "later_month", { kind: "debit", amountPaise: 25_000 }],
          ["2026-11-01", "later_month", { kind: "debit", amountPaise: 25_000 }],
        ]);
        expect(done.value.totalPaise).toBe(50_000 + sepCharge);
        await expectClean(s, [sita], issued);

        // The Owner bills October and November again (twice each): each month charges the new
        // connection once, as its adjustment line (T-044's guard: no rent line as well).
        for (const period of ["2026-10-01", "2026-11-01"]) {
          await runBilling(s, period, NOV_15);
          await runBilling(s, period, NOV_15);
        }
        const bills = await billsOf(s, sita);
        expect(bills.map((b) => [b.period, b.charges])).toEqual([
          ["2026-09-01", 30_000],
          // October's bill takes every waiting debit up to October (September's too).
          ["2026-10-01", 25_000 + sepCharge],
          ["2026-11-01", 25_000],
        ]);
        for (const bill of bills.slice(1)) {
          expect(bill.lines.every((l) => l.type === "adjustment" && l.assignmentId === added)).toBe(
            true,
          );
        }
        await expectClean(s, [sita], issued);

        // December: the rent line of the new connection only (the old one is stopped).
        await runBilling(s, "2026-12-01", DEC_1);
        expect((await billsOf(s, sita)).at(-1)).toMatchObject({
          period: "2026-12-01",
          charges: 25_000,
          lines: [{ type: "rent", assignmentId: added, amount: 25_000 }],
        });
        expect(await ledgerProblems(s, [sita])).toEqual({});
      },
      TIMEOUT,
    );
  }

  it(
    "a later month whose run completed without the customer is charged too (the run never comes back)",
    async () => {
      const s = await setupTenant(t.current);
      await setPolicy(t.current, s.op, "charge_full_month");
      const ravi = await newCustomer(s, AUG_1, "Ravi");
      const first = await connect(s, ravi, "2026-08-01", AUG_1, 40_000);
      await runBilling(s, "2026-09-01", SEP_1);
      await runBilling(s, "2026-10-01", OCT_1);
      const removed = await disconnectConnection.call(s.rt(OCT_20), s.staff, {
        assignmentId: first,
        effectiveDate: "2026-10-20",
        reason: "moved_away",
      });
      expect(removed.ok).toBe(true);
      // November's run completes and never looks at Ravi (no connection on 1 Nov).
      await runBilling(s, "2026-11-01", NOV_1);
      const { rows: items } = await t.current.admin.query(
        `SELECT 1 FROM billing_run_items i JOIN billing_runs r ON r.id = i.run_id
          WHERE i.customer_id = $1 AND r.period = '2026-11-01'`,
        [ravi],
      );
      expect(items).toEqual([]);
      const issued = await issuedSnapshot(s);

      const { preview, done } = await ownerAdd(s, NOV_14, {
        customerId: ravi,
        vcNumber: newVc(),
        rentalPaise: 30_000,
        startDate: "2026-09-10",
        reason: "Second TV since 10 Sep",
      });
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      const added = done.value.connection.assignmentId;
      expect(preview.latestBilledPeriod).toBe("2026-11-01");
      expect(done.value.months.map((m) => [m.period, m.outcome])).toEqual([
        ["2026-09-01", { kind: "debit", amountPaise: 30_000 }],
        ["2026-10-01", { kind: "debit", amountPaise: 30_000 }],
        ["2026-11-01", { kind: "debit", amountPaise: 30_000 }],
      ]);
      expect(done.value.totalPaise).toBe(90_000);
      await expectClean(s, [ravi], issued);

      // The Owner re-runs November (twice), then December: every month charged exactly once.
      await runBilling(s, "2026-11-01", NOV_15);
      await runBilling(s, "2026-11-01", NOV_15);
      await runBilling(s, "2026-12-01", DEC_1);
      await runBilling(s, "2026-12-01", DEC_2);
      expect(await chargedOnBills(s, ravi, added)).toEqual([
        ["2026-11-01", "adjustment", 30_000],
        ["2026-11-01", "adjustment", 30_000],
        ["2026-11-01", "adjustment", 30_000],
        ["2026-12-01", "rent", 30_000],
      ]);
      await expectClean(s, [ravi], issued);
    },
    TIMEOUT,
  );

  it(
    "a later month whose run is in progress and already past the customer is charged by the adjustment, once",
    async () => {
      const s = await setupTenant(t.current);
      await setPolicy(t.current, s.op, "start_next_month");
      const ravi = await newCustomer(s, AUG_1, "Ravi");
      const first = await connect(s, ravi, "2026-08-01", AUG_1, 40_000);
      await runBilling(s, "2026-09-01", SEP_1);
      await runBilling(s, "2026-10-01", OCT_1);
      const removed = await disconnectConnection.call(s.rt(OCT_20), s.staff, {
        assignmentId: first,
        effectiveDate: "2026-10-20",
        reason: "moved_away",
      });
      expect(removed.ok).toBe(true);
      // November's run is running and its cursor is already past every customer.
      const started = await startBillingRun.call(s.rt(NOV_1), s.owner, { period: "2026-11-01" });
      expect(started.ok).toBe(true);
      const runId = started.ok ? started.value.run.id : "";
      await t.current.admin.query("UPDATE billing_runs SET status = 'running' WHERE id = $1", [
        runId,
      ]);
      await t.current.admin.query(
        `UPDATE jobs SET payload = payload || jsonb_build_object('cursor', $2::text)
          WHERE payload ->> 'runId' = $1`,
        [runId, LAST_CURSOR],
      );
      const issued = await issuedSnapshot(s);

      const { done } = await ownerAdd(s, NOV_14, {
        customerId: ravi,
        vcNumber: newVc(),
        rentalPaise: 30_000,
        startDate: "2026-09-10",
        reason: "Second TV since 10 Sep",
      });
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      const added = done.value.connection.assignmentId;
      expect(done.value.months.map((m) => [m.period, m.outcome.kind])).toEqual([
        ["2026-09-01", "none"],
        ["2026-10-01", "debit"],
        ["2026-11-01", "debit"],
      ]);

      // The run finishes without Ravi; December's bill takes October's and November's debits.
      await drainBillingJobs(s.db, () => NOV_15);
      const [run] = await s.tx((tx) =>
        tx.select().from(billingRuns).where(eq(billingRuns.id, runId)),
      );
      expect(run?.status).toBe("completed");
      await runBilling(s, "2026-12-01", DEC_1);
      expect(await chargedOnBills(s, ravi, added)).toEqual([
        ["2026-12-01", "adjustment", 30_000],
        ["2026-12-01", "adjustment", 30_000],
        ["2026-12-01", "rent", 30_000],
      ]);
      await expectClean(s, [ravi], issued);
    },
    TIMEOUT,
  );

  it(
    "a later month whose run was missed (no run at all) gets no adjustment: its own run bills the connection, once",
    async () => {
      const s = await setupTenant(t.current);
      await setPolicy(t.current, s.op, "charge_full_month");
      const c = await newCustomer(s, AUG_1, "Gita");
      const first = await connect(s, c, "2026-08-01", AUG_1, 40_000);
      await runBilling(s, "2026-09-01", SEP_1);
      // No October run (missed); November ran.
      await runBilling(s, "2026-11-01", NOV_1);
      const issued = await issuedSnapshot(s);

      const { preview, done } = await ownerAdd(s, NOV_14, {
        customerId: c,
        vcNumber: newVc(),
        rentalPaise: 20_000,
        startDate: "2026-09-10",
        reason: "Second TV since September",
      });
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      const added = done.value.connection.assignmentId;
      expect(done.value.months).toEqual(preview.months);
      // September (D-18) and November (billed); October has no run yet, so it is left alone.
      expect(done.value.months.map((m) => [m.period, m.outcome])).toEqual([
        ["2026-09-01", { kind: "debit", amountPaise: 20_000 }],
        ["2026-11-01", { kind: "debit", amountPaise: 20_000 }],
      ]);
      await expectClean(s, [c], issued);

      // The Owner runs the missed October: the new connection's October rent is a rent line.
      await runBilling(s, "2026-10-01", NOV_15);
      await runBilling(s, "2026-10-01", NOV_15);
      const oct = (await billsOf(s, c)).filter((b) => b.period === "2026-10-01");
      expect(oct).toHaveLength(1);
      expect(oct[0]?.lines.filter((l) => l.assignmentId === added)).toEqual([
        // September's waiting debit goes on the first bill made after it …
        expect.objectContaining({ type: "adjustment", amount: 20_000 }),
        // … and October is charged by the bill itself.
        expect.objectContaining({ type: "rent", amount: 20_000 }),
      ]);
      expect(oct[0]?.lines.filter((l) => l.assignmentId === first)).toHaveLength(1);
      await expectClean(s, [c], issued);

      // December: rent for both, plus November's waiting debit. Each month charged once.
      await runBilling(s, "2026-12-01", DEC_1);
      const dec = (await billsOf(s, c)).find((b) => b.period === "2026-12-01");
      expect(dec?.lines.filter((l) => l.assignmentId === added)).toEqual([
        expect.objectContaining({ type: "adjustment", amount: 20_000 }),
        expect.objectContaining({ type: "rent", amount: 20_000 }),
      ]);
      const made = await adjustmentsOf(s, c);
      expect(made.map((a) => [a.period, a.invoiceId !== null])).toEqual([
        ["2026-09-01", true],
        ["2026-11-01", true],
      ]);
      expect(await ledgerProblems(s, [c])).toEqual({});
    },
    TIMEOUT,
  );

  it(
    "a start on the 1st of a billed month is charged that month's full rent whatever the D-18 policy (PLAN §8.1)",
    async () => {
      const s = await setupTenant(t.current);
      await setPolicy(t.current, s.op, "start_next_month");
      const c = await newCustomer(s, AUG_1, "Mohan");
      await connect(s, c, "2026-08-01", AUG_1, 40_000);
      await runBilling(s, "2026-10-01", OCT_1);
      await runBilling(s, "2026-11-01", NOV_1);
      const issued = await issuedSnapshot(s);
      const { preview, done } = await ownerAdd(s, NOV_14, {
        customerId: c,
        vcNumber: newVc(),
        rentalPaise: 30_000,
        startDate: "2026-10-01",
        reason: "Started on 1 Oct, entered late",
      });
      expect(done.ok && done.value.months.map((m) => [m.period, m.scope, m.outcome])).toEqual([
        ["2026-10-01", "change_month", { kind: "debit", amountPaise: 30_000 }],
        ["2026-11-01", "later_month", { kind: "debit", amountPaise: 30_000 }],
      ]);
      expect(done.ok && done.value.months).toEqual(preview.months);
      await expectClean(s, [c], issued);
    },
    TIMEOUT,
  );

  it(
    "a start on the 1st of a month the run skipped (start_next_month): billing that month again charges it exactly once",
    async () => {
      const s = await setupTenant(t.current);
      await setPolicy(t.current, s.op, "start_next_month");
      const c = await newCustomer(s, AUG_1, "Asha");
      const old = await connect(s, c, "2026-08-01", AUG_1, 30_000);
      await runBilling(s, "2026-09-01", SEP_1);
      const stopped = await suspendConnection.call(s.rt(SEP_20), s.staff, {
        assignmentId: old,
        effectiveDate: "2026-09-20",
      });
      expect(stopped.ok).toBe(true);
      // October: the run looked at Asha and found nothing to bill (skipped item).
      await runBilling(s, "2026-10-01", OCT_1);
      expect((await billsOf(s, c)).map((b) => b.period)).toEqual(["2026-09-01"]);
      const issued = await issuedSnapshot(s);

      const { done } = await ownerAdd(s, OCT_14, {
        customerId: c,
        vcNumber: newVc(),
        rentalPaise: 25_000,
        startDate: "2026-10-01",
        reason: "New box since 1 Oct",
      });
      expect(done.ok && done.value.months.map((m) => [m.period, m.outcome])).toEqual([
        ["2026-10-01", { kind: "debit", amountPaise: 25_000 }],
      ]);
      if (!done.ok) return;
      const added = done.value.connection.assignmentId;

      // The Owner bills October again (twice): one ₹250 charge for October in total.
      await runBilling(s, "2026-10-01", OCT_15);
      await runBilling(s, "2026-10-01", OCT_15);
      await runBilling(s, "2026-11-01", NOV_1);
      expect(await chargedOnBills(s, c, added)).toEqual([
        ["2026-10-01", "adjustment", 25_000],
        ["2026-11-01", "rent", 25_000],
      ]);
      await expectClean(s, [c], issued);
    },
    TIMEOUT,
  );

  it(
    "an ordinary start day is refused by the Owner's flow (no back-dated audit event); connections.add takes it",
    async () => {
      const s = await setupTenant(t.current);
      const c = await newCustomer(s, AUG_1, "Ramu");
      await connect(s, c, "2026-08-01", AUG_1, 40_000);
      await runBilling(s, "2026-11-01", NOV_1);
      const input = {
        customerId: c,
        vcNumber: newVc(),
        rentalPaise: 30_000,
        startDate: "2026-11-10",
      };
      const preview = await previewAddConnection.call(s.rt(NOV_14), s.owner, input);
      expect(preview.ok && preview.value).toMatchObject({
        backDated: false,
        months: [{ period: "2026-11-01", scope: "change_month" }],
      });
      const refused = await backDatedAddConnection.call(s.rt(NOV_14), s.owner, {
        ...input,
        reason: "Not back-dated at all",
        expectedTotalPaise: preview.ok ? preview.value.totalPaise : 0,
      });
      expect(!refused.ok && refused.error).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "startDate", code: "not_back_dated" }] },
      });
      expect(await assignmentsOf(s, c)).toHaveLength(1);
      const audits = await s.tx((tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "adjustments.back_dated_change")),
      );
      expect(audits).toEqual([]);
      const plain = await addConnection.call(s.rt(NOV_14), s.owner, input);
      expect(plain.ok).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "refuses what connections.add refuses, with nothing written (another tenant's plan with the Owner's own customer too)",
    async () => {
      const s = await setupTenant(t.current);
      const other = await setupTenant(t.current);
      const otherPlan = await addPlan(other, "Other business plan", 20_000);
      const c = await newCustomer(s, AUG_1, "Kamla");
      await connect(s, c, "2026-08-01", AUG_1, 40_000);
      await runBilling(s, "2026-10-01", OCT_1);
      await runBilling(s, "2026-11-01", NOV_1);
      const base = { customerId: c, reason: "Entered late", expectedTotalPaise: 30_000 };

      const future = await backDatedAddConnection.call(s.rt(NOV_14), s.owner, {
        ...base,
        rentalPaise: 30_000,
        vcNumber: newVc(),
        startDate: "2026-11-20",
      });
      expect(!future.ok && future.error.details).toMatchObject({
        fields: [{ path: "startDate", code: "in_future" }],
      });
      const futurePreview = await previewAddConnection.call(s.rt(NOV_14), s.owner, {
        customerId: c,
        rentalPaise: 30_000,
        startDate: "2026-11-20",
      });
      expect(!futurePreview.ok && futurePreview.error.details).toMatchObject({
        fields: [{ path: "startDate", code: "in_future" }],
      });
      const bothRents = await previewAddConnection.call(s.rt(NOV_14), s.owner, {
        customerId: c,
        rentalPaise: 30_000,
        planId: "01900000-0000-7000-8000-000000000001",
        startDate: "2026-10-10",
      });
      expect(!bothRents.ok && bothRents.error.code).toBe("VALIDATION");
      const lineman = await previewAddConnection.call(s.rt(NOV_14), s.lineman, {
        customerId: c,
        rentalPaise: 30_000,
        startDate: "2026-10-10",
      });
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
      // The Owner's own customer with another business's plan: NOT_FOUND, nothing written.
      const foreignPlan = await backDatedAddConnection.call(s.rt(NOV_14), s.owner, {
        ...base,
        planId: otherPlan,
        vcNumber: newVc(),
        startDate: "2026-10-10",
      });
      expect(!foreignPlan.ok && foreignPlan.error.code).toBe("NOT_FOUND");
      const foreignPreview = await previewAddConnection.call(s.rt(NOV_14), s.owner, {
        customerId: c,
        planId: otherPlan,
        startDate: "2026-10-10",
      });
      expect(!foreignPreview.ok && foreignPreview.error.code).toBe("NOT_FOUND");
      // The same VC on the same days as the existing connection.
      const [existing] = await assignmentsOf(s, c);
      const taken = await s.tx(async (tx) => {
        const [asset] = await tx
          .select()
          .from(vcAssets)
          .where(eq(vcAssets.id, existing?.vcAssetId ?? ""));
        return asset?.vcNumber ?? "";
      });
      const inUse = await backDatedAddConnection.call(s.rt(NOV_14), s.owner, {
        ...base,
        rentalPaise: 30_000,
        vcNumber: taken,
        startDate: "2026-10-10",
      });
      expect(!inUse.ok && inUse.error.details).toMatchObject({ reason: "vc_in_use" });
      expect(await assignmentsOf(s, c)).toHaveLength(1);
      expect(await adjustmentsOf(s, c)).toEqual([]);
    },
    TIMEOUT,
  );
});

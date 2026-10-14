/**
 * The Owner's manual bill changes, the bill changes list, the preview's refusals and the
 * "Start again" charged months (T-045). Real database, fixed clock.
 */
import { auditEvents, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { changeConnectionPlan, suspendConnection } from "../connections/services";
import { setSubscriptionStatus } from "../testing/fixtures";
import {
  connectionChargedMonths,
  createManualAdjustment,
  listAdjustments,
  previewConnectionChange,
} from "./services";
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
const SEP_1 = ist("2026-09-01", "08:30");
const OCT_1 = ist("2026-10-01", "08:30");
const OCT_10 = ist("2026-10-10");
const OCT_12 = ist("2026-10-12");
const NOV_1 = ist("2026-11-01", "08:30");

describeDb("manual adjustments and the bill changes list", () => {
  const t = useTestDatabase();

  it(
    "Owner debit waits for the next bill; Owner credit pays the oldest open bill at once",
    async () => {
      const s = await setupTenant(t.current);
      const c = await newCustomer(s, AUG_1);
      const vc = await connect(s, c, "2026-08-01", AUG_1, 30_000);
      await runBilling(s, "2026-09-01", SEP_1);
      await runBilling(s, "2026-10-01", OCT_1);
      const issued = await issuedSnapshot(s);
      const [sep, oct] = await billsOf(s, c);

      const debitId = uuidv7();
      const debit = await createManualAdjustment.call(s.rt(OCT_10), s.owner, {
        id: debitId,
        customerId: c,
        direction: "debit",
        amountPaise: 5_000,
        reason: "  Repair visit  ",
        assignmentId: vc,
      });
      expect(debit.ok && debit.value).toMatchObject({
        outcome: "created",
        creditAppliedPaise: 0,
        adjustment: {
          id: debitId,
          source: "manual",
          direction: "debit",
          amountPaise: 5_000,
          reason: "Repair visit",
          assignmentId: vc,
          period: null,
          invoiceId: null,
          createdBy: s.owner.userId,
        },
      });
      // Sent again (a double tap, a retry): saved once.
      const again = await createManualAdjustment.call(s.rt(OCT_10), s.owner, {
        id: debitId,
        customerId: c,
        direction: "debit",
        amountPaise: 5_000,
        reason: "Repair visit",
        assignmentId: vc,
      });
      expect(again.ok && again.value.outcome).toBe("duplicate");
      const reused = await createManualAdjustment.call(s.rt(OCT_10), s.owner, {
        id: debitId,
        customerId: c,
        direction: "debit",
        amountPaise: 6_000,
        reason: "Repair visit",
      });
      expect(!reused.ok && reused.error.details).toMatchObject({ reason: "id_reused" });

      const credit = await createManualAdjustment.call(s.rt(OCT_12), s.owner, {
        id: uuidv7(),
        customerId: c,
        direction: "credit",
        amountPaise: 40_000,
        reason: "Cable cut for 10 days",
      });
      expect(credit.ok && credit.value.creditAppliedPaise).toBe(40_000);
      // Oldest first: September paid in full, October partly.
      const { rows } = await t.current.admin.query<{ invoice_id: string; amount_paise: string }>(
        "SELECT invoice_id, amount_paise FROM allocations WHERE customer_id = $1 ORDER BY amount_paise DESC",
        [c],
      );
      expect(rows).toEqual([
        { invoice_id: sep?.id, amount_paise: "30000" },
        { invoice_id: oct?.id, amount_paise: "10000" },
      ]);
      expect(await ledgerOf(s, c)).toEqual([
        { type: "invoice", amount: 30_000 },
        { type: "invoice", amount: 30_000 },
        { type: "credit_adjustment", amount: -40_000 },
      ]);
      expect(await adjustmentsOf(s, c)).toHaveLength(2);
      const audits = await s.tx((tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.action, "adjustments.create"), eq(auditEvents.actorId, s.owner.userId))),
      );
      expect(audits).toHaveLength(2);
      expect(changedIssuedRows(issued, await issuedSnapshot(s))).toEqual([]);
      expect(await ledgerProblems(s, [c])).toEqual({});

      await runBilling(s, "2026-11-01", NOV_1);
      const nov = (await billsOf(s, c))[2];
      expect(nov).toMatchObject({
        period: "2026-11-01",
        opening: 20_000,
        charges: 35_000,
        lines: [
          { type: "adjustment", adjustmentId: debitId, amount: 5_000 },
          { type: "rent", assignmentId: vc, amount: 30_000 },
        ],
      });
      expect(await ledgerProblems(s, [c])).toEqual({});

      // The list: newest first, states, the bill number of a billed debit, who made it.
      const list = await listAdjustments.call(s.rt(NOV_1), s.staff, {});
      expect(list.ok && list.value).toMatchObject({
        page: 1,
        hasMore: false,
        pendingDebitPaise: 0,
        rows: [
          {
            direction: "credit",
            state: "credit",
            amountPaise: 40_000,
            creditUsedPaise: 40_000,
            createdByName: expect.any(String),
          },
          {
            id: debitId,
            state: "billed",
            invoiceId: nov?.id,
            invoiceNumber: expect.stringMatching(/^INV-2611-/),
            vcNumber: expect.any(String),
          },
        ],
      });
      const credits = await listAdjustments.call(s.rt(NOV_1), s.owner, { state: "credit" });
      expect(credits.ok && credits.value.rows).toHaveLength(1);
      const manual = await listAdjustments.call(s.rt(NOV_1), s.owner, {
        source: "plan_change",
        customerId: c,
      });
      expect(manual.ok && manual.value.rows).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "refuses without a reason, for Staff and Linemen, for another customer's connection, and in read-only mode",
    async () => {
      const s = await setupTenant(t.current);
      const c = await newCustomer(s, AUG_1);
      const other = await newCustomer(s, AUG_1);
      const otherVc = await connect(s, other, "2026-08-01", AUG_1);
      const base = { customerId: c, direction: "debit" as const, amountPaise: 1_000 };

      const noReason = await createManualAdjustment.call(s.rt(OCT_10), s.owner, {
        ...base,
        id: uuidv7(),
        reason: "  ",
      });
      expect(!noReason.ok && noReason.error).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "reason" }] },
      });
      const zero = await createManualAdjustment.call(s.rt(OCT_10), s.owner, {
        ...base,
        id: uuidv7(),
        amountPaise: 0,
        reason: "Zero",
      });
      expect(!zero.ok && zero.error.code).toBe("VALIDATION");
      for (const ctx of [s.staff, s.lineman]) {
        const refused = await createManualAdjustment.call(s.rt(OCT_10), ctx, {
          ...base,
          id: uuidv7(),
          reason: "Not allowed",
        });
        expect(!refused.ok && refused.error.code).toBe("FORBIDDEN");
      }
      const wrongVc = await createManualAdjustment.call(s.rt(OCT_10), s.owner, {
        ...base,
        id: uuidv7(),
        reason: "Wrong connection",
        assignmentId: otherVc,
      });
      expect(!wrongVc.ok && wrongVc.error.code).toBe("NOT_FOUND");

      await setSubscriptionStatus(t.current, s.op, "read_only");
      const readOnly = await createManualAdjustment.call(s.rt(OCT_10), s.owner, {
        ...base,
        id: uuidv7(),
        reason: "Read only",
      });
      expect(!readOnly.ok && readOnly.error.code).toBe("TENANT_READ_ONLY");
      // Reads still work in read-only mode.
      const list = await listAdjustments.call(s.rt(OCT_10), s.owner, {});
      expect(list.ok && list.value.rows).toEqual([]);
      expect(await adjustmentsOf(s, c)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "the preview refuses what the change would refuse, and says when nothing changes",
    async () => {
      const s = await setupTenant(t.current);
      const c = await newCustomer(s, AUG_1);
      const vc = await connect(s, c, "2026-08-01", AUG_1, 30_000);
      const at = s.rt(OCT_10);
      const preview = (input: Parameters<typeof previewConnectionChange.call>[2]) =>
        previewConnectionChange.call(at, s.staff, input);

      const same = await preview({
        assignmentId: vc,
        effectiveDate: "2026-10-10",
        change: { kind: "plan", rentalPaise: 30_000 },
      });
      expect(same.ok && same.value).toMatchObject({ noChange: true, months: [], totalPaise: 0 });
      const future = await preview({
        assignmentId: vc,
        effectiveDate: "2026-10-11",
        change: { kind: "plan", rentalPaise: 40_000 },
      });
      expect(!future.ok && future.error.details).toMatchObject({
        fields: [{ path: "effectiveDate", code: "in_future" }],
      });
      const restart = await preview({
        assignmentId: vc,
        effectiveDate: "2026-10-10",
        change: { kind: "reactivate" },
      });
      expect(!restart.ok && restart.error.details).toMatchObject({ reason: "invalid_transition" });
      const noPlan = await preview({
        assignmentId: vc,
        effectiveDate: "2026-10-10",
        change: { kind: "plan" },
      });
      expect(!noPlan.ok && noPlan.error.code).toBe("VALIDATION");
      const unknown = await preview({
        assignmentId: uuidv7(),
        effectiveDate: "2026-10-10",
        change: { kind: "suspend" },
      });
      expect(!unknown.ok && unknown.error.code).toBe("NOT_FOUND");
      const lineman = await previewConnectionChange.call(at, s.lineman, {
        assignmentId: vc,
        effectiveDate: "2026-10-10",
        change: { kind: "suspend" },
      });
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
    },
    TIMEOUT,
  );

  it(
    "charged months tell the Connections tab when a start again would add rent",
    async () => {
      const s = await setupTenant(t.current);
      await setPolicy(t.current, s.op, "charge_full_month");
      const c = await newCustomer(s, AUG_1);
      const billedVc = await connect(s, c, "2026-09-01", SEP_1, 30_000);
      const freeVc = await connect(s, c, "2026-09-01", SEP_1, 0);
      await runBilling(s, "2026-10-01", OCT_1);
      const stopped = await suspendConnection.call(s.rt(OCT_10), s.staff, {
        assignmentId: billedVc,
        effectiveDate: "2026-10-10",
      });
      expect(stopped.ok).toBe(true);
      const charged = await connectionChargedMonths.call(s.rt(OCT_12), s.staff, {
        customerId: c,
      });
      expect(charged.ok && charged.value).toEqual({
        policy: "charge_full_month",
        charged: { [billedVc]: ["2026-10-01"], [freeVc]: [] },
      });
      const preview = await previewConnectionChange.call(s.rt(OCT_12), s.staff, {
        assignmentId: billedVc,
        effectiveDate: "2026-10-12",
        change: { kind: "reactivate" },
      });
      expect(preview.ok && preview.value.months).toMatchObject([
        { outcome: { kind: "none", reason: "already_charged" } },
      ]);
      const changed = await changeConnectionPlan.call(s.rt(OCT_12), s.staff, {
        assignmentId: freeVc,
        effectiveDate: "2026-10-12",
        rentalPaise: 10_000,
      });
      expect(changed.ok).toBe(true);
      // The ₹0 rent line nets up to ₹100 (T-042 Q-4: billed at ₹0 nets normally).
      expect(await adjustmentsOf(s, c)).toMatchObject([
        { assignmentId: freeVc, direction: "debit", amount: 10_000, source: "plan_change" },
      ]);
      expect(await ledgerProblems(s, [c])).toEqual({});
    },
    TIMEOUT,
  );
});

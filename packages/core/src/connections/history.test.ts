/**
 * Connections and the bills (T-034) with the real billing run (T-044):
 * - **VC reuse** (PRD §15 #6, RULE-07, BR-04, J-06): a removed VC goes to a new customer as a new
 *   assignment; the old assignment, its bill lines and payments stay with the old customer, and
 *   nothing old is charged to the new one.
 * - **Back-dating** (PLAN §8.3): a date that reaches back into a billed month is refused for
 *   Staff (and, until T-045's guided flow, for the Owner); dates in the billed month itself or
 *   later are fine; a customer the run never looked at has no billed month.
 */
import { invoiceLines, invoices, uuidv7, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineService } from "../context/service";
import { postPayment } from "../payments/post-payment";
import { readLedgerState } from "../payments/test-support";
import { listConnections } from "./queries";
import {
  addConnection,
  changeConnectionPlan,
  changeStatusInTx,
  disconnectConnection,
  reactivateConnection,
  suspendConnection,
} from "./services";
import { type ConnectionSetup, ist, newCustomer, runBilling, setupTenant } from "./test-support";

const SEP_1 = ist("2026-09-01");
const SEP_5 = ist("2026-09-05");
const SEP_10 = ist("2026-09-10");
const OCT_1 = ist("2026-10-01", "08:30");
const OCT_13 = ist("2026-10-13");
const NOV_1 = ist("2026-11-01", "08:30");

/** Test-only stand-in for T-045's Owner flow: the same change with `allowBilledPeriod`. */
const ownerBackdatedSuspend = defineService({
  name: "test.owner_backdated_suspend",
  capability: "adjustments.manage",
  input: z.object({ assignmentId: z.uuid(), effectiveDate: z.string() }),
  async run({ input, tx, ...env }) {
    return changeStatusInTx(
      tx,
      env,
      {
        assignmentId: input.assignmentId,
        action: "suspend",
        effectiveDate: input.effectiveDate as never,
      },
      { allowBilledPeriod: true },
    );
  },
});

describeDb("connections and bills", () => {
  const t = useTestDatabase();

  async function connect(
    s: ConnectionSetup,
    customerId: string,
    vcNumber: string,
    startDate: string,
    now: Date,
  ): Promise<string> {
    const result = await addConnection.call(s.rt(now), s.staff, {
      customerId,
      vcNumber,
      rentalPaise: 30_000,
      startDate,
    });
    if (!result.ok) throw new Error(`addConnection: ${JSON.stringify(result.error)}`);
    return result.value.connection.assignmentId;
  }

  async function billsOf(s: ConnectionSetup, customerId: string) {
    return s.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.customerId, customerId))
        .orderBy(asc(invoices.period));
      const result = [];
      for (const invoice of rows) {
        const lines = await tx
          .select()
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, invoice.id))
          .orderBy(asc(invoiceLines.id));
        result.push({
          period: invoice.period,
          opening: invoice.openingBalancePaise,
          charges: invoice.chargesPaise,
          lines: lines.map((l) => ({
            type: l.type,
            assignmentId: l.assignmentId,
            amount: l.amountPaise,
          })),
        });
      }
      return result;
    });
  }

  it("a removed VC goes to a new customer without moving any old charge or payment", async () => {
    const s = await setupTenant(t.current);
    const ramesh = await newCustomer(s, SEP_1, "Ramesh");
    const suresh = await newCustomer(s, SEP_1, "Suresh");
    const first = await connect(s, ramesh, "5550 0011", "2026-09-01", SEP_1);

    await runBilling(s, "2026-10-01", OCT_1);
    const paid = await postPayment.call(s.rt(OCT_13), s.staff, {
      id: uuidv7(),
      customerId: ramesh,
      amountPaise: 10_000,
      method: "cash",
    });
    expect(paid.ok).toBe(true);
    const rameshBefore = await billsOf(s, ramesh);
    expect(rameshBefore).toEqual([
      {
        period: "2026-10-01",
        opening: 0,
        charges: 30_000,
        lines: [{ type: "rent", assignmentId: first, amount: 30_000 }],
      },
    ]);

    const removed = await disconnectConnection.call(s.rt(OCT_13), s.staff, {
      assignmentId: first,
      effectiveDate: "2026-10-13",
      reason: "moved_away",
    });
    expect(removed.ok).toBe(true);

    // Same day: Ramesh still has the box during 13 Oct (both date ends are inclusive).
    const sameDay = await addConnection.call(s.rt(OCT_13), s.staff, {
      customerId: suresh,
      vcNumber: "55500011",
      rentalPaise: 30_000,
      startDate: "2026-10-13",
    });
    expect(!sameDay.ok && sameDay.error.details).toMatchObject({
      reason: "vc_in_use",
      holderCustomerId: ramesh,
      holderStatus: "disconnected",
      until: "2026-10-13",
      earliestStart: "2026-10-14",
    });
    const reused = await addConnection.call(s.rt(OCT_13), s.staff, {
      customerId: suresh,
      vcNumber: "55500011",
      rentalPaise: 30_000,
      startDate: "2026-10-14",
    });
    expect(reused.ok).toBe(true);
    if (!reused.ok || !removed.ok) return;
    const second = reused.value.connection.assignmentId;
    expect(second).not.toBe(first);
    expect(reused.value.vcAssetCreated).toBe(false);
    expect(reused.value.connection.vcAssetId).toBe(removed.value.connection.vcAssetId);
    expect(reused.value.previous).toEqual({
      assignmentId: first,
      customerId: ramesh,
      endDate: "2026-10-13",
    });

    await runBilling(s, "2026-11-01", NOV_1);

    // The old assignment and its bill stay with Ramesh, untouched; he gets no November rent.
    expect(await billsOf(s, ramesh)).toEqual(rameshBefore);
    const [oldRow] = await s.tx((tx) =>
      tx.select().from(vcAssignments).where(eq(vcAssignments.id, first)),
    );
    expect(oldRow).toMatchObject({
      customerId: ramesh,
      startDate: "2026-09-01",
      endDate: "2026-10-13",
      status: "disconnected",
    });
    // Suresh starts with nothing owed and is billed only for his own assignment.
    expect(await billsOf(s, suresh)).toEqual([
      {
        period: "2026-11-01",
        opening: 0,
        charges: 30_000,
        lines: [{ type: "rent", assignmentId: second, amount: 30_000 }],
      },
    ]);
    // Ramesh's payment and due stay his; both ledgers are consistent.
    const [rameshLedger, sureshLedger] = await s.tx(async (tx) => [
      await readLedgerState(tx, ramesh),
      await readLedgerState(tx, suresh),
    ]);
    expect(checkLedger(rameshLedger)).toEqual([]);
    expect(checkLedger(sureshLedger)).toEqual([]);
    const balances = await t.current.admin.query<{ customer_id: string; balance_paise: string }>(
      "SELECT customer_id, balance_paise FROM customer_balances WHERE customer_id = ANY($1)",
      [[ramesh, suresh]],
    );
    const balance = Object.fromEntries(
      balances.rows.map((r) => [r.customer_id, Number(r.balance_paise)]),
    );
    expect(balance).toEqual({ [ramesh]: 20_000, [suresh]: 30_000 });

    // Each customer's timeline shows only their own assignment.
    const rameshList = await listConnections.call(s.rt(NOV_1), s.staff, { customerId: ramesh });
    const sureshList = await listConnections.call(s.rt(NOV_1), s.staff, { customerId: suresh });
    expect(rameshList.ok && rameshList.value.past.map((c) => c.assignmentId)).toEqual([first]);
    expect(sureshList.ok && sureshList.value.current.map((c) => c.assignmentId)).toEqual([second]);
  }, 60_000);

  describe("back-dating into a billed month", () => {
    interface Billed {
      s: ConnectionSetup;
      /** Billed in October, one active VC each. */
      a1: { customerId: string; vc: string };
      a2: { customerId: string; vc: string };
      /** Its only VC was stopped on 10 Sep: the October run skipped it. */
      b: { customerId: string; vc: string };
    }

    async function billedInOctober(): Promise<Billed> {
      const s = await setupTenant(t.current);
      const a1 = await newCustomer(s, SEP_5);
      const a2 = await newCustomer(s, SEP_5);
      const b = await newCustomer(s, SEP_5);
      const vcA1 = await connect(s, a1, "A1-VC", "2026-09-05", SEP_5);
      const vcA2 = await connect(s, a2, "A2-VC", "2026-09-05", SEP_5);
      const vcB = await connect(s, b, "B-VC", "2026-09-05", SEP_5);
      const stop = await suspendConnection.call(s.rt(SEP_10), s.staff, {
        assignmentId: vcB,
        effectiveDate: "2026-09-10",
      });
      expect(stop.ok).toBe(true);
      await runBilling(s, "2026-10-01", OCT_1);
      return {
        s,
        a1: { customerId: a1, vc: vcA1 },
        a2: { customerId: a2, vc: vcA2 },
        b: { customerId: b, vc: vcB },
      };
    }

    const billedPeriod = (field: string) => ({
      reason: "billed_period",
      field,
      period: "2026-10-01",
      earliestDate: "2026-10-01",
    });

    it("Staff and Owner are refused; the month itself is fine; T-045's flow can pass", async () => {
      const { s, a1 } = await billedInOctober();
      const rt = s.rt(OCT_13);
      const sep30 = { assignmentId: a1.vc, effectiveDate: "2026-09-30" };

      const staff = await suspendConnection.call(rt, s.staff, sep30);
      expect(!staff.ok && staff.error.code).toBe("CONFLICT");
      expect(!staff.ok && staff.error.details).toMatchObject(billedPeriod("effectiveDate"));
      const owner = await suspendConnection.call(rt, s.owner, sep30);
      expect(!owner.ok && owner.error.details).toMatchObject(billedPeriod("effectiveDate"));
      const removeEarly = await disconnectConnection.call(rt, s.staff, {
        ...sep30,
        reason: "moved_away",
      });
      expect(!removeEarly.ok && removeEarly.error.details?.reason).toBe("billed_period");

      // The Owner's guided flow (T-045) calls the same change with allowBilledPeriod.
      const viaOwnerFlow = await ownerBackdatedSuspend.call(rt, s.owner, sep30);
      expect(viaOwnerFlow.ok).toBe(true);
      // Staff may still date a change inside October: rent stops from November.
      const removeInOctober = await disconnectConnection.call(rt, s.staff, {
        assignmentId: a1.vc,
        effectiveDate: "2026-10-01",
        reason: "moved_away",
      });
      expect(removeInOctober.ok).toBe(true);
    });

    it("plan changes and new connections follow the same rule", async () => {
      const { s, a2 } = await billedInOctober();
      const rt = s.rt(OCT_13);
      const early = await changeConnectionPlan.call(rt, s.staff, {
        assignmentId: a2.vc,
        effectiveDate: "2026-09-20",
        rentalPaise: 40_000,
      });
      expect(!early.ok && early.error.details).toMatchObject(billedPeriod("effectiveDate"));
      const inOctober = await changeConnectionPlan.call(rt, s.staff, {
        assignmentId: a2.vc,
        effectiveDate: "2026-10-05",
        rentalPaise: 40_000,
      });
      expect(inOctober.ok).toBe(true);

      const startEarly = await addConnection.call(rt, s.staff, {
        customerId: a2.customerId,
        vcNumber: "A2-SECOND",
        rentalPaise: 20_000,
        startDate: "2026-09-30",
      });
      expect(!startEarly.ok && startEarly.error.details).toMatchObject(billedPeriod("startDate"));
      const startOct1 = await addConnection.call(rt, s.staff, {
        customerId: a2.customerId,
        vcNumber: "A2-SECOND",
        rentalPaise: 20_000,
        startDate: "2026-10-01",
      });
      expect(startOct1.ok).toBe(true);

      // A customer the October run never looked at has no billed month.
      const newcomer = await newCustomer(s, OCT_13);
      const backdated = await addConnection.call(rt, s.staff, {
        customerId: newcomer,
        vcNumber: "NEWCOMER",
        rentalPaise: 20_000,
        startDate: "2026-09-15",
      });
      expect(backdated.ok).toBe(true);
    });

    it("a customer the run skipped (nothing to bill) counts as billed", async () => {
      const { s, b } = await billedInOctober();
      const rt = s.rt(OCT_13);
      const list = await listConnections.call(rt, s.staff, { customerId: b.customerId });
      expect(list.ok && list.value.latestBilledPeriod).toBe("2026-10-01");
      expect(list.ok && list.value.current[0]?.earliestChangeDate).toBe("2026-10-01");

      const early = await reactivateConnection.call(rt, s.staff, {
        assignmentId: b.vc,
        effectiveDate: "2026-09-20",
      });
      expect(!early.ok && early.error.details).toMatchObject(billedPeriod("effectiveDate"));
      const inOctober = await reactivateConnection.call(rt, s.staff, {
        assignmentId: b.vc,
        effectiveDate: "2026-10-02",
      });
      expect(inOctober.ok).toBe(true);
    });
  });
});

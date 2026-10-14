/**
 * Plans and the bills (T-031 acceptance, FR-007, BR-07), with the real connection services (T-034)
 * and billing run (T-044):
 * - a plan's new price never changes a bill already made, nor what the plan's existing
 *   connections pay; connections that get the plan after the change pay the new price from their
 *   first bill;
 * - a hidden (retired) plan can't be given to a new connection or chosen in a plan change, and is
 *   not offered in the connection form; its connections keep it and are still billed.
 */
import { invoiceLines, invoices, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { asc, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { connectionFormOptions } from "../connections/queries";
import { addConnection, changeConnectionPlan } from "../connections/services";
import {
  type ConnectionSetup,
  ist,
  newCustomer,
  runBilling,
  setupTenant,
} from "../connections/test-support";
import { createPlan, listPlans, retirePlan, updatePlan } from "./plans";

const SEP_1 = ist("2026-09-01");
const SEP_5 = ist("2026-09-05");
const OCT_1 = ist("2026-10-01", "08:30");
const OCT_13 = ist("2026-10-13");
const NOV_1 = ist("2026-11-01", "08:30");
const NOV_10 = ist("2026-11-10");
const DEC_1 = ist("2026-12-01", "08:30");

describeDb("plans and bills", () => {
  const t = useTestDatabase();

  async function plan(s: ConnectionSetup, name: string, paise: number, now: Date) {
    const result = await createPlan.call(s.rt(now), s.owner, { name, monthlyAmountPaise: paise });
    if (!result.ok) throw new Error(`createPlan: ${JSON.stringify(result.error)}`);
    return result.value.id;
  }

  async function connect(
    s: ConnectionSetup,
    customerId: string,
    vcNumber: string,
    planId: string,
    startDate: string,
    now: Date,
  ) {
    const result = await addConnection.call(s.rt(now), s.staff, {
      customerId,
      vcNumber,
      planId,
      startDate,
    });
    if (!result.ok) throw new Error(`addConnection: ${JSON.stringify(result.error)}`);
    return result.value.connection.assignmentId;
  }

  /** Every bill of the tenant with its lines (full rows, to see that nothing moved). */
  async function allBills(s: ConnectionSetup) {
    return s.tx(async (tx) => ({
      invoices: await tx.select().from(invoices).orderBy(asc(invoices.id)),
      lines: await tx.select().from(invoiceLines).orderBy(asc(invoiceLines.id)),
    }));
  }

  /** The month's rent lines as `{ assignmentId: amount }`. */
  async function rentLines(s: ConnectionSetup, period: string) {
    const rows = await s.tx(async (tx) =>
      tx
        .select({ assignmentId: invoiceLines.assignmentId, amount: invoiceLines.amountPaise })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(eq(invoices.period, period)),
    );
    return Object.fromEntries(rows.map((r) => [r.assignmentId, Number(r.amount)]));
  }

  async function rentalOf(s: ConnectionSetup, assignmentId: string) {
    const [row] = await s.tx((tx) =>
      tx
        .select({ planId: vcAssignments.planId, rental: vcAssignments.rentalAmountPaise })
        .from(vcAssignments)
        .where(eq(vcAssignments.id, assignmentId)),
    );
    return row;
  }

  it("a new price never changes a bill already made; only new connections use it", async () => {
    const s = await setupTenant(t.current);
    const basic = await plan(s, "Basic", 25_000, SEP_1);
    const ramesh = await newCustomer(s, SEP_1, "Ramesh");
    const first = await connect(s, ramesh, "7770 0001", basic, "2026-09-05", SEP_5);

    await runBilling(s, "2026-10-01", OCT_1);
    const october = await allBills(s);
    expect(october.lines.map((l) => [l.assignmentId, l.amountPaise])).toEqual([[first, 25_000]]);

    // The Owner raises the price; the page told them 1 connection is on the plan.
    const listed = await listPlans.call(s.rt(OCT_13), s.owner, {});
    expect(listed.ok && listed.value.plans[0]?.connectionCount).toBe(1);
    const raised = await updatePlan.call(s.rt(OCT_13), s.owner, {
      planId: basic,
      name: "Basic",
      monthlyAmountPaise: 30_000,
    });
    expect(raised.ok && raised.value.changed).toEqual(["monthly_amount_paise"]);

    // The October bill and its line are exactly as they were.
    expect(await allBills(s)).toEqual(october);
    // Ramesh's connection keeps its rent (applying the new price is a plan change, T-045).
    expect(await rentalOf(s, first)).toEqual({ planId: basic, rental: 25_000 });

    // A connection given the plan after the change gets the new price.
    const suresh = await newCustomer(s, OCT_13, "Suresh");
    const second = await connect(s, suresh, "7770 0002", basic, "2026-10-13", OCT_13);
    expect(await rentalOf(s, second)).toEqual({ planId: basic, rental: 30_000 });

    await runBilling(s, "2026-11-01", NOV_1);
    expect(await rentLines(s, "2026-11-01")).toEqual({ [first]: 25_000, [second]: 30_000 });
    // October is still untouched after November's run.
    const after = await allBills(s);
    expect(after.invoices.filter((i) => i.period === "2026-10-01")).toEqual(october.invoices);
  }, 60_000);

  it("a hidden plan can't be given to a connection; its connections keep it and are billed", async () => {
    const s = await setupTenant(t.current);
    const basic = await plan(s, "Basic", 25_000, SEP_1);
    const sports = await plan(s, "Sports", 40_000, SEP_1);
    const ramesh = await newCustomer(s, SEP_1, "Ramesh");
    const onSports = await connect(s, ramesh, "7780 0001", sports, "2026-09-05", SEP_5);
    const onBasic = await connect(s, ramesh, "7780 0002", basic, "2026-09-05", SEP_5);

    const retired = await retirePlan.call(s.rt(OCT_13), s.owner, { planId: sports });
    expect(retired.ok && retired.value).toMatchObject({ status: "retired", connectionCount: 1 });

    // Not offered in the connection form.
    const options = await connectionFormOptions.call(s.rt(OCT_13), s.staff, {});
    expect(options.ok && options.value.plans.map((p) => p.id)).toEqual([basic]);

    // Refused for a new connection…
    const suresh = await newCustomer(s, OCT_13, "Suresh");
    const added = await addConnection.call(s.rt(OCT_13), s.staff, {
      customerId: suresh,
      vcNumber: "7780 0003",
      planId: sports,
      startDate: "2026-10-13",
    });
    expect(!added.ok && added.error).toMatchObject({
      code: "VALIDATION",
      details: { fields: [{ path: "planId", code: "retired" }] },
    });
    // …and as the new plan of an existing connection.
    const changed = await changeConnectionPlan.call(s.rt(OCT_13), s.owner, {
      assignmentId: onBasic,
      effectiveDate: "2026-10-13",
      planId: sports,
    });
    expect(!changed.ok && changed.error).toMatchObject({
      code: "VALIDATION",
      details: { fields: [{ path: "planId", code: "retired" }] },
    });

    // The connection on the hidden plan keeps it and its rent, and is still billed.
    expect(await rentalOf(s, onSports)).toEqual({ planId: sports, rental: 40_000 });
    await runBilling(s, "2026-11-01", NOV_1);
    expect(await rentLines(s, "2026-11-01")).toEqual({ [onSports]: 40_000, [onBasic]: 25_000 });

    // Changing the hidden plan's price later does not touch its connection either.
    const repriced = await updatePlan.call(s.rt(NOV_10), s.owner, {
      planId: sports,
      name: "Sports",
      monthlyAmountPaise: 50_000,
    });
    expect(repriced.ok).toBe(true);
    await runBilling(s, "2026-12-01", DEC_1);
    expect(await rentLines(s, "2026-12-01")).toEqual({ [onSports]: 40_000, [onBasic]: 25_000 });
  }, 60_000);
});

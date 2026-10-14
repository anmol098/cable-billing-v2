/**
 * A tenant with two months of operations made through the real services, for the T-081 report
 * tests (not exported from the package; no import-time side effects): T-044 bill runs with the job
 * worker, T-046 phone and counter payments and an undo, T-062 handovers (sent back, handed over
 * again, accepted). Connections are written row by row like T-034 writes them, with plans.
 *
 * Joined 15 Sep 2026. Plans Basic ₹300, Gold ₹450. Bill runs on 1 Oct and 1 Nov, 08:30 IST.
 *
 * | Customer | Area | Connection |
 * |---|---|---|
 * | Asha `A-1` | North | Basic ₹300 from 1 Oct |
 * | Bina `B-2` | North | Gold ₹450 from 1 Oct; plan → Basic ₹300 effective 20 Oct |
 * | Chandu `C-3` | South | own amount ₹250 from 1 Oct; stopped eff. 15 Oct, started again eff. 25 Oct |
 * | Dev `D-4` | — | Basic ₹300 from 1 Oct; removed eff. 31 Oct |
 * | Esha `E-5` | South | Gold ₹450 from 10 Oct |
 * | Farid `F-6` | South | Basic ₹300 from 1 Oct; stopped eff. 31 Oct |
 * | Gopal `G-7` | North | own amount ₹100 from 1 Oct; his account total drifts after October's bill |
 *
 * Money (IST):
 * - 31 Oct, Ravi's phone: Asha ₹300 cash 10:00, Bina ₹300 UPI 11:00, Chandu ₹250 cash 23:50
 *   (reached the office 1 Nov 00:20). Ravi hands over ₹500 at 1 Nov 00:30 (₹50 short); the
 *   Owner sends it back at 09:00; Ravi hands over ₹550 at 09:30; the Owner accepts at 10:00.
 * - 31 Oct, Suresh's phone: Dev ₹300 cash 12:00, Farid ₹300 cash 13:00. Suresh hands over ₹550 at
 *   20:00 (expected ₹600: ₹50 short, reason "short"). The Owner undoes Farid's payment on 1 Nov
 *   11:00, so ₹300 is expected now (the total changed after the handover); still waiting.
 * - 1 Nov, Ravi's phone: Esha ₹450 UPI 10:00, Gopal ₹100 cash 11:00 (not handed over).
 * - 1 Nov, Staff at the counter: Asha ₹200 cash 12:00.
 * - 2 Nov, Owner at the counter: Bina ₹150 UPI 09:00.
 *
 * Bill runs: October bills all seven but Esha (starts 10 Oct); November bills Asha, Bina, Chandu
 * and Esha, has nothing to bill for Farid (stopped), fails Gopal (`balance_mismatch`); Dev is
 * removed before 1 Nov, so the run does not look at him. "Now" is 2 Nov 2026, 10:00 IST.
 */
import {
  areas,
  assignmentEvents,
  customers,
  plans,
  type Tx,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import { eq } from "drizzle-orm";
import { startBillingRun } from "../../billing/services";
import { drainBillingJobs, insertCustomer } from "../../billing/test-support";
import { acceptHandover, returnHandover, submitHandover } from "../../collections/handover";
import { addLineman } from "../../collections/test-support";
import type { ServiceRuntime } from "../../context/runtime";
import type { TenantContext } from "../../context/tenant-context";
import { postPayment } from "../../payments/post-payment";
import { reversePayment } from "../../payments/reverse-payment";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../../testing/fixtures";

/** `YYYY-MM-DD` + `HH:MM` IST → the instant. */
export function ist(date: string, time = "10:00"): Date {
  return new Date(`${date}T${time}:00.000+05:30`);
}

/** 2 Nov 2026, 10:00 IST. */
export const NOW = ist("2026-11-02", "10:00");

type Event =
  | { type: "suspended" | "reactivated" | "disconnected"; date: string }
  | { type: "plan_changed"; date: string; toPlan: string | null; toPaise: number };

export interface OperationsWorld {
  readonly tenant: SeededTenant;
  readonly owner: TenantContext;
  readonly staff: TenantContext;
  readonly lineman: TenantContext;
  readonly ravi: { readonly userId: string; readonly ctx: TenantContext };
  readonly suresh: { readonly userId: string; readonly ctx: TenantContext };
  readonly north: string;
  readonly south: string;
  readonly basic: string;
  readonly gold: string;
  readonly customers: Readonly<
    Record<"asha" | "bina" | "chandu" | "dev" | "esha" | "farid" | "gopal", string>
  >;
  /** Assignment ids by customer key. */
  readonly connections: Readonly<Record<string, string>>;
  /** Farid's undone payment. */
  readonly undonePaymentId: string;
  readonly rt: (now: Date) => ServiceRuntime;
}

export async function buildOperationsWorld(db: TestDatabase): Promise<OperationsWorld> {
  const rt = (now: Date) => testRuntime(db.db, { now: () => now });
  const tenant = await seedTenant(db);
  const op = tenant.operatorId;
  await db.admin.query("UPDATE operators SET created_at = $2 WHERE id = $1", [
    op,
    "2026-09-15T06:00:00Z",
  ]);
  const setup = rt(ist("2026-09-20"));
  const owner = await contextFor(setup, tenant, "owner");
  const staff = await contextFor(setup, tenant, "staff");
  const lineman = await contextFor(setup, tenant, "lineman");
  const ravi = await addLineman(db, setup, tenant, { name: "Ravi Kumar", deviceCode: "R01" });
  const suresh = await addLineman(db, setup, tenant, { name: "Suresh Pal", deviceCode: "S01" });
  await db.admin.query("UPDATE users SET name = $2 WHERE id = $1", [owner.userId, "Owner Om"]);
  await db.admin.query("UPDATE users SET name = $2 WHERE id = $1", [staff.userId, "Staff Sita"]);
  await db.admin.query("UPDATE users SET name = $2 WHERE id = $1", [lineman.userId, "Lal Singh"]);

  const ids = await db.db.withTenant(op, async (tx: Tx) => {
    const north = uuidv7();
    const south = uuidv7();
    await tx.insert(areas).values([
      { id: north, operatorId: op, name: "North" },
      { id: south, operatorId: op, name: "South" },
    ]);
    const basic = uuidv7();
    const gold = uuidv7();
    await tx.insert(plans).values([
      { id: basic, operatorId: op, name: "Basic", monthlyAmountPaise: 30_000 },
      { id: gold, operatorId: op, name: "Gold", monthlyAmountPaise: 45_000 },
    ]);
    const named = async (code: string, name: string, areaId: string | null) => {
      const id = await insertCustomer(tx, op);
      await tx
        .update(customers)
        .set({ customerCode: code, name, areaId })
        .where(eq(customers.id, id));
      return id;
    };
    /** A connection as T-034 writes it: asset, assignment kept in step with its events. */
    const connect = async (
      customerId: string,
      start: string,
      plan: string | null,
      rentalPaise: number,
      events: Event[] = [],
    ) => {
      const assetId = uuidv7();
      await tx
        .insert(vcAssets)
        .values({ id: assetId, operatorId: op, vcNumber: `VC-${customerId.slice(-6)}` });
      let status: "active" | "suspended" | "disconnected" = "active";
      let endDate: string | null = null;
      let planId = plan;
      let rental = rentalPaise;
      for (const e of events) {
        if (e.type === "suspended") status = "suspended";
        else if (e.type === "reactivated") status = "active";
        else if (e.type === "disconnected") {
          status = "disconnected";
          endDate = e.date;
        } else if (e.type === "plan_changed") {
          planId = e.toPlan;
          rental = e.toPaise;
        }
      }
      const id = uuidv7();
      await tx.insert(vcAssignments).values({
        id,
        operatorId: op,
        vcAssetId: assetId,
        customerId,
        startDate: start,
        endDate,
        status,
        planId,
        rentalAmountPaise: rental,
      });
      let at = Date.parse(`${start}T00:00:00Z`);
      let fromPlan = plan;
      let fromPaise = rentalPaise;
      for (const e of [{ type: "activated" as const, date: start }, ...events]) {
        at += 60_000;
        await tx.insert(assignmentEvents).values({
          id: uuidv7(),
          operatorId: op,
          assignmentId: id,
          type: e.type,
          effectiveDate: e.date,
          ...(e.type === "plan_changed"
            ? {
                fromPlanId: fromPlan,
                toPlanId: e.toPlan,
                fromRentalPaise: fromPaise,
                toRentalPaise: e.toPaise,
              }
            : {}),
          at: new Date(at),
        });
        if (e.type === "plan_changed") {
          fromPlan = e.toPlan;
          fromPaise = e.toPaise;
        }
      }
      return id;
    };
    const c = {
      asha: await named("A-1", "Asha Devi", north),
      bina: await named("B-2", "Bina Rao", north),
      chandu: await named("C-3", "Chandu", south),
      dev: await named("D-4", "Dev", null),
      esha: await named("E-5", "Esha", south),
      farid: await named("F-6", "Farid", south),
      gopal: await named("G-7", "Gopal", north),
    };
    const oct = "2026-10-01";
    const connections = {
      asha: await connect(c.asha, oct, basic, 30_000),
      bina: await connect(c.bina, oct, gold, 45_000, [
        { type: "plan_changed", date: "2026-10-20", toPlan: basic, toPaise: 30_000 },
      ]),
      chandu: await connect(c.chandu, oct, null, 25_000, [
        { type: "suspended", date: "2026-10-15" },
        { type: "reactivated", date: "2026-10-25" },
      ]),
      dev: await connect(c.dev, oct, basic, 30_000, [{ type: "disconnected", date: "2026-10-31" }]),
      esha: await connect(c.esha, "2026-10-10", gold, 45_000),
      farid: await connect(c.farid, oct, basic, 30_000, [
        { type: "suspended", date: "2026-10-31" },
      ]),
      gopal: await connect(c.gopal, oct, null, 10_000),
    };
    return { north, south, basic, gold, customers: c, connections };
  });
  const c = ids.customers;

  const bill = async (period: string) => {
    const at = ist(period, "08:30");
    const started = await startBillingRun.call(rt(at), owner, { period });
    if (!started.ok) throw new Error(`run ${period}: ${started.error.code}`);
    const report = await drainBillingJobs(db.db, () => at);
    if (report.failed !== 0) throw new Error(`run ${period}: ${report.failed} failed jobs`);
  };
  let ref = 0;
  /** A phone payment taken at `at` that reached the office at `postedAt`. */
  const field = async (
    who: { ctx: TenantContext },
    customerId: string,
    amountPaise: number,
    method: "cash" | "upi",
    at: Date,
    postedAt = new Date(at.getTime() + 60_000),
  ) => {
    ref += 1;
    const id = uuidv7();
    const result = await postPayment.call(rt(postedAt), who.ctx, {
      id,
      customerId,
      amountPaise,
      method,
      ...(method === "upi" ? { upiReference: "123456789012" } : {}),
      recordedAt: at.toISOString(),
      provisionalRef: `P-TST-${String(ref).padStart(4, "0")}`,
      claimedCollectorId: who.ctx.userId,
      ...(who.ctx.deviceId ? { claimedDeviceId: who.ctx.deviceId } : {}),
    });
    if (!result.ok) throw new Error(`field payment: ${result.error.code}`);
    return id;
  };
  const counter = async (
    ctx: TenantContext,
    customerId: string,
    amountPaise: number,
    method: "cash" | "upi",
    at: Date,
  ) => {
    const result = await postPayment.call(rt(at), ctx, {
      id: uuidv7(),
      customerId,
      amountPaise,
      method,
      ...(method === "upi" ? { upiReference: "123456789012" } : {}),
    });
    if (!result.ok) throw new Error(`counter payment: ${result.error.code}`);
  };
  const handOver = async (
    who: { ctx: TenantContext },
    date: string,
    cashPaise: number,
    at: Date,
    reason?: "short" | "extra",
  ) => {
    const submissionId = uuidv7();
    const result = await submitHandover.call(rt(at), who.ctx, {
      businessDate: date,
      submissionId,
      cashHandedOverPaise: cashPaise,
      ...(reason ? { discrepancyReason: reason } : {}),
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    });
    if (!result.ok) throw new Error(`handover: ${result.error.code}`);
    const sessionId = result.value.day.sessionId;
    if (!sessionId) throw new Error("handover: no session");
    return { sessionId, submissionId };
  };

  await bill("2026-10-01");

  const oct31 = "2026-10-31";
  await field(ravi, c.asha, 30_000, "cash", ist(oct31, "10:00"));
  await field(ravi, c.bina, 30_000, "upi", ist(oct31, "11:00"));
  await field(ravi, c.chandu, 25_000, "cash", ist(oct31, "23:50"), ist("2026-11-01", "00:20"));
  await field(suresh, c.dev, 30_000, "cash", ist(oct31, "12:00"));
  const undonePaymentId = await field(suresh, c.farid, 30_000, "cash", ist(oct31, "13:00"));
  await handOver(suresh, oct31, 55_000, ist(oct31, "20:00"), "short");

  const first = await handOver(ravi, oct31, 50_000, ist("2026-11-01", "00:30"), "short");
  const returned = await returnHandover.call(rt(ist("2026-11-01", "09:00")), owner, {
    ...first,
    note: "Count the cash again",
  });
  if (!returned.ok) throw new Error(`return: ${returned.error.code}`);

  // Gopal's account total drifts (as T-047's tests do), so November's run fails him.
  await db.admin.query(
    "UPDATE customer_balances SET balance_paise = balance_paise + 123 WHERE customer_id = $1",
    [c.gopal],
  );
  await bill("2026-11-01");

  const second = await handOver(ravi, oct31, 55_000, ist("2026-11-01", "09:30"));
  const accepted = await acceptHandover.call(rt(ist("2026-11-01", "10:00")), owner, second);
  if (!accepted.ok) throw new Error(`accept: ${accepted.error.code}`);

  await field(ravi, c.esha, 45_000, "upi", ist("2026-11-01", "10:00"));
  await field(ravi, c.gopal, 10_000, "cash", ist("2026-11-01", "11:00"));
  const undone = await reversePayment.call(rt(ist("2026-11-01", "11:00")), owner, {
    paymentId: undonePaymentId,
    reason: "Wrong customer",
  });
  if (!undone.ok) throw new Error(`reverse: ${undone.error.code}`);
  await counter(staff, c.asha, 20_000, "cash", ist("2026-11-01", "12:00"));
  await counter(owner, c.bina, 15_000, "upi", ist("2026-11-02", "09:00"));

  return {
    tenant,
    owner,
    staff,
    lineman,
    ravi,
    suresh,
    north: ids.north,
    south: ids.south,
    basic: ids.basic,
    gold: ids.gold,
    customers: c,
    connections: ids.connections,
    undonePaymentId,
    rt,
  };
}

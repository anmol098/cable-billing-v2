/**
 * A tenant with five months of history made through the real services (T-044 billing runs and job
 * worker, T-046 payments and an undo), for the T-080 report tests. Not exported from the package.
 *
 * Timeline (IST). The tenant joined on 15 Jun 2026; bills are made on the 1st of Jul … Oct.
 *
 * | Customer | Area | Rent | Money |
 * |---|---|---|---|
 * | Asha `A-1` | North | ₹300 | ₹200 cash on 10 Aug (part of July's bill) |
 * | Bina `B-2` | North | ₹400 | ₹1,000 UPI on 5 Jul (₹600 advance, used by the Aug and Sep bills) |
 * | Chandu `C-3` | South | ₹250 | ₹250 cash 3 Jul; ₹250 cash 4 Aug, undone by the Owner on 20 Aug |
 * | Dev `D-4` | (none) | ₹100 | ₹2,000 cash on 2 Jul (advance) |
 * | Farid `F-5` | South | ₹500 | ₹500 cash 31 Oct 23:45, ₹500 cash 1 Nov 00:15 |
 * | Gopal `G-6` | North | — | migrated old due ₹700 (June bill, made 20 Jun), nothing paid |
 *
 * "Now" is 2 Nov 2026, 10:00 IST (no November bills).
 */
import { areas, customers, type Tx, uuidv7 } from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import { eq } from "drizzle-orm";
import { startBillingRun } from "../../billing/services";
import { addConnection, drainBillingJobs, insertCustomer } from "../../billing/test-support";
import type { ServiceRuntime } from "../../context/runtime";
import type { TenantContext } from "../../context/tenant-context";
import { postPayment } from "../../payments/post-payment";
import { reversePayment } from "../../payments/reverse-payment";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../../testing/fixtures";

export const PERIODS = ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"] as const;
/** 2 Nov 2026, 10:00 IST. */
export const NOW = new Date("2026-11-02T04:30:00.000Z");
/** 31 Oct 2026, 23:45 IST. */
export const OCT_31_LATE = new Date("2026-10-31T18:15:00.000Z");
/** 1 Nov 2026, 00:15 IST. */
export const NOV_1_EARLY = new Date("2026-10-31T18:45:00.000Z");

export interface ReportWorld {
  readonly tenant: SeededTenant;
  readonly owner: TenantContext;
  readonly staff: TenantContext;
  readonly lineman: TenantContext;
  readonly north: string;
  readonly south: string;
  readonly asha: string;
  readonly bina: string;
  readonly chandu: string;
  readonly dev: string;
  readonly farid: string;
  readonly gopal: string;
  /** Chandu's undone payment. */
  readonly undonePaymentId: string;
  readonly rt: (now: Date) => ServiceRuntime;
}

/** `YYYY-MM-DD` + `HH:MM` IST → the instant. */
export function ist(date: string, time = "10:00"): Date {
  return new Date(`${date}T${time}:00.000+05:30`);
}

export async function buildReportWorld(db: TestDatabase): Promise<ReportWorld> {
  const rt = (now: Date) => testRuntime(db.db, { now: () => now });
  const tenant = await seedTenant(db);
  const op = tenant.operatorId;
  await db.admin.query("UPDATE operators SET created_at = $2 WHERE id = $1", [
    op,
    "2026-06-15T06:00:00Z",
  ]);
  const setup = rt(ist("2026-06-20"));
  const owner = await contextFor(setup, tenant, "owner");
  const staff = await contextFor(setup, tenant, "staff");
  const lineman = await contextFor(setup, tenant, "lineman");

  const named = async (tx: Tx, code: string, name: string, areaId: string | null) => {
    const id = await insertCustomer(tx, op);
    await tx
      .update(customers)
      .set({
        customerCode: code,
        name,
        areaId,
        phone: `9876543${String(code.charCodeAt(0)).padStart(3, "0")}`,
      })
      .where(eq(customers.id, id));
    return id;
  };
  const ids = await db.db.withTenant(op, async (tx: Tx) => {
    const north = uuidv7();
    const south = uuidv7();
    await tx.insert(areas).values([
      { id: north, operatorId: op, name: "North" },
      { id: south, operatorId: op, name: "South" },
    ]);
    const asha = await named(tx, "A-1", "Asha Devi", north);
    const bina = await named(tx, "B-2", "Bina Rao", north);
    const chandu = await named(tx, "C-3", "Chandu", south);
    const dev = await named(tx, "D-4", "Dev", null);
    const farid = await named(tx, "F-5", "Farid", south);
    const gopal = await named(tx, "G-6", "Gopal", north);
    const start = "2026-07-01";
    await addConnection(tx, op, asha, { startDate: start, rentalPaise: 30_000 });
    await addConnection(tx, op, bina, { startDate: start, rentalPaise: 40_000 });
    await addConnection(tx, op, chandu, { startDate: start, rentalPaise: 25_000 });
    await addConnection(tx, op, dev, { startDate: start, rentalPaise: 10_000 });
    await addConnection(tx, op, farid, { startDate: start, rentalPaise: 50_000 });
    return { north, south, asha, bina, chandu, dev, farid, gopal };
  });

  // Gopal: a migrated old due (opening-balance bill of June, made on 20 Jun), as T-092 will.
  const madeAt = ist("2026-06-20").toISOString();
  const opening = uuidv7();
  await db.admin.query(
    `INSERT INTO invoices (id, operator_id, customer_id, period, invoice_number, kind,
       opening_balance_paise, charges_paise, total_due_paise, issued_at, legacy_source, legacy_id)
     VALUES ($1, $2, $3, '2026-06-01', 'OLD-1', 'opening_balance', 0, 70000, 70000, $4, 'legacy', 'g6')`,
    [opening, op, ids.gopal, madeAt],
  );
  await db.admin.query(
    `INSERT INTO ledger_entries (id, operator_id, customer_id, type, amount_paise, invoice_id, at)
     VALUES ($1, $2, $3, 'opening_balance', 70000, $4, $5)`,
    [uuidv7(), op, ids.gopal, opening, madeAt],
  );
  await db.admin.query(
    `INSERT INTO customer_balances (customer_id, operator_id, balance_paise, oldest_due_period)
     VALUES ($1, $2, 70000, '2026-06-01')`,
    [ids.gopal, op],
  );

  const pay = async (
    at: Date,
    customerId: string,
    amountPaise: number,
    method: "cash" | "upi" = "cash",
  ) => {
    const id = uuidv7();
    const result = await postPayment.call(rt(at), owner, {
      id,
      customerId,
      amountPaise,
      method,
      ...(method === "upi" ? { upiReference: "123456789012" } : {}),
    });
    if (!result.ok) throw new Error(`pay: ${result.error.code}`);
    return id;
  };
  const bill = async (period: string) => {
    const at = ist(period, "08:30");
    const started = await startBillingRun.call(rt(at), owner, { period });
    if (!started.ok) throw new Error(`run ${period}: ${started.error.code}`);
    const report = await drainBillingJobs(db.db, () => at);
    if (report.failed !== 0) throw new Error(`run ${period}: ${report.failed} failed jobs`);
  };

  await bill("2026-07-01");
  await pay(ist("2026-07-02"), ids.dev, 200_000);
  await pay(ist("2026-07-03"), ids.chandu, 25_000);
  await pay(ist("2026-07-05"), ids.bina, 100_000, "upi");
  await bill("2026-08-01");
  const undonePaymentId = await pay(ist("2026-08-04"), ids.chandu, 25_000);
  await pay(ist("2026-08-10"), ids.asha, 20_000);
  const undone = await reversePayment.call(rt(ist("2026-08-20")), owner, {
    paymentId: undonePaymentId,
    reason: "Wrong customer",
  });
  if (!undone.ok) throw new Error(`reverse: ${undone.error.code}`);
  await bill("2026-09-01");
  await bill("2026-10-01");
  await pay(OCT_31_LATE, ids.farid, 50_000);
  await pay(NOV_1_EARLY, ids.farid, 50_000);

  return { tenant, owner, staff, lineman, ...ids, undonePaymentId, rt };
}

/** Σ ledger_entries of the tenant before `cutoff` (optionally only some customers): the truth. */
export async function ledgerTotal(
  db: TestDatabase,
  operatorId: string,
  cutoff: Date,
  where: { areaId?: string; customerIds?: readonly string[] } = {},
): Promise<number> {
  const result = await db.admin.query<{ total: string }>(
    `SELECT coalesce(sum(l.amount_paise), 0)::text AS total
       FROM ledger_entries l
       JOIN customers c ON c.operator_id = l.operator_id AND c.id = l.customer_id
      WHERE l.operator_id = $1 AND l.at < $2
        AND ($3::uuid IS NULL OR c.area_id = $3::uuid)
        AND ($4::uuid[] IS NULL OR l.customer_id = ANY($4::uuid[]))`,
    [operatorId, cutoff.toISOString(), where.areaId ?? null, where.customerIds ?? null],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/** Each customer's ledger balance before `cutoff`. */
export async function ledgerBalances(
  db: TestDatabase,
  operatorId: string,
  cutoff: Date,
): Promise<Map<string, number>> {
  const result = await db.admin.query<{ customer_id: string; total: string }>(
    `SELECT customer_id, sum(amount_paise)::text AS total FROM ledger_entries
      WHERE operator_id = $1 AND at < $2 GROUP BY customer_id`,
    [operatorId, cutoff.toISOString()],
  );
  return new Map(result.rows.map((row) => [row.customer_id, Number(row.total)]));
}

/** Each customer's unpaid bills before `cutoff` (charges − Σ allocations made by then, > 0). */
export async function unpaidBills(
  db: TestDatabase,
  operatorId: string,
  cutoff: Date,
): Promise<Map<string, { id: string; period: string; outstandingPaise: number }[]>> {
  const result = await db.admin.query<{
    customer_id: string;
    id: string;
    period: string;
    outstanding: string;
  }>(
    `SELECT i.customer_id, i.id, i.period::text AS period,
            (i.charges_paise - coalesce((SELECT sum(a.amount_paise) FROM allocations a
               WHERE a.invoice_id = i.id AND a.created_at < $2), 0))::text AS outstanding
       FROM invoices i
      WHERE i.operator_id = $1 AND i.issued_at < $2`,
    [operatorId, cutoff.toISOString()],
  );
  const map = new Map<string, { id: string; period: string; outstandingPaise: number }[]>();
  for (const row of result.rows) {
    const outstanding = Number(row.outstanding);
    if (outstanding <= 0) continue;
    const list = map.get(row.customer_id) ?? [];
    list.push({ id: row.id, period: row.period, outstandingPaise: outstanding });
    map.set(row.customer_id, list);
  }
  return map;
}

/**
 * The money reports (T-080) on T-036's realistic `small` seed (3 operators, 150 customers, 12
 * months of runs, part payments, advances, credit applied by later bills, undone payments,
 * migrated opening balances, bill changes): for every operator, area and a few past month ends,
 * the dues report adds up to the ledger, matches the reference spreading, and the bill register
 * adds up to the ledger's bill entries and allocations. Also a timing sanity check (the
 * legacy-size check is `dues.bench.test.ts`).
 */
import { type DbClient, users } from "@cb/db";
import { seedDatabase } from "@cb/db/seed";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import {
  addPeriods,
  businessDate,
  businessDateOf,
  comparePeriods,
  type Period,
  periodOf,
} from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import type { ServiceRuntime } from "../../context/runtime";
import { newRequestId } from "../../context/runtime";
import { resolveTenantContext, type TenantContext } from "../../context/tenant-context";
import { testRuntime } from "../../testing/fixtures";
import { billRegisterReport } from "../registers/bills";
import { spreadDue } from "./ageing";
import { resolveAsOf } from "./as-of";
import { duesReport } from "./queries";
import { ledgerBalances, ledgerTotal, unpaidBills } from "./test-world";
import type { DuesReport } from "./types";

const TIMEOUT = 300_000;
const AS_OF = "2026-10-13";
/** The day after the seed's as-of date, 12:00 IST: everything seeded is in the past. */
const NOW = new Date("2026-10-14T06:30:00.000Z");

describeDb("money reports on the T-036 seed", () => {
  const t = useTestDatabase();
  let rt: ServiceRuntime;
  let tenants: { operatorId: string; owner: TenantContext; areaIds: string[] }[] = [];

  beforeAll(async () => {
    const db: DbClient = t.current.db;
    await seedDatabase(db, { scale: "small", seed: 7, asOf: AS_OF, verifyPerOperator: 5 });
    rt = testRuntime(db, { now: () => NOW });
    const operators = await t.current.admin.query<{ id: string }>(
      "SELECT id FROM operators ORDER BY id",
    );
    tenants = [];
    for (const { id } of operators.rows) {
      const owner = await db.withTenant(id, (tx) =>
        tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.operatorId, id), eq(users.role, "owner"))),
      );
      const ownerId = owner[0]?.id;
      if (!ownerId) throw new Error("no owner");
      const ctx = await resolveTenantContext(rt, {
        userId: ownerId,
        channel: "web",
        requestId: newRequestId(),
      });
      if (!ctx.ok) throw new Error(`ctx: ${ctx.error.code}`);
      const areas = await t.current.admin.query<{ id: string }>(
        "SELECT id FROM areas WHERE operator_id = $1 ORDER BY name",
        [id],
      );
      tenants.push({ operatorId: id, owner: ctx.value, areaIds: areas.rows.map((a) => a.id) });
    }
    expect(tenants.length).toBe(3);
    // The seed really has the hard cases: undone payments, advance used by later bills, part
    // payments, migrated old dues and credit bill changes.
    const shape = await t.current.admin.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM payment_reversals) AS reversals,
              (SELECT count(*)::int FROM allocations WHERE kind = 'credit_application') AS credit_applied,
              (SELECT count(*)::int FROM allocations WHERE kind = 'reversal') AS reversal_rows,
              (SELECT count(*)::int FROM invoices WHERE kind = 'opening_balance') AS opening,
              (SELECT count(*)::int FROM ledger_entries WHERE type = 'credit_adjustment') AS credit_adj,
              (SELECT count(*)::int FROM allocations WHERE outstanding_after_paise > 0
                 AND kind = 'posting') AS part_paid,
              (SELECT count(*)::int FROM customer_balances WHERE balance_paise < 0) AS advance`,
    );
    for (const [name, count] of Object.entries(shape.rows[0] ?? {})) {
      expect(count, name).toBeGreaterThan(0);
    }
  }, TIMEOUT);

  async function allDuesRows(ctx: TenantContext, input: Record<string, unknown>) {
    const rows: DuesReport["rows"][number][] = [];
    for (let page = 1; page < 1_000; page += 1) {
      const result = await duesReport.call(rt, ctx, { ...input, page });
      if (!result.ok) throw new Error(result.error.code);
      rows.push(...result.value.rows);
      if (result.value.rows.length < result.value.pageSize) break;
    }
    return rows;
  }

  it(
    "dues add up to the ledger for every operator, area and month end, and age like the reference",
    async () => {
      const dates = [undefined, "2026-09-30", "2026-06-30", "2025-12-31"];
      for (const tenant of tenants) {
        for (const asOfDate of dates) {
          const asOf = resolveAsOf(NOW, asOfDate ? businessDate(asOfDate) : undefined);
          if (!asOf.ok) throw new Error("asOf");
          const base = asOfDate ? { asOfDate } : {};
          for (const areaId of [undefined, ...tenant.areaIds.slice(0, 2)]) {
            const input = { ...base, ...(areaId ? { areaId } : {}) };
            const result = await duesReport.call(rt, tenant.owner, input);
            if (!result.ok) throw new Error(result.error.code);
            const ledger = await ledgerTotal(t.current, tenant.operatorId, asOf.value.cutoff, {
              ...(areaId ? { areaId } : {}),
            });
            expect(result.value.totals.netPaise, JSON.stringify(input)).toBe(ledger);
            const { buckets, duePaise } = result.value.totals;
            expect(buckets.d0_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus).toBe(
              duePaise,
            );
          }
          // Every customer: balance = ledger, buckets = the reference.
          const balances = await ledgerBalances(t.current, tenant.operatorId, asOf.value.cutoff);
          const bills = await unpaidBills(t.current, tenant.operatorId, asOf.value.cutoff);
          const rows = [
            ...(await allDuesRows(tenant.owner, base)),
            ...(await allDuesRows(tenant.owner, { ...base, kind: "advance" })),
          ];
          expect(rows.length).toBe([...balances.values()].filter((v) => v !== 0).length);
          for (const row of rows) {
            const balance = balances.get(row.customerId) ?? 0;
            expect(row.balancePaise).toBe(balance);
            const reference = spreadDue(
              balance,
              (bills.get(row.customerId) ?? []).map((b) => ({ ...b, period: b.period as Period })),
              asOf.value.date,
            );
            expect(row.buckets).toEqual(reference.buckets);
          }
        }
      }
    },
    TIMEOUT,
  );

  it(
    "the bill register adds up to the ledger's bills and allocations, and with the advance to the balance",
    async () => {
      for (const tenant of tenants) {
        const range = await t.current.admin.query<{ first: string; last: string }>(
          "SELECT min(period)::text AS first, max(period)::text AS last FROM invoices WHERE operator_id = $1",
          [tenant.operatorId],
        );
        const first = periodOf(businessDate(range.rows[0]?.first ?? AS_OF));
        const last = periodOf(businessDate(range.rows[0]?.last ?? AS_OF));
        let outstanding = 0;
        for (let from = first; comparePeriods(from, last) <= 0; from = addPeriods(from, 12)) {
          const to = addPeriods(from, 11);
          const result = await billRegisterReport.call(rt, tenant.owner, { from, to });
          if (!result.ok) throw new Error(result.error.code);
          const { totals } = result.value;
          const ledger = await t.current.admin.query<{ charges: string; paid: string; n: number }>(
            `SELECT
               (SELECT coalesce(sum(l.amount_paise), 0) FROM ledger_entries l
                  JOIN invoices i ON i.operator_id = l.operator_id AND i.id = l.invoice_id
                 WHERE l.operator_id = $1 AND i.period BETWEEN $2 AND $3)::text AS charges,
               (SELECT coalesce(sum(a.amount_paise), 0) FROM allocations a
                  JOIN invoices i ON i.operator_id = a.operator_id AND i.id = a.invoice_id
                 WHERE a.operator_id = $1 AND i.period BETWEEN $2 AND $3)::text AS paid,
               (SELECT count(*)::int FROM invoices
                 WHERE operator_id = $1 AND period BETWEEN $2 AND $3) AS n`,
            [tenant.operatorId, from, to],
          );
          expect(totals.chargesPaise).toBe(Number(ledger.rows[0]?.charges));
          expect(totals.paidPaise).toBe(Number(ledger.rows[0]?.paid));
          expect(totals.count).toBe(ledger.rows[0]?.n);
          expect(Object.values(totals.byState).reduce((a, b) => a + b, 0)).toBe(totals.count);
          outstanding += totals.outstandingPaise;
        }
        // Σ still due on every bill − Σ unused advance = Σ ledger (= the dues report's net).
        const credit = await t.current.admin.query<{ credit: string }>(
          "SELECT coalesce(sum(credit_paise), 0)::text AS credit FROM customer_balances WHERE operator_id = $1",
          [tenant.operatorId],
        );
        const ledger = await ledgerTotal(t.current, tenant.operatorId, new Date(NOW.getTime() + 1));
        expect(outstanding - Number(credit.rows[0]?.credit)).toBe(ledger);
        const dues = await duesReport.call(rt, tenant.owner, {});
        expect(dues.ok && dues.value.totals.netPaise).toBe(ledger);
      }
    },
    TIMEOUT,
  );

  it(
    "answers quickly on the seed (timing sanity)",
    async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error("no tenant");
      const timings: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        const result = await duesReport.call(rt, tenant.owner, {});
        timings.push(performance.now() - started);
        expect(result.ok).toBe(true);
      }
      timings.sort((a, b) => a - b);
      // Generous: CI machines are slow and shared. The legacy-size numbers are in the bench.
      expect(timings[2]).toBeLessThan(2_000);
      expect(businessDateOf(NOW)).toBe("2026-10-14");
    },
    TIMEOUT,
  );
});

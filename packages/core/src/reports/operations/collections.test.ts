/**
 * The daily collections report (T-081) against a real database (`test-world.ts`): hand-checked
 * days, cash and UPI never mixed, cancelled payments apart, and the totals reconciled with the
 * payment register (T-048 `listPayments`), the ledger and the linemen's collection sessions (T-062)
 * for the same days and person.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import { getLinemanDay } from "../../collections/day";
import { listPayments } from "../../payment-register/queries";
import { collectionsReport } from "./collections";
import { buildOperationsWorld, ist, NOW, type OperationsWorld } from "./test-world";
import type { CollectionAmounts, CollectionsReport } from "./types";

const TIMEOUT = 120_000;

describeDb("reports.collections", () => {
  const t = useTestDatabase();
  let w: OperationsWorld;

  beforeAll(async () => {
    w = await buildOperationsWorld(t.current);
  }, TIMEOUT);

  async function report(
    input: Parameters<typeof collectionsReport.call>[2] = {},
    now = NOW,
  ): Promise<CollectionsReport> {
    const result = await collectionsReport.call(w.rt(now), w.owner, input);
    if (!result.ok) throw new Error(`collections: ${result.error.code}`);
    return result.value;
  }

  const sum = (rows: readonly CollectionAmounts[]) =>
    rows.reduce(
      (acc, row) => ({
        cashPaise: acc.cashPaise + row.cashPaise,
        upiPaise: acc.upiPaise + row.upiPaise,
        count: acc.count + row.count,
        cancelledCount: acc.cancelledCount + row.cancelledCount,
        cancelledPaise: acc.cancelledPaise + row.cancelledPaise,
      }),
      { cashPaise: 0, upiPaise: 0, count: 0, cancelledCount: 0, cancelledPaise: 0 },
    );
  const amountsOf = (row: CollectionAmounts) => ({
    cashPaise: row.cashPaise,
    upiPaise: row.upiPaise,
    count: row.count,
    cancelledCount: row.cancelledCount,
    cancelledPaise: row.cancelledPaise,
  });

  /** −Σ ledger (payment + undo entries) of the payments of these days and person. */
  async function ledgerOfPayments(filter: { from: string; to: string; collectorId?: string }) {
    const result = await t.current.admin.query<{ total: string }>(
      `SELECT coalesce(-sum(l.amount_paise), 0)::text AS total
         FROM ledger_entries l
         JOIN payments p ON p.operator_id = l.operator_id
          AND p.id = coalesce(l.payment_id,
                (SELECT r.payment_id FROM payment_reversals r WHERE r.id = l.payment_reversal_id))
        WHERE l.operator_id = $1 AND l.type IN ('payment', 'payment_reversal')
          AND p.business_date BETWEEN $2::date AND $3::date
          AND ($4::uuid IS NULL OR p.collector_id = $4::uuid)`,
      [w.tenant.operatorId, filter.from, filter.to, filter.collectorId ?? null],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  it(
    "hand-checked days: cash and UPI apart, the undone payment listed but not counted",
    async () => {
      const oct31 = await report({ from: "2026-10-31", to: "2026-10-31" });
      expect(oct31.asOf).toEqual({ at: NOW, date: "2026-11-02", endOfDay: false });
      expect(oct31.totals).toEqual({
        cashPaise: 85_000,
        upiPaise: 30_000,
        count: 4,
        cancelledCount: 1,
        cancelledPaise: 30_000,
        people: 2,
      });
      expect(
        oct31.rows.map((row) => [row.businessDate, row.name, row.role, amountsOf(row)]),
      ).toEqual([
        [
          "2026-10-31",
          "Ravi Kumar",
          "lineman",
          { cashPaise: 55_000, upiPaise: 30_000, count: 3, cancelledCount: 0, cancelledPaise: 0 },
        ],
        [
          "2026-10-31",
          "Suresh Pal",
          "lineman",
          {
            cashPaise: 30_000,
            upiPaise: 0,
            count: 1,
            cancelledCount: 1,
            cancelledPaise: 30_000,
          },
        ],
      ]);

      const nov1 = await report({ from: "2026-11-01", to: "2026-11-01" });
      expect(nov1.rows.map((row) => [row.name, row.cashPaise, row.upiPaise, row.count])).toEqual([
        ["Ravi Kumar", 10_000, 45_000, 2],
        ["Staff Sita", 20_000, 0, 1],
      ]);

      // Default: today only (the Owner's UPI at the counter).
      const today = await report();
      expect([today.from, today.to]).toEqual(["2026-11-02", "2026-11-02"]);
      expect(today.rows.map((row) => [row.name, row.role, row.cashPaise, row.upiPaise])).toEqual([
        ["Owner Om", "owner", 0, 15_000],
      ]);
      expect(today.totals.cashPaise).toBe(0);
      expect(today.totals.upiPaise).toBe(15_000);
    },
    TIMEOUT,
  );

  it(
    "per person over several days, newest day first; Σ rows = Σ people = the totals row",
    async () => {
      const all = await report({ from: "2026-10-03", to: "2026-11-02" });
      expect(all.rows.map((row) => [row.businessDate, row.name])).toEqual([
        ["2026-11-02", "Owner Om"],
        ["2026-11-01", "Ravi Kumar"],
        ["2026-11-01", "Staff Sita"],
        ["2026-10-31", "Ravi Kumar"],
        ["2026-10-31", "Suresh Pal"],
      ]);
      expect(all.rowCount).toBe(5);
      expect(
        all.byCollector.map((row) => [row.name, row.cashPaise, row.upiPaise, row.count, row.days]),
      ).toEqual([
        ["Owner Om", 0, 15_000, 1, 1],
        ["Ravi Kumar", 65_000, 75_000, 5, 2],
        ["Staff Sita", 20_000, 0, 1, 1],
        ["Suresh Pal", 30_000, 0, 1, 1],
      ]);
      const { people, ...totals } = all.totals;
      expect(people).toBe(4);
      expect(sum(all.rows)).toEqual(totals);
      expect(sum(all.byCollector)).toEqual(totals);
      expect(totals).toEqual({
        cashPaise: 115_000,
        upiPaise: 90_000,
        count: 8,
        cancelledCount: 1,
        cancelledPaise: 30_000,
      });
      // Every user of the business is a filter option (also those with no payment).
      expect(all.collectors.map((u) => u.name)).toEqual([
        "Lal Singh",
        "Owner Om",
        "Ravi Kumar",
        "Staff Sita",
        "Suresh Pal",
      ]);
    },
    TIMEOUT,
  );

  it(
    "totals equal the payment register and the ledger for every range and person",
    async () => {
      const ranges = [
        ["2026-10-31", "2026-10-31"],
        ["2026-11-01", "2026-11-01"],
        ["2026-11-02", "2026-11-02"],
        ["2026-10-31", "2026-11-02"],
        ["2026-10-03", "2026-11-02"],
        ["2026-10-01", "2026-10-30"],
      ] as const;
      const people = [
        undefined,
        w.ravi.userId,
        w.suresh.userId,
        w.staff.userId,
        w.owner.userId,
        w.lineman.userId,
      ];
      for (const [from, to] of ranges) {
        for (const collectorId of people) {
          const filter = { from, to, ...(collectorId ? { collectorId } : {}) };
          const ours = await report(filter);
          const register = await listPayments.call(w.rt(NOW), w.staff, { ...filter, limit: 100 });
          if (!register.ok) throw new Error(register.error.code);
          const label = JSON.stringify(filter);
          expect(ours.totals.cashPaise, label).toBe(register.value.totals.cashPaise);
          expect(ours.totals.upiPaise, label).toBe(register.value.totals.upiPaise);
          expect(ours.totals.cancelledCount, label).toBe(register.value.totals.cancelledCount);
          expect(ours.totals.count + ours.totals.cancelledCount, label).toBe(
            register.value.totals.count,
          );
          expect(ours.totals.cashPaise + ours.totals.upiPaise, label).toBe(
            await ledgerOfPayments(filter),
          );
        }
      }
    },
    TIMEOUT,
  );

  it(
    "a lineman's day equals their collection session and the Linemen page (UPI never as cash)",
    async () => {
      const all = await report({ from: "2026-10-31", to: "2026-11-02" });
      const sessions = await t.current.admin.query<{
        collector_id: string;
        business_date: string;
        cash: string;
        upi: string;
        count: number;
      }>(
        `SELECT collector_id, business_date::text AS business_date,
                cash_expected_paise::text AS cash, upi_total_paise::text AS upi, payment_count AS count
           FROM collection_sessions WHERE operator_id = $1`,
        [w.tenant.operatorId],
      );
      expect(sessions.rows).toHaveLength(3);
      for (const session of sessions.rows) {
        const row = all.rows.find(
          (r) => r.collectorId === session.collector_id && r.businessDate === session.business_date,
        );
        expect(row, session.business_date).toBeDefined();
        expect(row?.cashPaise).toBe(Number(session.cash));
        expect(row?.upiPaise).toBe(Number(session.upi));
        expect(row?.count).toBe(session.count);
        const day = await getLinemanDay.call(w.rt(NOW), w.staff, {
          linemanId: session.collector_id,
          businessDate: session.business_date,
        });
        if (!day.ok) throw new Error(day.error.code);
        expect(row?.cashPaise).toBe(day.value.day.cashExpectedPaise);
        expect(row?.upiPaise).toBe(day.value.day.upiTotalPaise);
      }
    },
    TIMEOUT,
  );

  it(
    "as of an earlier moment: later payments and undos are not in it yet",
    async () => {
      // 1 Nov 00:00 IST: Chandu's payment (reached the office 00:20) and the undo (11:00) are later.
      const early = await report(
        { from: "2026-10-31", to: "2026-10-31" },
        ist("2026-11-01", "00:00"),
      );
      expect(early.rows.map((row) => [row.name, amountsOf(row)])).toEqual([
        [
          "Ravi Kumar",
          { cashPaise: 30_000, upiPaise: 30_000, count: 2, cancelledCount: 0, cancelledPaise: 0 },
        ],
        [
          "Suresh Pal",
          { cashPaise: 60_000, upiPaise: 0, count: 2, cancelledCount: 0, cancelledPaise: 0 },
        ],
      ]);
    },
    TIMEOUT,
  );

  it(
    "filters, pages, roles and refusals",
    async () => {
      const ravi = await report({
        from: "2026-10-31",
        to: "2026-11-02",
        collectorId: w.ravi.userId,
      });
      expect(ravi.rows.map((row) => row.businessDate)).toEqual(["2026-11-01", "2026-10-31"]);
      expect(ravi.byCollector.map((row) => row.name)).toEqual(["Ravi Kumar"]);
      expect(ravi.totals.cashPaise).toBe(65_000);
      expect(ravi.totals.upiPaise).toBe(75_000);

      // Someone with no payment: zeros, no rows.
      const lal = await report({
        from: "2026-10-31",
        to: "2026-11-02",
        collectorId: w.lineman.userId,
      });
      expect(lal.rows).toEqual([]);
      expect(lal.totals).toEqual({
        cashPaise: 0,
        upiPaise: 0,
        count: 0,
        cancelledCount: 0,
        cancelledPaise: 0,
        people: 0,
      });

      // Page 2 is empty but keeps the totals.
      const page2 = await report({ from: "2026-10-31", to: "2026-11-02", page: 2 });
      expect(page2.rows).toEqual([]);
      expect(page2.rowCount).toBe(5);
      expect(page2.totals.cashPaise).toBe(115_000);

      const staff = await collectionsReport.call(w.rt(NOW), w.staff, {});
      expect(staff.ok).toBe(true);
      const lineman = await collectionsReport.call(w.rt(NOW), w.ravi.ctx, {});
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");

      const refused = async (input: Parameters<typeof collectionsReport.call>[2]) => {
        const result = await collectionsReport.call(w.rt(NOW), w.owner, input);
        if (result.ok) throw new Error("expected a refusal");
        return result.error;
      };
      expect(await refused({ from: "2026-11-01", to: "2026-11-03" })).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "to", code: "future" }] },
      });
      expect(await refused({ from: "2026-11-02", to: "2026-11-01" })).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "to", code: "before_from" }] },
      });
      expect(await refused({ from: "2026-09-01", to: "2026-11-01" })).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "to", code: "too_many_days" }] },
      });
      expect((await refused({ from: "2026-02-30" })).code).toBe("VALIDATION");
      expect((await refused({ collectorId: "0190a000-0000-7000-8000-000000000000" })).code).toBe(
        "NOT_FOUND",
      );
    },
    TIMEOUT,
  );
});

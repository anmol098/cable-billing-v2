/**
 * The dues and ageing report (T-080) against a real database: five months of bills, payments,
 * advance, partial payments and an undone payment made through the real services
 * (`test-world.ts`). Report totals are compared with the ledger for the same filters and as-of
 * moment (FR-023), the ageing with the reference `spreadDue`, and the IST day and bucket
 * boundaries by hand.
 */

import { describeDb, useTestDatabase } from "@cb/db/testing";
import { businessDate, type Period } from "@cb/domain";
import { beforeAll, expect, it } from "vitest";
import { checkTenantInvariants } from "../../invariants/check";
import { spreadDue } from "./ageing";
import { resolveAsOf } from "./as-of";
import { duesReport } from "./queries";
import {
  buildReportWorld,
  ist,
  ledgerBalances,
  ledgerTotal,
  NOW,
  type ReportWorld,
  unpaidBills,
} from "./test-world";
import type { DuesReport } from "./types";

const TIMEOUT = 120_000;

describeDb("reports.dues", () => {
  const t = useTestDatabase();
  let w: ReportWorld;

  beforeAll(async () => {
    w = await buildReportWorld(t.current);
    // The world itself is consistent (T-052's invariants).
    const report = await t.current.db.withTenant(w.tenant.operatorId, (tx) =>
      checkTenantInvariants(tx, w.tenant.operatorId),
    );
    expect(report.samples).toEqual([]);
    expect(report.violationCount).toBe(0);
  }, TIMEOUT);

  async function dues(input: Parameters<typeof duesReport.call>[2] = {}, now = NOW) {
    const result = await duesReport.call(w.rt(now), w.owner, input);
    if (!result.ok) throw new Error(`dues: ${result.error.code}`);
    return result.value;
  }

  /** Every row of the list (all pages). */
  async function allRows(input: Parameters<typeof duesReport.call>[2] = {}) {
    const rows: DuesReport["rows"][number][] = [];
    for (let page = 1; page < 100; page += 1) {
      const report = await dues({ ...input, page });
      rows.push(...report.rows);
      if (report.rows.length < report.pageSize) break;
    }
    return rows;
  }

  it(
    "adds up to the ledger now, per area and as of past days (incl. undo, advance, part payments)",
    async () => {
      const op = w.tenant.operatorId;
      const cases: { asOfDate?: string; areaId?: string }[] = [];
      for (const asOfDate of [undefined, "2026-11-01", "2026-10-31", "2026-08-31", "2026-08-15"]) {
        for (const areaId of [undefined, w.north, w.south]) {
          cases.push({
            ...(asOfDate ? { asOfDate } : {}),
            ...(areaId ? { areaId } : {}),
          });
        }
      }
      for (const c of cases) {
        const report = await dues(c);
        const asOf = resolveAsOf(NOW, c.asOfDate ? businessDate(c.asOfDate) : undefined);
        if (!asOf.ok) throw new Error("asOf");
        const ledger = await ledgerTotal(t.current, op, asOf.value.cutoff, {
          ...(c.areaId ? { areaId: c.areaId } : {}),
        });
        const { totals } = report;
        expect(totals.netPaise, JSON.stringify(c)).toBe(ledger);
        expect(totals.duePaise - totals.advancePaise).toBe(ledger);
        const bucketSum = Object.values(totals.buckets).reduce((a, b) => a + b, 0);
        expect(bucketSum).toBe(totals.duePaise);
        // Areas add up to the whole.
        const areaNet = report.byArea.reduce((sum, area) => sum + area.netPaise, 0);
        expect(areaNet).toBe(totals.netPaise);
        // The list's totals row = Σ its rows = Σ the ledger of exactly those customers.
        for (const kind of ["due", "advance"] as const) {
          const rows = await allRows({ ...c, kind });
          const listed = await dues({ ...c, kind });
          const ids = rows.map((row) => row.customerId);
          const rowsNet = rows.reduce((sum, row) => sum + row.balancePaise, 0);
          expect(listed.listTotals.netPaise).toBe(rowsNet);
          expect(listed.listTotals.netPaise).toBe(
            ids.length === 0
              ? 0
              : await ledgerTotal(t.current, op, asOf.value.cutoff, { customerIds: ids }),
          );
          if (kind === "due") {
            expect(listed.listTotals.duePaise).toBe(totals.duePaise);
            expect(listed.listTotals.dueCustomers).toBe(rows.length);
          } else {
            expect(listed.listTotals.advancePaise).toBe(totals.advancePaise);
            expect(listed.listTotals.advanceCustomers).toBe(rows.length);
          }
        }
      }
    },
    TIMEOUT,
  );

  it(
    "spreads each customer's due over their bills like the reference, and matches the read model now",
    async () => {
      const op = w.tenant.operatorId;
      for (const asOfDate of [undefined, "2026-10-31", "2026-08-15"]) {
        const asOf = resolveAsOf(NOW, asOfDate ? businessDate(asOfDate) : undefined);
        if (!asOf.ok) throw new Error("asOf");
        const balances = await ledgerBalances(t.current, op, asOf.value.cutoff);
        const bills = await unpaidBills(t.current, op, asOf.value.cutoff);
        const rows = [
          ...(await allRows(asOfDate ? { asOfDate } : {})),
          ...(await allRows({ ...(asOfDate ? { asOfDate } : {}), kind: "advance" })),
        ];
        const expectedIds = [...balances].filter(([, v]) => v !== 0).map(([id]) => id);
        expect(rows.map((row) => row.customerId).sort()).toEqual(expectedIds.sort());
        for (const row of rows) {
          const balance = balances.get(row.customerId) ?? 0;
          const reference = spreadDue(
            balance,
            (bills.get(row.customerId) ?? []).map((b) => ({ ...b, period: b.period as Period })),
            asOf.value.date,
          );
          expect(row.balancePaise).toBe(balance);
          expect(row.buckets).toEqual(reference.buckets);
          expect(row.oldestDuePeriod).toBe(balance > 0 ? reference.oldestPeriod : null);
        }
      }
      // As of now the ledger and the customer_balances read model agree.
      const model = await t.current.admin.query<{ customer_id: string; balance_paise: string }>(
        "SELECT customer_id, balance_paise::text FROM customer_balances WHERE operator_id = $1",
        [op],
      );
      const now = new Map(
        [...(await allRows()), ...(await allRows({ kind: "advance" }))].map((r) => [
          r.customerId,
          r.balancePaise,
        ]),
      );
      for (const row of model.rows) {
        expect(now.get(row.customer_id) ?? 0).toBe(Number(row.balance_paise));
      }
    },
    TIMEOUT,
  );

  it(
    "ages bills by IST month start: hand-checked numbers and the 31 Oct / 1 Nov boundary",
    async () => {
      // Now (2 Nov): October's bill is 32 days old.
      const now = await dues();
      expect(now.asOf).toEqual({ at: NOW, date: "2026-11-02", endOfDay: false });
      expect(now.totals).toEqual({
        dueCustomers: 5,
        duePaise: 405_000,
        buckets: { d0_30: 0, d31_60: 145_000, d61_90: 125_000, d90_plus: 135_000 },
        advanceCustomers: 1,
        advancePaise: 160_000,
        netPaise: 245_000,
        customersByBucket: { d0_30: 0, d31_60: 0, d61_90: 2, d90_plus: 3 },
      });
      const byCode = new Map(now.rows.map((row) => [row.customerCode, row]));
      expect(byCode.get("A-1")).toMatchObject({
        customerName: "Asha Devi",
        areaName: "North",
        duePaise: 100_000,
        advancePaise: 0,
        buckets: { d0_30: 0, d31_60: 30_000, d61_90: 30_000, d90_plus: 40_000 },
        oldestDuePeriod: "2026-07-01",
        oldestBucket: "d90_plus",
      });
      // Bina's ₹600 advance paid August and part of September.
      expect(byCode.get("B-2")).toMatchObject({
        duePaise: 60_000,
        buckets: { d0_30: 0, d31_60: 40_000, d61_90: 20_000, d90_plus: 0 },
        oldestDuePeriod: "2026-09-01",
        oldestBucket: "d61_90",
      });
      // Chandu's undone August payment: August is due again.
      expect(byCode.get("C-3")).toMatchObject({
        duePaise: 75_000,
        buckets: { d0_30: 0, d31_60: 25_000, d61_90: 25_000, d90_plus: 25_000 },
      });
      expect(byCode.get("G-6")).toMatchObject({
        duePaise: 70_000,
        buckets: { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 70_000 },
        oldestDuePeriod: "2026-06-01",
      });
      // Worst first: oldest unpaid month, then the bigger due.
      expect(now.rows.map((row) => row.customerCode)).toEqual(["G-6", "A-1", "C-3", "F-5", "B-2"]);

      // End of 31 Oct: October is 30 days old (0–30), September 60 (31–60), August 91 (90+).
      // Farid's ₹500 at 23:45 IST counts; the one at 00:15 IST on 1 Nov does not.
      const oct31 = await dues({ asOfDate: "2026-10-31" });
      expect(oct31.asOf).toEqual({
        at: ist("2026-11-01", "00:00"),
        date: "2026-10-31",
        endOfDay: true,
      });
      expect(oct31.totals.buckets).toEqual({
        d0_30: 145_000,
        d31_60: 125_000,
        d61_90: 0,
        d90_plus: 185_000,
      });
      expect(oct31.totals.netPaise).toBe(295_000);
      expect(oct31.rows.find((row) => row.customerCode === "F-5")?.buckets).toEqual({
        d0_30: 50_000,
        d31_60: 50_000,
        d61_90: 0,
        d90_plus: 50_000,
      });
      // End of 1 Nov: everything moves one bucket; Farid's second payment counts.
      const nov1 = await dues({ asOfDate: "2026-11-01" });
      expect(nov1.totals.buckets).toEqual({
        d0_30: 0,
        d31_60: 145_000,
        d61_90: 125_000,
        d90_plus: 135_000,
      });
      expect(nov1.totals.netPaise).toBe(245_000);

      // 15 Aug: Chandu's August payment was not undone yet (he owed nothing); Bina had ₹200
      // advance left.
      const aug15 = await dues({ asOfDate: "2026-08-15" });
      expect(aug15.rows.some((row) => row.customerCode === "C-3")).toBe(false);
      const aug15Advance = await dues({ asOfDate: "2026-08-15", kind: "advance" });
      expect(aug15Advance.rows.map((r) => [r.customerCode, r.advancePaise])).toEqual([
        ["D-4", 180_000],
        ["B-2", 20_000],
      ]);
      const aug31 = await dues({ asOfDate: "2026-08-31" });
      expect(aug31.rows.find((row) => row.customerCode === "C-3")?.duePaise).toBe(25_000);
    },
    TIMEOUT,
  );

  it(
    "filters by area, bucket and kind; totals by area; pages",
    async () => {
      const report = await dues();
      expect(report.areas.map((a) => a.name)).toEqual(["North", "South"]);
      expect(
        report.byArea.map((a) => [a.areaName, a.dueCustomers, a.duePaise, a.advancePaise]),
      ).toEqual([
        ["North", 3, 230_000, 0],
        ["South", 2, 175_000, 0],
        [null, 0, 0, 160_000],
      ]);
      const north = await dues({ areaId: w.north });
      expect(north.totals.duePaise).toBe(230_000);
      expect(north.byArea.map((a) => a.areaName)).toEqual(["North"]);
      expect(north.rows.every((row) => row.areaName === "North")).toBe(true);

      const old = await dues({ bucket: "d90_plus" });
      expect(old.rows.map((row) => row.customerCode)).toEqual(["G-6", "A-1", "C-3"]);
      expect(old.listTotals.duePaise).toBe(70_000 + 100_000 + 75_000);
      expect(old.listTotals.dueCustomers).toBe(3);
      // The page's totals of the whole report don't change with the list's filters.
      expect(old.totals).toEqual(report.totals);
      const none = await dues({ bucket: "d0_30" });
      expect(none.rows).toEqual([]);
      expect(none.listTotals.duePaise).toBe(0);

      const advance = await dues({ kind: "advance" });
      expect(advance.rows.map((r) => [r.customerCode, r.advancePaise, r.oldestBucket])).toEqual([
        ["D-4", 160_000, null],
      ]);
      expect(advance.listTotals.netPaise).toBe(-160_000);

      const page2 = await dues({ page: 2 });
      expect(page2.rows).toEqual([]);
      expect(page2.listTotals).toEqual(report.listTotals);
    },
    TIMEOUT,
  );

  it(
    "Staff may read it; a lineman may not; bad input and other areas are refused",
    async () => {
      const staff = await duesReport.call(w.rt(NOW), w.staff, {});
      expect(staff.ok).toBe(true);
      const lineman = await duesReport.call(w.rt(NOW), w.lineman, {});
      expect(lineman.ok ? "ok" : lineman.error.code).toBe("FORBIDDEN");
      const future = await duesReport.call(w.rt(NOW), w.owner, { asOfDate: "2026-11-03" });
      expect(future.ok ? "ok" : future.error.code).toBe("VALIDATION");
      const badDate = await duesReport.call(w.rt(NOW), w.owner, { asOfDate: "2026-02-30" });
      expect(badDate.ok ? "ok" : badDate.error.code).toBe("VALIDATION");
      const unknownArea = await duesReport.call(w.rt(NOW), w.owner, {
        areaId: "0192b4c8-0000-7000-8000-000000000000",
      });
      expect(unknownArea.ok ? "ok" : unknownArea.error.code).toBe("NOT_FOUND");
    },
    TIMEOUT,
  );
});

/**
 * The register reports (T-080) against the report world (`../dues/test-world.ts`: four months of
 * bills, payments, advance used by later bills, part payments and an undone payment, all through
 * the real services): totals equal the ledger for the same filters, the bill register agrees with
 * T-047's `listBills` month by month, filters, pages and roles.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import { listBills } from "../../billing/views";
import { buildReportWorld, NOW, PERIODS, type ReportWorld } from "../dues/test-world";
import { billRegisterReport } from "./bills";

const TIMEOUT = 120_000;

describeDb("reports.bill_register", () => {
  const t = useTestDatabase();
  let w: ReportWorld;

  beforeAll(async () => {
    w = await buildReportWorld(t.current);
  }, TIMEOUT);

  async function report(input: Parameters<typeof billRegisterReport.call>[2]) {
    const result = await billRegisterReport.call(w.rt(NOW), w.staff, input);
    if (!result.ok) throw new Error(`bill register: ${result.error.code}`);
    return result.value;
  }

  /** The ledger's view of the same bills: Σ their ledger entries and Σ their allocations. */
  async function ledgerOfBills(from: string, to: string, areaId?: string) {
    const result = await t.current.admin.query<{ charges: string; paid: string; n: number }>(
      `WITH b AS (
         SELECT i.id FROM invoices i
           JOIN customers c ON c.operator_id = i.operator_id AND c.id = i.customer_id
          WHERE i.operator_id = $1 AND i.period BETWEEN $2 AND $3
            AND ($4::uuid IS NULL OR c.area_id = $4::uuid))
       SELECT (SELECT coalesce(sum(amount_paise), 0) FROM ledger_entries
                WHERE invoice_id IN (SELECT id FROM b))::text AS charges,
              (SELECT coalesce(sum(amount_paise), 0) FROM allocations
                WHERE invoice_id IN (SELECT id FROM b))::text AS paid,
              (SELECT count(*)::int FROM b) AS n`,
      [w.tenant.operatorId, from, to, areaId ?? null],
    );
    const row = result.rows[0];
    return { charges: Number(row?.charges), paid: Number(row?.paid), count: row?.n ?? 0 };
  }

  it(
    "adds up to the ledger for every month range and area (advance, part payments, undo)",
    async () => {
      const ranges: [string, string][] = [
        ["2026-06-01", "2026-10-01"],
        ["2026-07-01", "2026-07-01"],
        ["2026-08-01", "2026-09-01"],
        ["2026-10-01", "2026-10-01"],
      ];
      for (const [from, to] of ranges) {
        for (const areaId of [undefined, w.north, w.south]) {
          const value = await report({ from, to, ...(areaId ? { areaId } : {}) });
          const ledger = await ledgerOfBills(from, to, areaId);
          const label = `${from}…${to} ${areaId ?? "all"}`;
          expect(value.totals.count, label).toBe(ledger.count);
          expect(value.totals.chargesPaise, label).toBe(ledger.charges);
          expect(value.totals.paidPaise, label).toBe(ledger.paid);
          expect(value.totals.outstandingPaise).toBe(ledger.charges - ledger.paid);
        }
      }
      // Every bill ever: still due − unused advance = the ledger balance of the tenant.
      const all = await report({ from: "2026-06-01", to: "2026-10-01" });
      expect(all.totals).toEqual({
        count: 21,
        chargesPaise: 70_000 + 4 * (30_000 + 40_000 + 25_000 + 10_000 + 50_000),
        paidPaise: 20_000 + 40_000 + 40_000 + 20_000 + 25_000 + 4 * 10_000 + 100_000,
        outstandingPaise: 405_000,
        byState: { unpaid: 10, part_paid: 2, paid: 9, no_charge: 0, void: 0 },
      });
      // ₹4,050 still due on bills, Dev's ₹1,600 advance unused: the ledger says ₹2,450.
      expect(all.totals.outstandingPaise - 160_000).toBe(245_000);
    },
    TIMEOUT,
  );

  it(
    "agrees with the Bills register (T-047 listBills) month by month",
    async () => {
      for (const period of PERIODS) {
        for (const areaId of [undefined, w.north]) {
          const ours = await report({ from: period, to: period, ...(areaId ? { areaId } : {}) });
          const theirs = await listBills.call(w.rt(NOW), w.staff, {
            period,
            ...(areaId ? { areaId } : {}),
          });
          if (!theirs.ok) throw new Error(theirs.error.code);
          expect(ours.totals.count).toBe(theirs.value.totals.count);
          expect(ours.totals.chargesPaise).toBe(theirs.value.totals.chargesPaise);
          expect(ours.totals.paidPaise).toBe(theirs.value.totals.paidPaise);
          expect(ours.totals.outstandingPaise).toBe(theirs.value.totals.outstandingPaise);
          const byId = (rows: readonly { id: string }[]) =>
            [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
          expect(byId(ours.rows)).toEqual(byId(theirs.value.rows));
        }
      }
    },
    TIMEOUT,
  );

  it(
    "shows rows newest month first, filters by pay state, pages and keeps totals over all pages",
    async () => {
      const oct = await report({ from: "2026-10-01", to: "2026-10-01" });
      expect(oct.asOf).toEqual({ at: NOW, date: "2026-11-02", endOfDay: false });
      expect(
        oct.rows.map((row) => [row.customer.code, row.payState, row.outstandingPaise]),
      ).toEqual([
        ["A-1", "unpaid", 30_000],
        ["B-2", "unpaid", 40_000],
        ["C-3", "unpaid", 25_000],
        ["D-4", "paid", 0],
        ["F-5", "unpaid", 50_000],
      ]);
      const range = await report({ from: "2026-07-01", to: "2026-10-01" });
      expect(range.rows[0]?.period).toBe("2026-10-01");
      expect(range.rows.at(-1)?.period).toBe("2026-07-01");

      // Chandu's August bill: paid, then the payment was undone.
      const aug = await report({ from: "2026-08-01", to: "2026-08-01", payState: "unpaid" });
      expect(aug.rows.map((row) => row.customer.code)).toEqual(["A-1", "C-3"]);
      expect(aug.totals).toMatchObject({ count: 2, chargesPaise: 55_000, paidPaise: 0 });
      expect(aug.totals.byState).toEqual({
        unpaid: 2,
        part_paid: 0,
        paid: 0,
        no_charge: 0,
        void: 0,
      });
      const part = await report({ from: "2026-07-01", to: "2026-10-01", payState: "part_paid" });
      expect(part.rows.map((row) => [row.customer.code, row.period, row.paidPaise])).toEqual([
        ["B-2", "2026-09-01", 20_000],
        ["A-1", "2026-07-01", 20_000],
      ]);

      const page2 = await report({ from: "2026-06-01", to: "2026-10-01", page: 2 });
      expect(page2.rows).toEqual([]);
      expect(page2.totals.count).toBe(21);
    },
    TIMEOUT,
  );

  it(
    "Owner and Staff may read it; a lineman may not; bad ranges and other areas are refused",
    async () => {
      const owner = await billRegisterReport.call(w.rt(NOW), w.owner, {
        from: "2026-10-01",
        to: "2026-10-01",
      });
      expect(owner.ok).toBe(true);
      const lineman = await billRegisterReport.call(w.rt(NOW), w.lineman, {
        from: "2026-10-01",
        to: "2026-10-01",
      });
      expect(lineman.ok ? "ok" : lineman.error.code).toBe("FORBIDDEN");
      for (const input of [
        { from: "2026-10-01", to: "2026-09-01" },
        { from: "2025-10-01", to: "2026-10-01" },
        { from: "2026-10-05", to: "2026-10-01" },
      ]) {
        const result = await billRegisterReport.call(w.rt(NOW), w.owner, input);
        expect(result.ok ? "ok" : result.error.code).toBe("VALIDATION");
      }
      const unknownArea = await billRegisterReport.call(w.rt(NOW), w.owner, {
        from: "2026-10-01",
        to: "2026-10-01",
        areaId: "0192b4c8-0000-7000-8000-000000000000",
      });
      expect(unknownArea.ok ? "ok" : unknownArea.error.code).toBe("NOT_FOUND");
    },
    TIMEOUT,
  );
});

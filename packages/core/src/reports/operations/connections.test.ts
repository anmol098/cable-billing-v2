/**
 * The connection status and rent report (T-081) against a real database (`test-world.ts`): every
 * connection on every day from late September to "now" is compared with T-040's
 * `assignmentStatusOn` / `rentalForPeriod`, hand-checked days, and the active rent on the 1st is
 * reconciled with the rent lines the month's bill run charged.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import {
  type AssignmentEvent,
  type AssignmentTimeline,
  addDays,
  assignmentStatusOn,
  type BusinessDate,
  businessDate,
  compareBusinessDates,
  periodEnd,
  periodOf,
  rentalForPeriod,
  toPaise,
} from "@cb/domain";
import { beforeAll, expect, it } from "vitest";
import { connectionsReport } from "./connections";
import { buildOperationsWorld, NOW, type OperationsWorld } from "./test-world";
import type { ConnectionReportRow, ConnectionsReport } from "./types";

const TIMEOUT = 120_000;

describeDb("reports.connections", () => {
  const t = useTestDatabase();
  let w: OperationsWorld;

  beforeAll(async () => {
    w = await buildOperationsWorld(t.current);
  }, TIMEOUT);

  async function report(
    input: Parameters<typeof connectionsReport.call>[2] = {},
  ): Promise<ConnectionsReport> {
    const result = await connectionsReport.call(w.rt(NOW), w.staff, input);
    if (!result.ok) throw new Error(`connections: ${result.error.code}`);
    return result.value;
  }

  async function allRows(input: Parameters<typeof connectionsReport.call>[2] = {}) {
    const rows: ConnectionReportRow[] = [];
    for (let page = 1; page < 50; page += 1) {
      const r = await report({ ...input, page });
      rows.push(...r.rows);
      if (r.rows.length < r.pageSize) break;
    }
    return rows;
  }

  /** The reference: T-040 on the rows as T-044's billing run maps them, plus the plan rule. */
  async function reference(day: BusinessDate) {
    const assignments = await t.current.admin.query<{
      id: string;
      start_date: string;
      end_date: string | null;
      plan_id: string | null;
      rental_amount_paise: string;
    }>(
      `SELECT id, start_date::text, end_date::text, plan_id, rental_amount_paise::text
         FROM vc_assignments WHERE operator_id = $1`,
      [w.tenant.operatorId],
    );
    const events = await t.current.admin.query<{
      assignment_id: string;
      type: AssignmentEvent["type"];
      effective_date: string;
      from_plan_id: string | null;
      to_plan_id: string | null;
      from_rental_paise: string | null;
      to_rental_paise: string | null;
    }>(
      `SELECT assignment_id, type, effective_date::text, from_plan_id, to_plan_id,
              from_rental_paise::text, to_rental_paise::text
         FROM assignment_events WHERE operator_id = $1 ORDER BY at, id`,
      [w.tenant.operatorId],
    );
    const result = new Map<string, { status: string; rent: number; planId: string | null }>();
    for (const a of assignments.rows) {
      const own = events.rows.filter((e) => e.assignment_id === a.id);
      const timeline: AssignmentTimeline = {
        startDate: businessDate(a.start_date),
        endDate: a.end_date === null ? null : businessDate(a.end_date),
        events: own.map(
          (e): AssignmentEvent =>
            e.type === "plan_changed"
              ? {
                  type: "plan_changed",
                  effectiveDate: businessDate(e.effective_date),
                  rentalPaise: toPaise(e.to_rental_paise ?? "0"),
                }
              : { type: e.type, effectiveDate: businessDate(e.effective_date) },
        ),
      };
      const status = assignmentStatusOn(timeline, day);
      if (status === "not_started") continue;
      const planChanges = own.filter((e) => e.type === "plan_changed");
      const initialRentalPaise = toPaise(
        planChanges[0]?.from_rental_paise ?? a.rental_amount_paise,
      );
      const rent = rentalForPeriod({ ...timeline, initialRentalPaise }, periodOf(day));
      const monthEnd = periodEnd(periodOf(day));
      const applied = planChanges
        .filter((e) => compareBusinessDates(businessDate(e.effective_date), monthEnd) <= 0)
        .sort((x, y) => x.effective_date.localeCompare(y.effective_date));
      const last = applied[applied.length - 1];
      const planId = last
        ? last.to_plan_id
        : planChanges[0]
          ? planChanges[0].from_plan_id
          : a.plan_id;
      result.set(a.id, { status, rent, planId });
    }
    return result;
  }

  it(
    "every connection on every day equals T-040's status and rent rules",
    async () => {
      let day = businessDate("2026-09-25");
      let compared = 0;
      while (compareBusinessDates(day, businessDate("2026-11-02")) <= 0) {
        const want = await reference(day);
        const rows = await allRows({ date: day });
        expect(rows.map((row) => row.assignmentId).sort(), day).toEqual([...want.keys()].sort());
        for (const row of rows) {
          const expected = want.get(row.assignmentId);
          expect([row.status, row.rentPaise, row.planId], `${day} ${row.customerCode}`).toEqual([
            expected?.status,
            expected?.rent,
            expected?.planId,
          ]);
          compared += 1;
        }
        day = addDays(day, 1);
      }
      expect(compared).toBeGreaterThan(200);
    },
    TIMEOUT,
  );

  it(
    "hand-checked days: since when, which plan and rent",
    async () => {
      const on = async (date: string) =>
        new Map(
          (await allRows({ date })).map((row) => [
            row.customerCode,
            [row.status, row.since, row.planName, row.rentPaise],
          ]),
        );
      // 5 Oct: Esha has not started; Bina's October rent is Basic ₹300 (changed during October).
      const oct5 = await on("2026-10-05");
      expect([...oct5.keys()]).toEqual(["A-1", "B-2", "C-3", "D-4", "F-6", "G-7"]);
      expect(oct5.get("B-2")).toEqual(["active", "2026-10-01", "Basic", 30_000]);
      // 15 Oct: Chandu's stop counts from the next day.
      expect((await on("2026-10-15")).get("C-3")).toEqual(["active", "2026-10-01", null, 25_000]);
      expect((await on("2026-10-16")).get("C-3")).toEqual([
        "suspended",
        "2026-10-16",
        null,
        25_000,
      ]);
      expect((await on("2026-10-26")).get("C-3")).toEqual(["active", "2026-10-26", null, 25_000]);
      // 31 Oct: Dev and Farid still on; 1 Nov: Dev removed, Farid stopped.
      const oct31 = await on("2026-10-31");
      expect(oct31.get("D-4")).toEqual(["active", "2026-10-01", "Basic", 30_000]);
      expect(oct31.get("F-6")).toEqual(["active", "2026-10-01", "Basic", 30_000]);
      const nov1 = await on("2026-11-01");
      expect(nov1.get("D-4")).toEqual(["disconnected", "2026-11-01", "Basic", 30_000]);
      expect(nov1.get("F-6")).toEqual(["suspended", "2026-11-01", "Basic", 30_000]);
      expect(nov1.get("E-5")).toEqual(["active", "2026-10-10", "Gold", 45_000]);

      const today = await report();
      expect(today.date).toBe("2026-11-02");
      expect(today.isToday).toBe(true);
      expect(today.totals).toEqual({
        connections: 7,
        byStatus: { active: 5, suspended: 1, disconnected: 1 },
        activeRentPaise: 30_000 + 30_000 + 25_000 + 45_000 + 10_000,
        activeCustomers: 5,
      });
      const removed = today.rows.find((row) => row.customerCode === "D-4");
      expect(removed?.endDate).toBe("2026-10-31");
      expect(removed?.areaName).toBeNull();
      expect(today.rows.find((row) => row.customerCode === "A-1")?.areaName).toBe("North");
      expect(today.areas.map((a) => a.name)).toEqual(["North", "South"]);
      expect(today.plans.map((p) => [p.name, p.monthlyAmountPaise, p.retired])).toEqual([
        ["Basic", 30_000, false],
        ["Gold", 45_000, false],
      ]);
    },
    TIMEOUT,
  );

  it(
    "the active rent on the 1st is what the month's bill run charged as rent",
    async () => {
      for (const period of ["2026-10-01", "2026-11-01"]) {
        const rows = await allRows({ date: period, status: "active" });
        const lines = await t.current.admin.query<{ customer_id: string; rent: string }>(
          `SELECT i.customer_id, sum(l.amount_paise)::text AS rent
             FROM billing_run_items it
             JOIN billing_runs r ON r.id = it.run_id
             JOIN invoices i ON i.id = it.invoice_id
             JOIN invoice_lines l ON l.invoice_id = i.id AND l.type = 'rent'
            WHERE r.operator_id = $1 AND r.period = $2 AND it.outcome = 'created'
            GROUP BY i.customer_id`,
          [w.tenant.operatorId, period],
        );
        expect(lines.rows.length, period).toBeGreaterThan(0);
        for (const billed of lines.rows) {
          const active = rows
            .filter((row) => row.customerId === billed.customer_id)
            .reduce((total, row) => total + row.rentPaise, 0);
          expect(active, `${period} ${billed.customer_id}`).toBe(Number(billed.rent));
        }
        // Customers with an active connection but no new bill: only Gopal in November (failed).
        const billedIds = new Set(lines.rows.map((row) => row.customer_id));
        const unbilled = [...new Set(rows.map((row) => row.customerCode))].filter(
          (code) => !billedIds.has(rows.find((row) => row.customerCode === code)?.customerId ?? ""),
        );
        expect(unbilled, period).toEqual(period === "2026-11-01" ? ["G-7"] : []);
      }
    },
    TIMEOUT,
  );

  it(
    "filters: area, status, plan, own amount; totals follow; pages",
    async () => {
      const north = await report({ areaId: w.north });
      expect(north.rows.map((row) => row.customerCode)).toEqual(["A-1", "B-2", "G-7"]);
      expect(north.totals.activeRentPaise).toBe(70_000);

      const stopped = await report({ status: "suspended" });
      expect(stopped.rows.map((row) => row.customerCode)).toEqual(["F-6"]);
      expect(stopped.totals).toEqual({
        connections: 1,
        byStatus: { active: 0, suspended: 1, disconnected: 0 },
        activeRentPaise: 0,
        activeCustomers: 0,
      });

      const gold = await report({ plan: w.gold });
      expect(gold.rows.map((row) => row.customerCode)).toEqual(["E-5"]);
      // In September's last days Bina's month had Gold, but she had not started; on 15 Oct her
      // October plan is Basic already (the change is in October).
      expect(
        (await report({ plan: w.gold, date: "2026-10-15" })).rows.map((r) => r.customerCode),
      ).toEqual(["E-5"]);
      const own = await report({ plan: "own" });
      expect(own.rows.map((row) => row.customerCode)).toEqual(["C-3", "G-7"]);

      const page2 = await report({ page: 2 });
      expect(page2.rows).toEqual([]);
      expect(page2.totals.connections).toBe(7);
    },
    TIMEOUT,
  );

  it(
    "roles and refusals",
    async () => {
      const owner = await connectionsReport.call(w.rt(NOW), w.owner, {});
      expect(owner.ok).toBe(true);
      const lineman = await connectionsReport.call(w.rt(NOW), w.ravi.ctx, {});
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
      const future = await connectionsReport.call(w.rt(NOW), w.owner, { date: "2026-11-03" });
      expect(future).toMatchObject({
        ok: false,
        error: { code: "VALIDATION", details: { fields: [{ path: "date", code: "future" }] } },
      });
      const madeUp = "0190a000-0000-7000-8000-000000000000";
      const area = await connectionsReport.call(w.rt(NOW), w.owner, { areaId: madeUp });
      expect(!area.ok && area.error.code).toBe("NOT_FOUND");
      const plan = await connectionsReport.call(w.rt(NOW), w.owner, { plan: madeUp });
      expect(!plan.ok && plan.error.code).toBe("NOT_FOUND");
      const bad = await connectionsReport.call(w.rt(NOW), w.owner, { plan: "gold" });
      expect(!bad.ok && bad.error.code).toBe("VALIDATION");
    },
    TIMEOUT,
  );
});

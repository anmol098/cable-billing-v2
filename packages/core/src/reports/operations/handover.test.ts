/**
 * The cash handover report (T-081) against a real database (`test-world.ts`): expected vs handed
 * over, the difference and its reason, the status and every step of what happened, reconciled with
 * T-062's Linemen services and the payments themselves (UPI and undone payments are never cash).
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import { getLinemanDay } from "../../collections/day";
import { recomputeTotals } from "../../collections/test-support";
import { collectionsReport } from "./collections";
import { handoverReport } from "./handover";
import { buildOperationsWorld, ist, NOW, type OperationsWorld } from "./test-world";
import type { HandoverReport } from "./types";

const TIMEOUT = 120_000;

describeDb("reports.handover", () => {
  const t = useTestDatabase();
  let w: OperationsWorld;

  beforeAll(async () => {
    w = await buildOperationsWorld(t.current);
  }, TIMEOUT);

  async function report(
    input: Parameters<typeof handoverReport.call>[2] = {},
    now = NOW,
  ): Promise<HandoverReport> {
    const result = await handoverReport.call(w.rt(now), w.staff, input);
    if (!result.ok) throw new Error(`handover: ${result.error.code}`);
    return result.value;
  }

  it(
    "hand-checked: expected vs handed over, difference, reason, status and what happened",
    async () => {
      const r = await report();
      // Default: the last 7 days up to today.
      expect([r.from, r.to]).toEqual(["2026-10-27", "2026-11-02"]);
      expect(
        r.rows.map((row) => [
          row.businessDate,
          row.linemanName,
          row.status,
          row.cashExpectedPaise,
          row.upiTotalPaise,
          row.paymentCount,
          row.handover?.cashExpectedPaise ?? null,
          row.handover?.cashHandedOverPaise ?? null,
          row.handover?.discrepancyPaise ?? null,
          row.handover?.discrepancyReason ?? null,
          row.changedSinceHandover,
        ]),
      ).toEqual([
        ["2026-11-01", "Ravi Kumar", "open", 10_000, 45_000, 2, null, null, null, null, false],
        // Waiting first on a day: Suresh handed over ₹550 of ₹600; Farid's ₹300 was undone later.
        [
          "2026-10-31",
          "Suresh Pal",
          "submitted",
          30_000,
          0,
          1,
          60_000,
          55_000,
          -5_000,
          "short",
          true,
        ],
        ["2026-10-31", "Ravi Kumar", "accepted", 55_000, 30_000, 3, 55_000, 55_000, 0, null, false],
      ]);

      const ravi = r.rows[2];
      expect(ravi?.handover?.reviewedByName).toBe("Owner Om");
      expect(ravi?.handover?.reviewedAt).toEqual(ist("2026-11-01", "10:00"));
      expect(ravi?.handover?.submittedAt).toEqual(ist("2026-11-01", "09:30"));
      expect(
        ravi?.history.map((e) => [
          e.type,
          e.actorName,
          e.at.toISOString(),
          e.cashExpectedPaise,
          e.cashHandedOverPaise,
          e.discrepancyPaise,
          e.discrepancyReason,
          e.note,
        ]),
      ).toEqual([
        [
          "submitted",
          "Ravi Kumar",
          ist("2026-11-01", "00:30").toISOString(),
          55_000,
          50_000,
          -5_000,
          "short",
          null,
        ],
        [
          "returned",
          "Owner Om",
          ist("2026-11-01", "09:00").toISOString(),
          null,
          null,
          null,
          null,
          "Count the cash again",
        ],
        [
          "submitted",
          "Ravi Kumar",
          ist("2026-11-01", "09:30").toISOString(),
          55_000,
          55_000,
          0,
          null,
          null,
        ],
        [
          "accepted",
          "Owner Om",
          ist("2026-11-01", "10:00").toISOString(),
          null,
          null,
          null,
          null,
          null,
        ],
      ]);
      expect(r.rows[0]?.history).toEqual([]);

      expect(r.totals).toEqual({
        days: 3,
        cashExpectedPaise: 95_000,
        upiTotalPaise: 75_000,
        cashHandedOverPaise: 110_000,
        notHandedOverPaise: 10_000,
        shortPaise: 5_000,
        extraPaise: 0,
        differenceCount: 1,
        byStatus: { open: 1, submitted: 1, accepted: 1, returned: 0 },
      });
      // Linemen of the business (any status) are the filter's options; office users are not.
      expect(r.linemen.map((u) => u.name)).toEqual(["Lal Singh", "Ravi Kumar", "Suresh Pal"]);
    },
    TIMEOUT,
  );

  it(
    "every row equals T-062's lineman day; Σ cash expected = the linemen's phone cash payments",
    async () => {
      const r = await report({ from: "2026-10-03", to: "2026-11-02" });
      for (const row of r.rows) {
        const day = await getLinemanDay.call(w.rt(NOW), w.owner, {
          linemanId: row.linemanId,
          businessDate: row.businessDate,
        });
        if (!day.ok) throw new Error(day.error.code);
        const view = day.value;
        expect(row.sessionId).toBe(view.day.sessionId);
        expect(row.status).toBe(view.day.status);
        expect(row.cashExpectedPaise).toBe(view.day.cashExpectedPaise);
        expect(row.upiTotalPaise).toBe(view.day.upiTotalPaise);
        expect(row.paymentCount).toBe(view.day.paymentCount);
        expect(row.changedSinceHandover).toBe(view.changedSinceHandover);
        expect(row.handover?.cashExpectedPaise ?? null).toBe(
          view.day.handover?.cashExpectedPaise ?? null,
        );
        expect(row.handover?.cashHandedOverPaise ?? null).toBe(
          view.day.handover?.cashHandedOverPaise ?? null,
        );
        expect(row.handover?.discrepancyPaise ?? null).toBe(
          view.day.handover?.discrepancyPaise ?? null,
        );
        expect(row.history.map((e) => e.id)).toEqual(view.history.map((e) => e.id));

        // The rule from the payments themselves: phone payments, not undone; UPI apart.
        const truth = await t.current.db.withTenant(w.tenant.operatorId, (tx) =>
          recomputeTotals(tx, w.tenant.operatorId, row.linemanId, row.businessDate),
        );
        expect(row.cashExpectedPaise).toBe(truth.cash);
        expect(row.upiTotalPaise).toBe(truth.upi);
      }

      // Σ cash expected = the collections report's cash of the linemen for the same days.
      const collections = await collectionsReport.call(w.rt(NOW), w.owner, {
        from: "2026-10-03",
        to: "2026-11-02",
      });
      if (!collections.ok) throw new Error(collections.error.code);
      const linemenCash = collections.value.byCollector
        .filter((p) => p.role === "lineman")
        .reduce((total, p) => total + p.cashPaise, 0);
      const linemenUpi = collections.value.byCollector
        .filter((p) => p.role === "lineman")
        .reduce((total, p) => total + p.upiPaise, 0);
      expect(r.totals.cashExpectedPaise).toBe(linemenCash);
      expect(r.totals.upiTotalPaise).toBe(linemenUpi);
      expect(r.totals.cashExpectedPaise).toBe(
        r.rows.reduce((s, row) => s + row.cashExpectedPaise, 0),
      );
    },
    TIMEOUT,
  );

  it(
    "filters: lineman, status, difference; the totals follow them",
    async () => {
      const ravi = await report({ linemanId: w.ravi.userId });
      expect(ravi.rows.map((row) => [row.businessDate, row.status])).toEqual([
        ["2026-11-01", "open"],
        ["2026-10-31", "accepted"],
      ]);
      expect(ravi.totals.cashExpectedPaise).toBe(65_000);
      expect(ravi.totals.cashHandedOverPaise).toBe(55_000);

      const waiting = await report({ status: "submitted" });
      expect(waiting.rows.map((row) => row.linemanName)).toEqual(["Suresh Pal"]);
      expect(waiting.totals.byStatus).toEqual({ open: 0, submitted: 1, accepted: 0, returned: 0 });

      const short = await report({ difference: "short" });
      expect(short.rows.map((row) => row.linemanName)).toEqual(["Suresh Pal"]);
      expect(short.totals.shortPaise).toBe(5_000);
      const extra = await report({ difference: "extra" });
      expect(extra.rows).toEqual([]);
      expect(extra.totals.days).toBe(0);

      // A lineman with no day: no rows; an office user is not a lineman but is no other tenant's.
      expect((await report({ linemanId: w.lineman.userId })).rows).toEqual([]);
      expect((await report({ linemanId: w.staff.userId })).rows).toEqual([]);

      // Only 1 Nov.
      const nov1 = await report({ from: "2026-11-01", to: "2026-11-01" });
      expect(nov1.rows.map((row) => row.linemanName)).toEqual(["Ravi Kumar"]);

      // Page 2: no rows, same totals.
      const page2 = await report({ page: 2 });
      expect(page2.rows).toEqual([]);
      expect(page2.totals.days).toBe(3);
    },
    TIMEOUT,
  );

  it(
    "roles and refusals",
    async () => {
      const owner = await handoverReport.call(w.rt(NOW), w.owner, {});
      expect(owner.ok).toBe(true);
      const lineman = await handoverReport.call(w.rt(NOW), w.ravi.ctx, {});
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
      const unknown = await handoverReport.call(w.rt(NOW), w.owner, {
        linemanId: "0190a000-0000-7000-8000-000000000000",
      });
      expect(!unknown.ok && unknown.error.code).toBe("NOT_FOUND");
      const future = await handoverReport.call(w.rt(NOW), w.owner, { to: "2026-11-03" });
      expect(!future.ok && future.error.code).toBe("VALIDATION");
      const tooLong = await handoverReport.call(w.rt(NOW), w.owner, {
        from: "2026-09-01",
        to: "2026-10-31",
      });
      expect(!tooLong.ok && tooLong.error.code).toBe("VALIDATION");
    },
    TIMEOUT,
  );
});

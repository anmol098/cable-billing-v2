/**
 * The bill run report (T-081) against a real database (`test-world.ts`, two runs made by T-044's
 * service and job worker): who was billed, had nothing to bill or a problem and why; the totals
 * reconciled with the run's own counters, the bills' ledger entries and T-047's problem list.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import { billingRunProblems } from "../../billing/views";
import { billingRunReport } from "./billing-runs";
import { buildOperationsWorld, NOW, type OperationsWorld } from "./test-world";
import type { BillingRunReport } from "./types";

const TIMEOUT = 120_000;

describeDb("reports.billing_runs", () => {
  const t = useTestDatabase();
  let w: OperationsWorld;

  beforeAll(async () => {
    w = await buildOperationsWorld(t.current);
  }, TIMEOUT);

  async function report(
    input: Parameters<typeof billingRunReport.call>[2] = {},
  ): Promise<BillingRunReport> {
    const result = await billingRunReport.call(w.rt(NOW), w.staff, input);
    if (!result.ok) throw new Error(`billing runs: ${result.error.code}`);
    return result.value;
  }

  async function ledgerOfInvoices(invoiceIds: readonly string[]) {
    const result = await t.current.admin.query<{ total: string }>(
      `SELECT coalesce(sum(amount_paise), 0)::text AS total FROM ledger_entries
        WHERE operator_id = $1 AND type = 'invoice' AND invoice_id = ANY($2::uuid[])`,
      [w.tenant.operatorId, invoiceIds],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  it(
    "the latest month by default: new bills, nothing to bill, a problem; problems first",
    async () => {
      const r = await report();
      expect(r.period).toBe("2026-11-01");
      expect(r.runs.map((run) => [run.period, run.status])).toEqual([
        ["2026-11-01", "completed_with_errors"],
        ["2026-10-01", "completed"],
      ]);
      expect(r.run).toMatchObject({
        period: "2026-11-01",
        status: "completed_with_errors",
        trigger: "manual",
        skipReason: null,
        startedByName: "Owner Om",
      });
      expect(
        r.rows.map((row) => [
          row.customerCode,
          row.outcome,
          row.reason,
          row.chargesPaise,
          row.invoiceNumber?.startsWith("INV-2611-") ?? null,
        ]),
      ).toEqual([
        ["G-7", "failed", "balance_mismatch", null, null],
        ["F-6", "skipped", "nothing_to_bill", null, null],
        ["A-1", "created", null, 30_000, true],
        ["B-2", "created", null, 30_000, true],
        ["C-3", "created", null, 25_000, true],
        ["E-5", "created", null, 45_000, true],
      ]);
      expect(r.rows[0]).toMatchObject({ areaName: "North", attempts: 1 });
      expect(r.totals).toEqual({
        customers: 6,
        byOutcome: { created: 4, already_exists: 0, skipped: 1, failed: 1 },
        createdChargesPaise: 130_000,
        alreadyExistsChargesPaise: 0,
      });
    },
    TIMEOUT,
  );

  it(
    "totals equal the run's counters, the bills' ledger entries and T-047's problem list",
    async () => {
      for (const period of ["2026-10-01", "2026-11-01"] as const) {
        const r = await report({ period });
        const run = r.run;
        if (!run) throw new Error(`no run for ${period}`);
        expect(r.totals.customers, period).toBe(run.customerCount);
        expect(r.totals.byOutcome, period).toEqual({
          created: run.createdCount,
          already_exists: run.alreadyExistsCount,
          skipped: run.skippedCount,
          failed: run.failedCount,
        });
        expect(r.totals.createdChargesPaise, period).toBe(run.totalChargesPaise);
        const created = r.rows.filter((row) => row.outcome === "created");
        expect(created.reduce((s, row) => s + (row.chargesPaise ?? 0), 0)).toBe(
          r.totals.createdChargesPaise,
        );
        expect(await ledgerOfInvoices(created.map((row) => row.invoiceId ?? ""))).toBe(
          r.totals.createdChargesPaise,
        );

        const problems = await billingRunProblems.call(w.rt(NOW), w.owner, { runId: run.id });
        if (!problems.ok) throw new Error(problems.error.code);
        expect(
          r.rows
            .filter((row) => row.outcome === "failed")
            .map((row) => [row.customerId, row.reason, row.attempts]),
        ).toEqual(problems.value.problems.map((p) => [p.customer.id, p.reason, p.attempts]));
      }
      const oct = await report({ period: "2026-10-01" });
      expect(oct.rows.map((row) => [row.customerCode, row.outcome])).toEqual([
        ["A-1", "created"],
        ["B-2", "created"],
        ["C-3", "created"],
        ["D-4", "created"],
        ["F-6", "created"],
        ["G-7", "created"],
      ]);
      expect(oct.totals.createdChargesPaise).toBe(
        30_000 + 30_000 + 25_000 + 30_000 + 30_000 + 10_000,
      );
    },
    TIMEOUT,
  );

  it(
    "filters: outcome and area; a month without a run",
    async () => {
      const failed = await report({ outcome: "failed" });
      expect(failed.rows.map((row) => row.customerCode)).toEqual(["G-7"]);
      expect(failed.totals.customers).toBe(1);
      expect(failed.totals.createdChargesPaise).toBe(0);

      const south = await report({ areaId: w.south });
      expect(south.rows.map((row) => row.customerCode)).toEqual(["F-6", "C-3", "E-5"]);
      expect(south.totals.byOutcome).toEqual({
        created: 2,
        already_exists: 0,
        skipped: 1,
        failed: 0,
      });
      expect(south.totals.createdChargesPaise).toBe(70_000);

      const september = await report({ period: "2026-09-01" });
      expect(september.run).toBeNull();
      expect(september.rows).toEqual([]);
      expect(september.totals.customers).toBe(0);
      expect(september.runs).toHaveLength(2);

      const page2 = await report({ page: 2 });
      expect(page2.rows).toEqual([]);
      expect(page2.totals.customers).toBe(6);
    },
    TIMEOUT,
  );

  it(
    "roles and refusals",
    async () => {
      const owner = await billingRunReport.call(w.rt(NOW), w.owner, {});
      expect(owner.ok).toBe(true);
      const lineman = await billingRunReport.call(w.rt(NOW), w.ravi.ctx, {});
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
      const area = await billingRunReport.call(w.rt(NOW), w.owner, {
        areaId: "0190a000-0000-7000-8000-000000000000",
      });
      expect(!area.ok && area.error.code).toBe("NOT_FOUND");
      const notAMonth = await billingRunReport.call(w.rt(NOW), w.owner, { period: "2026-11-02" });
      expect(!notAMonth.ok && notAMonth.error.code).toBe("VALIDATION");
    },
    TIMEOUT,
  );
});

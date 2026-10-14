/**
 * The payment register report (T-080) reuses T-048's `listPayments` (one payment register for the
 * Payments section and the Reports page). Here its totals are checked against the ledger on the
 * report world: for any days, method and "taken by", counted cash + UPI = −Σ the ledger entries of
 * those payments and their undos (FR-023); IST day boundaries.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import { listPayments } from "../../payment-register";
import { buildReportWorld, NOW, type ReportWorld } from "../dues/test-world";

const TIMEOUT = 120_000;

describeDb("payment register report: totals = ledger", () => {
  const t = useTestDatabase();
  let w: ReportWorld;

  beforeAll(async () => {
    w = await buildReportWorld(t.current);
  }, TIMEOUT);

  /** −Σ ledger (payment + undo entries) of the payments matching the same filters. */
  async function ledgerOfPayments(filter: {
    from?: string;
    to?: string;
    method?: "cash" | "upi";
    collectorId?: string;
  }) {
    const result = await t.current.admin.query<{ total: string }>(
      `SELECT coalesce(-sum(l.amount_paise), 0)::text AS total
         FROM ledger_entries l
         JOIN payments p ON p.operator_id = l.operator_id
          AND p.id = coalesce(l.payment_id,
                (SELECT r.payment_id FROM payment_reversals r WHERE r.id = l.payment_reversal_id))
        WHERE l.operator_id = $1 AND l.type IN ('payment', 'payment_reversal')
          AND ($2::date IS NULL OR p.business_date >= $2::date)
          AND ($3::date IS NULL OR p.business_date <= $3::date)
          AND ($4::payment_method IS NULL OR p.method = $4::payment_method)
          AND ($5::uuid IS NULL OR p.collector_id = $5::uuid)`,
      [
        w.tenant.operatorId,
        filter.from ?? null,
        filter.to ?? null,
        filter.method ?? null,
        filter.collectorId ?? null,
      ],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async function register(input: Parameters<typeof listPayments.call>[2]) {
    const result = await listPayments.call(w.rt(NOW), w.staff, input);
    if (!result.ok) throw new Error(`payments: ${result.error.code}`);
    return result.value;
  }

  it(
    "counted cash + UPI equal the ledger for every range, method and collector",
    async () => {
      const filters = [
        {},
        { from: "2026-07-01", to: "2026-07-31" },
        { from: "2026-08-01", to: "2026-08-31" },
        { from: "2026-10-31", to: "2026-10-31" },
        { from: "2026-11-01", to: "2026-11-02" },
        { method: "cash" as const },
        { method: "upi" as const },
        { collectorId: w.tenant.users.owner },
        { collectorId: w.tenant.users.staff },
      ];
      for (const filter of filters) {
        const value = await register(filter);
        const counted = value.totals.cashPaise + value.totals.upiPaise;
        expect(counted, JSON.stringify(filter)).toBe(await ledgerOfPayments(filter));
      }
    },
    TIMEOUT,
  );

  it(
    "hand-checked totals: the undone payment is listed but not counted; IST days",
    async () => {
      const all = await register({});
      expect(all.totals).toEqual({
        count: 7,
        cashPaise: 200_000 + 25_000 + 20_000 + 50_000 + 50_000,
        upiPaise: 100_000,
        cancelledCount: 1,
        toCheckCount: 0,
      });
      const aug = await register({ from: "2026-08-01", to: "2026-08-31" });
      expect(aug.totals).toMatchObject({ count: 2, cashPaise: 20_000, cancelledCount: 1 });
      expect(aug.rows.find((row) => row.cancelled)?.id).toBe(w.undonePaymentId);
      // 31 Oct 23:45 IST is 31 Oct; 1 Nov 00:15 IST is 1 Nov (both 31 Oct in UTC).
      const oct31 = await register({ from: "2026-10-31", to: "2026-10-31" });
      expect(oct31.totals).toMatchObject({ count: 1, cashPaise: 50_000 });
      const nov1 = await register({ from: "2026-11-01", to: "2026-11-01" });
      expect(nov1.totals).toMatchObject({ count: 1, cashPaise: 50_000 });
      expect(nov1.rows[0]?.collectorName).toBeTruthy();
    },
    TIMEOUT,
  );
});

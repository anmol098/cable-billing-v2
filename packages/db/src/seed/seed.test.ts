/**
 * `seedDatabase` against real, migrated databases (T-036): every generated row lands, every
 * account read back from the tables passes T-041's `checkLedger`, a database with data is refused,
 * and seeding works through a non-owner login role (RLS and the append-only triggers apply).
 */
import { businessDate } from "@cb/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../client";
import { describeDb, useTestDatabase } from "../testing";
import { generateSeed, SeedRefusedError, type SeedResult, seedDatabase } from "./seed";
import { verifyLedgerSample } from "./verify";

const AS_OF = businessDate("2026-10-13");

describeDb("seedDatabase (small) as the owner", () => {
  const t = useTestDatabase();
  let result: SeedResult;

  beforeAll(async () => {
    result = await seedDatabase(t.current.db, {
      scale: "small",
      seed: 3,
      asOf: AS_OF,
      verifyPerOperator: 0,
    });
  }, 120_000);

  it("writes exactly the generated rows, and the same seed gives the same data", async () => {
    for (const [table, expected] of Object.entries(result.counts)) {
      const { rows } = await t.current.admin.query<{ n: string }>(
        `select count(*)::text as n from "${table}"`,
      );
      expect(Number(rows[0]?.n), table).toBe(expected);
    }
    expect(result.counts.customers).toBe(150);
    expect(result.counts.invoices).toBeGreaterThan(1_000);
    expect(result.hash).toBe(generateSeed({ scale: "small", seed: 3, asOf: AS_OF }).hash);
  });

  it("every seeded customer passes checkLedger on the rows read back", async () => {
    const report = await verifyLedgerSample(t.current.db, {
      perOperator: Number.POSITIVE_INFINITY,
    });
    expect(report.checked).toBe(150);
    expect(report.failures).toEqual([]);
  }, 60_000);

  it("keeps the database's own invariants: balances = Σ ledger, outstanding ≥ 0, VC reuse", async () => {
    const { rows } = await t.current.admin.query<{
      mismatched: string;
      negative: string;
      reused: string;
    }>(`
      select
        (select count(*) from customer_balances b
           left join (select customer_id, sum(amount_paise) s from ledger_entries group by 1) l using (customer_id)
          where b.balance_paise <> coalesce(l.s, 0))::text as mismatched,
        (select count(*) from invoices i
           left join (select invoice_id, sum(amount_paise) s from allocations group by 1) a on a.invoice_id = i.id
          where i.charges_paise - coalesce(a.s, 0) < 0)::text as negative,
        (select count(*) from (select vc_asset_id from vc_assignments group by 1 having count(*) > 1) r)::text as reused
    `);
    expect(rows[0]).toMatchObject({ mismatched: "0", negative: "0" });
    expect(Number(rows[0]?.reused)).toBeGreaterThan(0);
    const names = await t.current.admin.query<{ name: string; n: string }>(
      "select name, count(*)::text as n from operators group by name having count(*) > 1",
    );
    expect(names.rows).toEqual([{ name: "Shiv Cable Network", n: "2" }]);
  });

  it("refuses a database that already has data", async () => {
    await expect(
      seedDatabase(t.current.db, { scale: "small", seed: 4, asOf: AS_OF }),
    ).rejects.toBeInstanceOf(SeedRefusedError);
  });
});

describeDb("seedDatabase through a non-owner login role (shape B)", () => {
  const t = useTestDatabase();

  it("seeds and verifies with only app_rw / app_platform rights: RLS is never bypassed", async () => {
    const role = await t.current.createLoginRole();
    const db = createDb({ connectionString: role.url, max: 3 });
    try {
      const result = await seedDatabase(db, {
        scale: "small",
        seed: 5,
        asOf: AS_OF,
        months: 3,
        verifyPerOperator: Number.POSITIVE_INFINITY,
      });
      expect(result.verified).toEqual({ checked: 150, failures: 0 });
      expect(result.counts.billing_runs).toBe(9);
    } finally {
      await db.end();
    }
  }, 120_000);
});

describe("seed options", () => {
  it("defaults asOf to today (IST)", () => {
    const { operators } = generateSeed({ scale: "small", seed: 1, months: 1 });
    expect(operators.flatMap((op) => op.data.billingRuns)).toHaveLength(3);
  });
});

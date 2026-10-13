/**
 * Search performance check (T-033 acceptance: "Search returns results < 300 ms on 10k
 * customers"). Off by default (it seeds 30,000 customers); run it with
 *
 * ```bash
 * CB_SEARCH_BENCH=1 DATABASE_URL=… pnpm --filter @cb/core exec vitest run src/customers/search.bench.test.ts
 * ```
 *
 * Seeds one tenant with 10,000 customers (codes 1…10000, ≈30 % Devanagari names, mobile numbers,
 * a VC per customer, balances, 12 areas) plus two other tenants with 10,000 each (the trigram
 * index on names is shared by all tenants), runs ANALYZE, then times typical searches through
 * the service (median of 7 calls, including the transaction) and prints EXPLAIN ANALYZE timings.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { customerSearchSql, SearchCustomersInput, searchCustomers } from "./queries";
import { NAME_SIMILARITY_THRESHOLD } from "./rules";

const BENCH = process.env.CB_SEARCH_BENCH === "1";
const CUSTOMERS = 10_000;
const LIMIT_MS = 300;

const describeBench = BENCH ? describeDb : describe.skip;

describeBench("customers.search on 10k customers", () => {
  const t = useTestDatabase();
  let tenant: SeededTenant;
  let rt: ServiceRuntime;
  let staff: TenantContext;
  let sample: { phone: string; vc: string; areaId: string };

  async function seedCustomers(operatorId: string, count: number) {
    await t.current.admin.query(
      `INSERT INTO areas (id, operator_id, name)
       SELECT gen_random_uuid(), $1, 'Area ' || n FROM generate_series(1, 12) n`,
      [operatorId],
    );
    await t.current.admin.query(
      `WITH first AS (SELECT ARRAY['Ramesh','Suresh','Sunita','Anita','Mohan','Rakesh','Geeta',
          'Sanjay','Pooja','Vijay','Kavita','Amit','Neha','Rajesh','Manoj','Rekha','रमेश','सुनीता',
          'मोहन','गीता','राजेश','पूजा','अनिल','सीमा'] AS a),
        last AS (SELECT ARRAY['Kumar','Sharma','Verma','Gupta','Yadav','Singh','Devi','Patel',
          'Jain','Mishra','शर्मा','वर्मा','यादव','सिंह','देवी','गुप्ता'] AS a),
        ar AS (SELECT array_agg(id ORDER BY name) AS a FROM areas WHERE operator_id = $1)
       INSERT INTO customers (id, operator_id, customer_code, name, phone, area_id, status)
       SELECT gen_random_uuid(), $1, n::text,
         first.a[1 + (n * 7) % array_length(first.a, 1)] || ' ' ||
           last.a[1 + (n * 13) % array_length(last.a, 1)],
         CASE WHEN n % 10 = 0 THEN NULL ELSE (7000000000 + (n::bigint * 2654435761) % 2999999999)::text END,
         ar.a[1 + n % 12],
         CASE WHEN n % 9 = 0 THEN 'inactive'::customer_status ELSE 'active' END
       FROM generate_series(1, $2::int) n, first, last, ar`,
      [operatorId, count],
    );
    await t.current.admin.query(
      `INSERT INTO vc_assets (id, operator_id, vc_number)
       SELECT gen_random_uuid(), $1, lpad(((c.customer_code::bigint * 7919) % 999999999989)::text, 12, '0')
       FROM customers c WHERE c.operator_id = $1`,
      [operatorId],
    );
    await t.current.admin.query(
      `INSERT INTO vc_assignments (id, operator_id, vc_asset_id, customer_id, start_date, rental_amount_paise)
       SELECT gen_random_uuid(), $1, v.id, c.id, '2026-01-01', 30000
       FROM customers c
       JOIN vc_assets v ON v.operator_id = c.operator_id
         AND v.vc_number = lpad(((c.customer_code::bigint * 7919) % 999999999989)::text, 12, '0')
       WHERE c.operator_id = $1`,
      [operatorId],
    );
    await t.current.admin.query(
      `INSERT INTO customer_balances (customer_id, operator_id, balance_paise, credit_paise)
       SELECT id, operator_id, ((customer_code::int * 37) % 200) * 100 - 2000, 0
       FROM customers WHERE operator_id = $1`,
      [operatorId],
    );
  }

  beforeAll(async () => {
    tenant = await seedTenant(t.current);
    await seedCustomers(tenant.operatorId, CUSTOMERS);
    for (let i = 0; i < 2; i += 1) {
      const other = await seedTenant(t.current);
      await seedCustomers(other.operatorId, CUSTOMERS);
    }
    await t.current.admin.query(
      "ANALYZE customers, vc_assets, vc_assignments, customer_balances, areas",
    );
    const row = await t.current.admin.query<{ phone: string; vc: string; area: string }>(
      `SELECT c.phone, v.vc_number AS vc, c.area_id AS area FROM customers c
       JOIN vc_assignments s ON s.customer_id = c.id JOIN vc_assets v ON v.id = s.vc_asset_id
       WHERE c.operator_id = $1 AND c.customer_code = '4521'`,
      [tenant.operatorId],
    );
    const found = row.rows[0];
    if (!found) throw new Error("bench seed: customer 4521 missing");
    sample = { phone: found.phone, vc: found.vc, areaId: found.area };
    rt = testRuntime(t.current.db);
    staff = await contextFor(rt, tenant, "staff");
  }, 600_000);

  it("answers typical searches well under 300 ms", async () => {
    const queries: [string, Record<string, unknown>][] = [
      ["list, first page", {}],
      ["list, page 101 (offset 5000)", { offset: 5_000 }],
      ["list, area + active", { areaId: sample.areaId, status: "active" }],
      ["exact code 4521", { q: "4521" }],
      ["code prefix 45", { q: "45" }],
      ["one letter r", { q: "r" }],
      ["phone prefix (5 digits)", { q: sample.phone.slice(0, 5) }],
      ["full phone", { q: sample.phone }],
      ["last 4 phone digits", { q: sample.phone.slice(-4) }],
      ["VC prefix (6 digits)", { q: sample.vc.slice(0, 6) }],
      ["full VC number", { q: sample.vc }],
      ["name ramesh", { q: "ramesh" }],
      ["name typo ramsh", { q: "ramsh" }],
      ["two words sunita devi", { q: "sunita devi" }],
      ["Hindi रमेश", { q: "रमेश" }],
      ["name + area", { q: "kumar", areaId: sample.areaId }],
    ];
    const lines: string[] = [];
    for (const [label, input] of queries) {
      const times: number[] = [];
      let count = 0;
      for (let i = 0; i < 7; i += 1) {
        const started = performance.now();
        const result = await searchCustomers.call(rt, staff, input);
        times.push(performance.now() - started);
        if (!result.ok) throw new Error(`${label}: ${result.error.code}`);
        count = result.value.rows.length;
      }
      times.sort((a, b) => a - b);
      const median = times[3] ?? Number.NaN;
      const command = SearchCustomersInput.parse(input);
      const plan = await t.current.db.withTenant(tenant.operatorId, async (tx) => {
        await tx.execute(
          sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(NAME_SIMILARITY_THRESHOLD)}, true)`,
        );
        const explained = await tx.execute<{ "QUERY PLAN": string }>(
          sql`EXPLAIN (ANALYZE, BUFFERS) ${customerSearchSql(tenant.operatorId, command)}`,
        );
        return explained.rows.map((r) => r["QUERY PLAN"]);
      });
      const execution = plan.find((line) => line.startsWith("Execution Time")) ?? "?";
      lines.push(
        `${label.padEnd(30)} rows=${String(count).padStart(3)}  median=${median.toFixed(1).padStart(6)} ms  max=${(times.at(-1) ?? 0).toFixed(1).padStart(6)} ms  ${execution}`,
      );
      expect(median, label).toBeLessThan(LIMIT_MS);
    }
    process.stdout.write(
      `\ncustomers.search on ${CUSTOMERS} customers (+${2 * CUSTOMERS} at other tenants)\n${lines.join("\n")}\n`,
    );
  }, 600_000);
});

/**
 * Home page timing on the legacy-size seed (T-083 acceptance: "Loads < 1 s on `legacy` seed").
 * Off by default (it seeds T-036's `legacy` scale: 8 operators, 7,616 customers, 23 months);
 * run it with
 *
 * ```bash
 * CB_HOME_BENCH=1 DATABASE_URL=… pnpm --filter @cb/core exec vitest run src/dashboard/dashboard.bench.test.ts
 * ```
 *
 * For the biggest operator it times `dashboard.home` (median of 7 calls, transaction included)
 * and checks its total due against the ledger.
 */
import { users } from "@cb/db";
import { seedDatabase } from "@cb/db/seed";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { businessDate } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newRequestId, type ServiceRuntime } from "../context/runtime";
import { resolveTenantContext, type TenantContext } from "../context/tenant-context";
import { testRuntime } from "../testing/fixtures";
import { homeDashboard } from "./home";

const BENCH = process.env.CB_HOME_BENCH === "1";
const describeBench = BENCH ? describeDb : describe.skip;
const NOW = new Date("2026-10-14T06:30:00.000Z");
const LIMIT_MS = 1_000;

describeBench("dashboard.home on the legacy-size seed", () => {
  const t = useTestDatabase();
  let rt: ServiceRuntime;
  let owner: TenantContext;
  let operatorId: string;

  beforeAll(async () => {
    const seeded = await seedDatabase(t.current.db, {
      scale: "legacy",
      seed: 1,
      asOf: businessDate("2026-10-13"),
      verifyPerOperator: 5,
    });
    await t.current.admin.query("ANALYZE");
    const biggest = [...seeded.operators].sort((a, b) => b.customers - a.customers)[0];
    if (!biggest) throw new Error("no operators");
    operatorId = biggest.id;
    process.stdout.write(
      `seeded in ${Math.round(seeded.durationMs)} ms; biggest operator ${biggest.customers} customers\n`,
    );
    rt = testRuntime(t.current.db, { now: () => NOW });
    const rows = await t.current.db.withTenant(operatorId, (tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.operatorId, operatorId), eq(users.role, "owner"))),
    );
    const ctx = await resolveTenantContext(rt, {
      userId: rows[0]?.id ?? "",
      channel: "web",
      requestId: newRequestId(),
    });
    if (!ctx.ok) throw new Error(ctx.error.code);
    owner = ctx.value;
  }, 1_800_000);

  it("answers within a second and its due adds up to the ledger", async () => {
    const timings: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const started = performance.now();
      const result = await homeDashboard.call(rt, owner, {});
      timings.push(performance.now() - started);
      expect(result.ok).toBe(true);
    }
    timings.sort((a, b) => a - b);
    const median = timings[3] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(
      `T-083 dashboard.home median ${Math.round(median)} ms (${timings.map(Math.round).join(", ")})\n`,
    );
    expect(median).toBeLessThan(LIMIT_MS);

    const result = await homeDashboard.call(rt, owner, {});
    if (!result.ok) throw new Error(result.error.code);
    const ledger = await t.current.admin.query<{ due: string }>(
      `SELECT coalesce(sum(net), 0)::text AS due
         FROM (SELECT sum(amount_paise) AS net FROM ledger_entries
                WHERE operator_id = $1 GROUP BY customer_id) l
        WHERE net > 0`,
      [operatorId],
    );
    expect(result.value.due.duePaise).toBe(Number(ledger.rows[0]?.due));
    process.stdout.write(
      `T-083 home view ${JSON.stringify({ ...result.value, latestRun: result.value.latestRun?.status })}\n`,
    );
  }, 600_000);
});

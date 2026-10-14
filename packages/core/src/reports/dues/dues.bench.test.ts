/**
 * Report timings on the legacy-size seed (T-080 "performance sanity"). Off by default (it seeds
 * T-036's `legacy` scale: 8 operators, 7,616 customers, 23 months, ≈148k bills, ≈257k ledger
 * rows); run it with
 *
 * ```bash
 * CB_REPORTS_BENCH=1 DATABASE_URL=… pnpm --filter @cb/core exec vitest run src/reports/dues/dues.bench.test.ts
 * ```
 *
 * For the biggest operator it times (median of 5 calls, transaction included) the dues report
 * now and as of a past month end, a filtered dues list, and the bill register over 12 months, and
 * checks the dues total against the ledger.
 */
import { users } from "@cb/db";
import { seedDatabase } from "@cb/db/seed";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { businessDate } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newRequestId, type ServiceRuntime } from "../../context/runtime";
import { resolveTenantContext, type TenantContext } from "../../context/tenant-context";
import { testRuntime } from "../../testing/fixtures";
import { billRegisterReport } from "../registers/bills";
import { duesReport } from "./queries";
import { ledgerTotal } from "./test-world";

const BENCH = process.env.CB_REPORTS_BENCH === "1";
const describeBench = BENCH ? describeDb : describe.skip;
const NOW = new Date("2026-10-14T06:30:00.000Z");
const LIMIT_MS = 1_500;

describeBench("money reports on the legacy-size seed", () => {
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

  async function median(call: () => Promise<{ ok: boolean }>): Promise<number> {
    const timings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const result = await call();
      timings.push(performance.now() - started);
      expect(result.ok).toBe(true);
    }
    timings.sort((a, b) => a - b);
    return timings[2] ?? Number.POSITIVE_INFINITY;
  }

  it("answers within the limit and adds up to the ledger", async () => {
    const timings = {
      duesNow: await median(() => duesReport.call(rt, owner, {})),
      duesMonthEnd: await median(() => duesReport.call(rt, owner, { asOfDate: "2026-06-30" })),
      duesOldOnly: await median(() => duesReport.call(rt, owner, { bucket: "d90_plus" })),
      billRegister12Months: await median(() =>
        billRegisterReport.call(rt, owner, { from: "2025-11-01", to: "2026-10-01" }),
      ),
    };
    process.stdout.write(`T-080 report timings (median ms) ${JSON.stringify(timings)}\n`);
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(LIMIT_MS);
    const dues = await duesReport.call(rt, owner, {});
    const ledger = await ledgerTotal(t.current, operatorId, new Date(NOW.getTime() + 1));
    expect(dues.ok && dues.value.totals.netPaise).toBe(ledger);
  }, 600_000);
});

/**
 * T-084 acceptance: a 5,000-line file imports in under 2 minutes.
 *
 *   CB_IMPORT_BENCH=1 DATABASE_URL=… pnpm --filter @cb/core exec vitest run src/imports/imports.perf.test.ts
 *
 * Without `CB_IMPORT_BENCH=1` (the normal test run, CI) the same test runs with 500 lines, so the
 * whole path stays covered without a minute of database load on every run; it still fails on a
 * gross slowdown (500 lines must take well under the 2 minutes too).
 *
 * The whole path a real upload takes, timed: build an .xlsx with 5,000 lines (3,500 customers with
 * one box and 750 with two, ~30 % Hindi names, areas, plans and own rents, mixed date formats),
 * read it (`readImportFile`), preview it (`imports.customers.check`), then import it step by step
 * as the page does (`importSteps` → `imports.customers.apply`, ≤ 250 lines per step, one
 * transaction each). Then every customer and connection is counted. The measured times are
 * printed (`[import perf] …`) and reported in the task's completion notes.
 */
import { areas, customers, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { count, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { addPlan, ist, setupTenant } from "../connections/test-support";
import { IMPORT_FIELDS } from "./columns";
import { readImportFile } from "./file";
import { IMPORT_LIMITS } from "./limits";
import { applyCustomerImport, checkCustomerImport } from "./services";
import { writeXlsx } from "./xlsx/write";

const NOW = ist("2026-10-14");
const LIMIT_MS = 120_000;
const BENCH = process.env.CB_IMPORT_BENCH === "1";
/** Lines in the file; 15 % of the customers have two boxes, so customers = 85 % of lines. */
const LINES = BENCH ? 5000 : 500;
const CUSTOMERS = LINES * 0.85;

const HINDI = ["रमेश कुमार", "सुनीता देवी", "मोहन लाल", "गीता शर्मा", "अनिल यादव"];
const ENGLISH = ["Ramesh Kumar", "Sunita Devi", "Mohan Lal", "Geeta Sharma", "Anil Yadav", "Ravi"];

function buildFile(): Uint8Array {
  const header = [
    "Customer code",
    "Name",
    "Mobile no.",
    "Other mobile no.",
    "Address",
    "Area",
    "VC number",
    "Plan",
    "Rent (₹ per month)",
    "Start day",
  ];
  expect(header).toHaveLength(IMPORT_FIELDS.length);
  const rows: string[][] = [header];
  let vc = 0;
  for (let c = 1; rows.length <= LINES; c += 1) {
    const name =
      c % 10 < 3 ? `${HINDI[c % HINDI.length]} ${c}` : `${ENGLISH[c % ENGLISH.length]} ${c}`;
    const phone = `9${String(800_000_000 + c).padStart(9, "0")}`;
    const area = `Ward ${c % 12}`;
    const boxes = c <= LINES * 0.15 ? 2 : 1;
    for (let b = 0; b < boxes && rows.length <= LINES; b += 1) {
      vc += 1;
      const first = b === 0;
      const byPlan = vc % 3 !== 0;
      rows.push([
        String(c).padStart(5, "0"),
        first ? name : "",
        first ? phone : "",
        "",
        first ? `House ${c}, Gali ${c % 40}` : "",
        first ? area : "",
        `VC${String(vc).padStart(10, "0")}`,
        byPlan ? (vc % 2 === 0 ? "Basic" : "Gold") : "",
        byPlan ? "" : `₹${200 + (vc % 5) * 50}`,
        vc % 2 === 0 ? "01/09/2026" : "2026-10-01",
      ]);
    }
  }
  return writeXlsx([{ name: "Customers", rows }]);
}

describeDb("customer import performance", () => {
  const t = useTestDatabase();

  it(
    `imports a ${LINES}-line file in under 2 minutes`,
    async () => {
      const s = await setupTenant(t.current);
      await addPlan(s, "Basic", 30_000);
      await addPlan(s, "Gold", 45_000);
      await s.tx((tx) =>
        tx
          .insert(areas)
          .values(Array.from({ length: 12 }, (_, i) => ({ operatorId: s.op, name: `Ward ${i}` }))),
      );
      const runtime = s.rt(NOW);
      const bytes = buildFile();

      const started = performance.now();
      const read = readImportFile(bytes);
      if (!read.ok) throw new Error(`readImportFile: ${JSON.stringify(read.error)}`);
      expect(read.value.lines).toHaveLength(LINES);
      const readMs = performance.now() - started;

      const preview = await checkCustomerImport.call(runtime, s.owner, {
        lines: [...read.value.lines],
      });
      if (!preview.ok) throw new Error(`check: ${JSON.stringify(preview.error)}`);
      expect(preview.value.counts.customers).toEqual({
        ready: CUSTOMERS,
        created: 0,
        exists: 0,
        problem: 0,
      });
      const checkMs = performance.now() - started - readMs;

      const byLine = new Map(read.value.lines.map((line) => [line.line, line]));
      let created = 0;
      // As the page does: `IMPORT_LIMITS.parallelSteps` steps at a time.
      const queue = [...preview.value.steps];
      const worker = async () => {
        for (let step = queue.shift(); step; step = queue.shift()) {
          const lines = step.map((n) => {
            const line = byLine.get(n);
            if (!line) throw new Error(`no line ${n}`);
            return line;
          });
          const result = await applyCustomerImport.call(runtime, s.owner, { lines });
          if (!result.ok) throw new Error(`apply: ${JSON.stringify(result.error)}`);
          created += result.value.counts.customers.created;
        }
      };
      await Promise.all(Array.from({ length: IMPORT_LIMITS.parallelSteps }, worker));
      const totalMs = performance.now() - started;
      const applyMs = totalMs - readMs - checkMs;

      const [customerCount] = await s.tx((tx) =>
        tx.select({ n: count() }).from(customers).where(eq(customers.operatorId, s.op)),
      );
      const [connectionCount] = await s.tx((tx) =>
        tx.select({ n: count() }).from(vcAssignments).where(eq(vcAssignments.operatorId, s.op)),
      );
      expect(created).toBe(CUSTOMERS);
      expect(customerCount?.n).toBe(CUSTOMERS);
      expect(connectionCount?.n).toBe(LINES);

      process.stdout.write(
        `[import perf] ${LINES} lines / ${CUSTOMERS} customers / ${LINES} connections: ` +
          `read ${(readMs / 1000).toFixed(1)} s, preview ${(checkMs / 1000).toFixed(1)} s, ` +
          `import ${(applyMs / 1000).toFixed(1)} s in ${preview.value.steps.length} steps, ` +
          `total ${(totalMs / 1000).toFixed(1)} s\n`,
      );
      expect(totalMs).toBeLessThan(LIMIT_MS);
    },
    // Generous: the CI machine is shared; the assertion above is the 2-minute limit.
    LIMIT_MS + 120_000,
  );
});

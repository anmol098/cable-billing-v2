/**
 * Restore verification (T-096), run by restore-drill.sh after pg_restore:
 *
 *   TARGET_DATABASE_URL=… pnpm --filter @cb/db exec tsx docs/runbooks/backup/verify-restore.ts \
 *     --manifest manifest.json --restored restored.json --report verify.md [--skip-invariants]
 *
 * 1. The restored copy's manifest (manifest.pgsql run on the target) must equal the backup's
 *    manifest (taken in the dump's snapshot): same tables, same row counts, same money totals,
 *    same migration journal.
 * 2. T-052's checkTenantInvariants must report zero violations for every tenant (each in a
 *    read-only withTenant transaction, exactly as the nightly job does; nothing is written).
 *
 * Writes a Markdown section (ids and counts only, never names, phones or amounts per customer)
 * and exits 0 on PASS, 1 on FAIL. It imports the workspace sources by relative path because this
 * folder is not a workspace package; run it through @cb/db's tsx so their dependencies resolve.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkTenantInvariants } from "../../../packages/core/src/invariants/index.ts";
import { createDb, operators } from "../../../packages/db/src/index.ts";

interface DatabaseManifest {
  tables: Record<string, number>;
  money: Record<string, string>;
  latest_migration: { id: number; hash: string; created_at: string | number } | null;
  migration_count: number;
}

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    restored: { type: "string" },
    report: { type: "string" },
    "skip-invariants": { type: "boolean", default: false },
  },
});
if (!values.manifest || !values.restored || !values.report) {
  console.error("usage: verify-restore.ts --manifest F --restored F --report F [--skip-invariants]");
  process.exit(2);
}
const url = process.env.TARGET_DATABASE_URL;
if (!url) {
  console.error("TARGET_DATABASE_URL is not set");
  process.exit(2);
}

const backup = (JSON.parse(readFileSync(values.manifest, "utf8")) as { database: DatabaseManifest })
  .database;
const restored = JSON.parse(readFileSync(values.restored, "utf8")) as DatabaseManifest;

const problems: string[] = [];
const lines: string[] = [];

// 1. Tables and row counts.
const tableNames = [...new Set([...Object.keys(backup.tables), ...Object.keys(restored.tables)])];
tableNames.sort();
let rows = 0;
for (const table of tableNames) {
  const want = backup.tables[table];
  const got = restored.tables[table];
  if (want === undefined) problems.push(`table ${table} exists only in the restored copy`);
  else if (got === undefined) problems.push(`table ${table} is missing from the restored copy`);
  else if (want !== got) problems.push(`table ${table}: ${got} rows restored, ${want} in the backup`);
  rows += got ?? 0;
}
lines.push(
  `| Tables and row counts | ${tableNames.length} tables, ${rows} rows | ${
    problems.length === 0 ? "equal to the backup manifest" : `${problems.length} differences`
  } |`,
);

// 2. Money totals (Σ paise as decimal strings: bigint-safe).
const moneyProblems: string[] = [];
for (const key of Object.keys(backup.money)) {
  if (backup.money[key] !== restored.money[key]) {
    moneyProblems.push(`${key}: ${restored.money[key]} restored, ${backup.money[key]} in the backup`);
  }
}
problems.push(...moneyProblems);
lines.push(
  `| Money totals (${Object.keys(backup.money).length} sums) | ${
    moneyProblems.length === 0 ? "equal" : `${moneyProblems.length} differ`
  } | payments, invoice charges, ledger, balances, credit |`,
);

// 3. Migration journal.
const sameMigration =
  backup.migration_count === restored.migration_count &&
  backup.latest_migration?.hash === restored.latest_migration?.hash;
if (!sameMigration) problems.push("the migration journal differs from the backup");
lines.push(
  `| Migrations | ${restored.migration_count} applied | ${
    sameMigration ? "same journal as the backup" : "DIFFERENT from the backup"
  } |`,
);

// 4. Invariants, per tenant.
if (values["skip-invariants"]) {
  lines.push("| Invariants (T-052) | skipped | run them before reopening the app |");
} else {
  const db = createDb({ connectionString: url, max: 2 });
  try {
    const ids = (await db.withPlatform((tx) => tx.select({ id: operators.id }).from(operators)))
      .map((row) => row.id)
      .sort();
    let breached = 0;
    let violations = 0;
    const byCode = new Map<string, number>();
    for (const operatorId of ids) {
      const report = await db.withTenant(
        operatorId,
        (tx) => checkTenantInvariants(tx, operatorId, { sampleLimit: 0 }),
        { accessMode: "read only" },
      );
      if (report.violationCount > 0) {
        breached += 1;
        violations += report.violationCount;
        problems.push(`tenant ${operatorId}: ${report.violationCount} invariant violations`);
        for (const [code, n] of Object.entries(report.counts)) {
          byCode.set(code, (byCode.get(code) ?? 0) + (n ?? 0));
        }
      }
    }
    const codes = [...byCode].map(([code, n]) => `${code} ${n}`).join(", ");
    lines.push(
      `| Invariants (T-052) | ${ids.length} tenants checked | ${
        breached === 0
          ? "0 violations"
          : `${breached} tenants breached, ${violations} violations (${codes})`
      } |`,
    );
    if (ids.length === 0 && (backup.tables["public.operators"] ?? 0) > 0) {
      problems.push("no tenant was visible through withPlatform (roles or grants not restored?)");
    }
  } finally {
    await db.end();
  }
}

const verdict = problems.length === 0 ? "PASS" : "FAIL";
const out = [
  `Verification: **${verdict}**`,
  "",
  "| Check | Restored copy | Result |",
  "|---|---|---|",
  ...lines,
  "",
  ...(problems.length === 0 ? [] : ["Problems:", "", ...problems.map((p) => `- ${p}`), ""]),
].join("\n");
writeFileSync(values.report, `${out}\n`);
console.error(`verify-restore: ${verdict} (${problems.length} problems)`);
process.exitCode = problems.length === 0 ? 0 : 1;

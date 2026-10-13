/**
 * `pnpm --filter @cb/migration legacy:copy [--allow-remote HOST] [--tables a,b] [--batch-size N]`
 *
 * Copies every table of the restored legacy MariaDB (LEGACY_DB_URL, default: the docker-compose
 * database) into the `legacy` schema of MIGRATION_TARGET_URL. Guards: see src/target.ts.
 */
import { parseArgs } from "node:util";
import { copyLegacy } from "../copy/copy";
import { DEFAULT_LEGACY_DB_URL, MariaDbSource } from "../source/mariadb";
import { connectTarget, EXIT, RefusedError, runCli } from "./shared";

const USAGE = `Usage: pnpm --filter @cb/migration legacy:copy [options]

Copies the restored legacy MariaDB into the Postgres "legacy" schema (raw, replaces earlier copies).
  --allow-remote HOST     allow this exact non-local target host (a non-production Neon branch
                          whose database has cb.migration_target = 'non-prod')
  --allow-remote-source   allow a non-local LEGACY_DB_URL (default: local MariaDB only)
  --tables a,b            copy only these tables
  --batch-size N          rows per batch (default 2000)

Environment:
  MIGRATION_TARGET_URL  postgres://… (required; DATABASE_URL is never used)
  LEGACY_DB_URL         mysql://… (default ${DEFAULT_LEGACY_DB_URL.replace(/:[^:@/]+@/, ":***@")})`;

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

runCli(async () => {
  const { values } = parseArgs({
    options: {
      "allow-remote": { type: "string" },
      "allow-remote-source": { type: "boolean", default: false },
      tables: { type: "string" },
      "batch-size": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  const sourceUrl = process.env.LEGACY_DB_URL || DEFAULT_LEGACY_DB_URL;
  const sourceHost = new URL(sourceUrl).hostname;
  if (!LOCAL.has(sourceHost) && !values["allow-remote-source"]) {
    throw new RefusedError(
      `Refusing the remote legacy source "${sourceHost}": restore the dump locally (restore.sh) ` +
        "or pass --allow-remote-source.",
    );
  }
  const batchSize = values["batch-size"] ? Number(values["batch-size"]) : undefined;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
    throw new RefusedError("--batch-size must be a positive integer");
  }
  const target = await connectTarget(values["allow-remote"]);
  const source = await MariaDbSource.connect(sourceUrl);
  try {
    console.error(`source: ${source.label}`);
    const result = await copyLegacy(source, target, {
      batchSize,
      tables: values.tables
        ?.split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      onProgress: (message) => console.log(message),
    });
    if (result.droppedStale.length > 0) {
      console.log(`removed tables no longer in the source: ${result.droppedStale.join(", ")}`);
    }
    const rows = result.tables.reduce((sum, t) => sum + t.rows, 0);
    console.log(`copy run #${result.runId}: ${result.tables.length} tables, ${rows} rows`);
    return EXIT.ok;
  } finally {
    await source.close();
    await target.end();
  }
});

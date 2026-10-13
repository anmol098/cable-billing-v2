/**
 * `pnpm db:seed` (T-036): fills an empty, migrated database with fake data.
 *
 * ```text
 * pnpm db:seed [--scale small|legacy|10x] [--seed N] [--as-of YYYY-MM-DD] [--months N]
 *              [--migrate] [--allow-remote] [--if-empty] [--no-password]
 *              [--concurrency N] [--verify N] [--dry-run]
 * ```
 *
 * Target: `DATABASE_URL_UNPOOLED`, else `DATABASE_URL` (like `db:migrate`). Safety rules in
 * guard.ts: never production, local hosts unless `--allow-remote`, empty databases only.
 * Exit codes: 0 done (or `--if-empty` and already seeded), 1 failed, 2 refused or bad arguments.
 */
import { pathToFileURL } from "node:url";
import { type BusinessDate, isBusinessDate } from "@cb/domain";
import { createDb } from "../client";
import { migrateDatabase } from "../testing/template";
import { datasetCounts } from "./dataset";
import { checkSeedTarget } from "./guard";
import { isSeedScale, SEED_SCALES, type SeedScale } from "./scales";
import { generateSeed, SEED_DEV_PASSWORD, SeedRefusedError, seedDatabase } from "./seed";

export interface SeedCliOptions {
  readonly scale: SeedScale;
  readonly seed: string;
  readonly asOf: BusinessDate | undefined;
  readonly months: number | undefined;
  readonly migrate: boolean;
  readonly allowRemote: boolean;
  readonly ifEmpty: boolean;
  readonly password: boolean;
  readonly concurrency: number | undefined;
  readonly verify: number | undefined;
  readonly dryRun: boolean;
  readonly help: boolean;
}

export const SEED_USAGE = `Usage: pnpm db:seed [options]

Fills an empty, migrated database with fake operators, customers, connections and
months of bills and payments (T-036). Deterministic: the same seed gives the same data.

  --scale small|legacy|10x  how much data (default small)
                            small:  3 operators,    150 customers, 12 months
                            legacy: 8 operators,  7,616 customers, 23 months (~148k bills)
                            10x:   80 operators, 76,160 customers, 23 months
  --seed N                  random seed (default 1)
  --as-of YYYY-MM-DD        simulated "today" (default: today in IST)
  --months N                months of history (default: per scale)
  --migrate                 apply the migrations first
  --allow-remote            allow a non-local database (Neon preview/staging; never production)
  --if-empty                exit 0 without seeding when the database already has operators
  --no-password             create users without a password (default: "${SEED_DEV_PASSWORD}")
  --concurrency N           operators inserted at once (default 3)
  --verify N                customers per operator checked with checkLedger (default 25, 0 = off)
  --dry-run                 generate and print counts only; no database needed
  --help                    this text

Database: DATABASE_URL_UNPOOLED, else DATABASE_URL. Refuses VERCEL_ENV=production.`;

export class SeedArgsError extends Error {}

/** Parses `pnpm db:seed` arguments. Throws `SeedArgsError` on bad input. */
export function parseSeedArgs(argv: readonly string[]): SeedCliOptions {
  const options = {
    scale: "small" as SeedScale,
    seed: "1",
    asOf: undefined as BusinessDate | undefined,
    months: undefined as number | undefined,
    migrate: false,
    allowRemote: false,
    ifEmpty: false,
    password: true,
    concurrency: undefined as number | undefined,
    verify: undefined as number | undefined,
    dryRun: false,
    help: false,
  };
  const args = [...argv];
  const value = (flag: string): string => {
    const next = args.shift();
    if (next === undefined || next.startsWith("--"))
      throw new SeedArgsError(`${flag} needs a value`);
    return next;
  };
  const wholeNumber = (flag: string, min: number): number => {
    const raw = value(flag);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min)
      throw new SeedArgsError(`${flag} must be a whole number ≥ ${min}`);
    return n;
  };
  while (args.length > 0) {
    const raw = args.shift() as string;
    if (raw === "--") continue; // `pnpm db:seed -- --scale …`
    const [flag, inline] = raw.includes("=")
      ? (raw.split(/=(.*)/s, 2) as [string, string])
      : [raw, undefined];
    if (inline !== undefined) args.unshift(inline);
    switch (flag) {
      case "--scale": {
        const scale = value(flag);
        if (!isSeedScale(scale))
          throw new SeedArgsError(`--scale must be one of ${SEED_SCALES.join(", ")}`);
        options.scale = scale;
        break;
      }
      case "--seed":
        options.seed = value(flag);
        break;
      case "--as-of": {
        const date = value(flag);
        if (!isBusinessDate(date)) throw new SeedArgsError("--as-of must be a date YYYY-MM-DD");
        options.asOf = date;
        break;
      }
      case "--months":
        options.months = wholeNumber(flag, 1);
        break;
      case "--concurrency":
        options.concurrency = wholeNumber(flag, 1);
        break;
      case "--verify":
        options.verify = wholeNumber(flag, 0);
        break;
      case "--migrate":
        options.migrate = true;
        break;
      case "--allow-remote":
        options.allowRemote = true;
        break;
      case "--if-empty":
        options.ifEmpty = true;
        break;
      case "--no-password":
        options.password = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new SeedArgsError(`unknown option ${raw}`);
    }
  }
  return options;
}

/** Writes a line to stdout (the CLI's report; errors go to stderr through console.error). */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

const formatCount = (n: number) => n.toLocaleString("en-IN");

function printCounts(counts: Readonly<Record<string, number>>): void {
  const width = Math.max(...Object.keys(counts).map((k) => k.length));
  for (const [table, n] of Object.entries(counts)) {
    print(`  ${table.padEnd(width)}  ${formatCount(n).padStart(10)}`);
  }
}

/** Runs the CLI; returns the exit code. */
export async function runSeedCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  let options: SeedCliOptions;
  try {
    options = parseSeedArgs(argv);
  } catch (error) {
    if (!(error instanceof SeedArgsError)) throw error;
    console.error(`db:seed: ${error.message}\n\n${SEED_USAGE}`);
    return 2;
  }
  if (options.help) {
    print(SEED_USAGE);
    return 0;
  }
  const passwordHash = options.password ? (env.CB_SEED_PASSWORD_HASH ?? undefined) : null;
  const common = {
    scale: options.scale,
    seed: options.seed,
    ...(options.asOf ? { asOf: options.asOf } : {}),
    ...(options.months ? { months: options.months } : {}),
    ...(passwordHash !== undefined ? { passwordHash } : {}),
  };

  if (options.dryRun) {
    const started = performance.now();
    const { operators, hash } = generateSeed(common);
    const counts: Record<string, number> = {};
    for (const op of operators) {
      for (const [table, n] of Object.entries(datasetCounts(op.data)))
        counts[table] = (counts[table] ?? 0) + n;
    }
    print(`db:seed --dry-run (${options.scale}, seed ${options.seed}): nothing written`);
    printCounts(counts);
    print(`  hash ${hash}\n  ${Math.round(performance.now() - started)} ms`);
    return 0;
  }

  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  const target = checkSeedTarget({ url, env, allowRemote: options.allowRemote });
  if (!target.ok) {
    console.error(`db:seed: ${target.reason}`);
    return 2;
  }
  const databaseUrl = url as string;
  if (options.migrate) {
    print("db:seed: applying migrations…");
    await migrateDatabase(databaseUrl);
  }
  const db = createDb({ connectionString: databaseUrl, max: (options.concurrency ?? 3) + 1 });
  try {
    const result = await seedDatabase(db, {
      ...common,
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      ...(options.verify !== undefined ? { verifyPerOperator: options.verify } : {}),
      log: (message) => print(`db:seed: ${message}`),
    });
    print(
      `\ndb:seed: ${result.scale} seed ${result.seed}, ${result.months} months to ${result.asOf}, ` +
        `${formatCount(result.durationMs)} ms on ${target.host}`,
    );
    printCounts(result.counts);
    print(`  hash ${result.hash}`);
    print(
      `  checkLedger: ${result.verified.checked} sampled customers, ${result.verified.failures} failures`,
    );
    const password =
      passwordHash === null
        ? "(no password)"
        : passwordHash
          ? "(CB_SEED_PASSWORD_HASH)"
          : SEED_DEV_PASSWORD;
    print(`\nLogins (password ${password}):`);
    for (const login of result.logins) {
      print(`  ${login.login.padEnd(26)} ${login.role.padEnd(8)} ${login.operatorName}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof SeedRefusedError) {
      if (options.ifEmpty) {
        print(`db:seed: skipped (--if-empty): ${error.message}`);
        return 0;
      }
      console.error(`db:seed: ${error.message}`);
      return 2;
    }
    console.error("db:seed: failed:", error);
    return 1;
  } finally {
    await db.end();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runSeedCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error("db:seed: failed:", error);
      process.exitCode = 1;
    },
  );
}

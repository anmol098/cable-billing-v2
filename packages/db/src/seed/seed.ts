/**
 * Seeding a database (T-036): plan the operators for a scale, generate each operator's rows
 * (generate.ts) and insert them, one `withTenant` transaction per operator (dataset.ts).
 *
 * Operators are generated one after another (CPU) while up to `concurrency` earlier operators are
 * being inserted (database), so only a few operators' rows are in memory at once even at `10x`.
 * Each operator has its own random stream, so the data does not depend on the concurrency.
 */
import { createHash } from "node:crypto";
import { type BusinessDate, businessDate, businessDateOf } from "@cb/domain";
import { sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { datasetCounts, datasetHash, insertDataset } from "./dataset";
import {
  type GeneratedOperator,
  generateOperator,
  type OperatorSpec,
  type SeedLogin,
} from "./generate";
import { Rng } from "./random";
import { SCALE_CONFIGS, type ScaleConfig, type SeedScale } from "./scales";
import { verifyLedgerSample } from "./verify";
import { OPERATOR_NAMES } from "./words";

/**
 * argon2id hash (T-026's parameters: m = 19456, t = 2, p = 1) of {@link SEED_DEV_PASSWORD}, so
 * seeded users can sign in on dev and preview (web auth, T-026). Fake data only: the
 * seed refuses production, and the password is published here on purpose.
 */
export const SEED_DEV_PASSWORD = "seed-dev-password";
export const SEED_DEV_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$D0fc1X4tHyFaKDuPp+HYqQ$B8aMoQ3b3R6meKyc+boP+VQCklriBEIIGrcLyvWubBw";

export interface SeedOptions {
  readonly scale: SeedScale;
  /** Same seed (and scale, months, asOf) → same data. Default `1`. */
  readonly seed?: string | number;
  /** The simulated "today" (IST). Default: today in IST. */
  readonly asOf?: BusinessDate;
  /** Months of history (default: the scale's). */
  readonly months?: number;
  /** Password hash for every seeded user; `null` for no `credential` accounts. */
  readonly passwordHash?: string | null;
  /** Operators inserted at the same time (default 3). */
  readonly concurrency?: number;
  /** Customers per operator checked with `checkLedger` after inserting (default 25; 0 = none). */
  readonly verifyPerOperator?: number;
  /** Progress messages (default: none). */
  readonly log?: (message: string) => void;
}

export interface SeedResult {
  readonly scale: SeedScale;
  readonly seed: string;
  readonly asOf: BusinessDate;
  readonly months: number;
  readonly operators: readonly {
    readonly id: string;
    readonly name: string;
    readonly customers: number;
  }[];
  /** Rows written, by table. */
  readonly counts: Readonly<Record<string, number>>;
  /** SHA-256 over every generated row (per operator, in order). Same inputs → same hash. */
  readonly hash: string;
  readonly logins: readonly SeedLogin[];
  readonly verified: { readonly checked: number; readonly failures: number };
  readonly durationMs: number;
}

/** Thrown when the target database must not be seeded (it already has data). */
export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefusedError";
  }
}

/** The operators of a scale: names (two share one, FR-002), customers and linemen each. */
export function planOperators(config: ScaleConfig, seed: string): OperatorSpec[] {
  const rng = new Rng(`cable-billing-seed:${seed}`).fork("plan");
  const weights = Array.from({ length: config.operators }, () => 0.5 + rng.next());
  const total = weights.reduce((a, b) => a + b, 0);
  const share = (amount: number, minimum: number) => {
    const parts = weights.map((w) => Math.max(minimum, Math.floor((amount * w) / total)));
    let rest = amount - parts.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i = (i + 1) % parts.length, rest -= 1) parts[i] = (parts[i] ?? 0) + 1;
    return parts;
  };
  const customers = share(config.customers, 1);
  const linemen = share(config.linemen, 1);
  return weights.map((_, index) => ({
    index,
    // Operators 1 and 2 share a name on purpose; the rest cycle through the list.
    name: OPERATOR_NAMES[index <= 1 ? 0 : (index - 1) % OPERATOR_NAMES.length] as string,
    customers: customers[index] as number,
    linemen: linemen[index] as number,
  }));
}

function resolveOptions(options: SeedOptions) {
  const config = SCALE_CONFIGS[options.scale];
  const seed = String(options.seed ?? 1);
  const asOf = options.asOf ?? businessDateOf(new Date());
  return {
    config,
    seed,
    asOf: businessDate(asOf),
    months: options.months ?? config.months,
    passwordHash:
      options.passwordHash === undefined ? SEED_DEV_PASSWORD_HASH : options.passwordHash,
  };
}

function combineHashes(hashes: readonly string[]): string {
  const hash = createHash("sha256");
  for (const h of hashes) hash.update(h);
  return hash.digest("hex");
}

/**
 * Generates the whole dataset in memory without a database (tests, `--dry-run`). Keeps every
 * operator in memory: fine for `small`, heavy for `legacy`, too big for `10x`.
 */
export function generateSeed(options: SeedOptions): {
  readonly operators: readonly GeneratedOperator[];
  readonly hash: string;
} {
  const { config, seed, asOf, months, passwordHash } = resolveOptions(options);
  const operators = planOperators(config, seed).map((spec) =>
    generateOperator(spec, { seed, months, asOf, passwordHash }),
  );
  return { operators, hash: combineHashes(operators.map((op) => datasetHash(op.data))) };
}

/**
 * Seeds an **empty** migrated database. Refuses (`SeedRefusedError`) if it already has operators.
 * Check the target with `checkSeedTarget` first (the CLI does).
 */
export async function seedDatabase(db: DbClient, options: SeedOptions): Promise<SeedResult> {
  const started = performance.now();
  const log = options.log ?? (() => {});
  const { config, seed, asOf, months, passwordHash } = resolveOptions(options);
  const existing = await db.withPlatform(async (tx) => {
    const result = await tx.execute<{ n: string }>(sql`select count(*)::text as n from operators`);
    return Number(result.rows[0]?.n ?? 0);
  });
  if (existing > 0) {
    throw new SeedRefusedError(
      `The database already has ${existing} operator(s). Seed an empty, migrated database ` +
        "(seed rows are never mixed with existing data).",
    );
  }

  const specs = planOperators(config, seed);
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const hashes: string[] = [];
  const counts: Record<string, number> = {};
  const logins: SeedLogin[] = [];
  const operators: { id: string; name: string; customers: number }[] = [];
  const running = new Set<Promise<void>>();
  const errors: unknown[] = [];

  for (const spec of specs) {
    while (running.size >= concurrency) await Promise.race(running);
    if (errors.length > 0) break;
    const generated = generateOperator(spec, { seed, months, asOf, passwordHash });
    hashes[spec.index] = datasetHash(generated.data);
    for (const [table, n] of Object.entries(datasetCounts(generated.data))) {
      counts[table] = (counts[table] ?? 0) + n;
    }
    logins.push(...generated.logins);
    operators[spec.index] = {
      id: generated.operatorId,
      name: spec.name,
      customers: spec.customers,
    };
    log(
      `operator ${spec.index + 1}/${specs.length} "${spec.name}": generated ` +
        `${generated.data.customers.length} customers, ${generated.data.invoices.length} invoices`,
    );
    const task: Promise<void> = db
      .withTenant(generated.operatorId, (tx) => insertDataset(tx, generated.data))
      .then(
        () => log(`operator ${spec.index + 1}/${specs.length}: inserted`),
        (error: unknown) => {
          errors.push(error);
        },
      )
      .finally(() => running.delete(task));
    running.add(task);
  }
  await Promise.all(running);
  if (errors.length > 0) throw errors[0];

  const perOperator = options.verifyPerOperator ?? 25;
  let verified = { checked: 0, failures: 0 };
  if (perOperator > 0) {
    const report = await verifyLedgerSample(db, { perOperator });
    verified = { checked: report.checked, failures: report.failures.length };
    if (report.failures.length > 0) {
      throw new Error(
        `Seeded ledgers fail checkLedger for ${report.failures.length} customer(s), e.g. ` +
          JSON.stringify(report.failures.slice(0, 3)),
      );
    }
    log(`checkLedger: ${report.checked} sampled customers, no violations`);
  }

  return {
    scale: options.scale,
    seed,
    asOf,
    months,
    operators,
    counts,
    hash: combineHashes(hashes),
    logins,
    verified,
    durationMs: Math.round(performance.now() - started),
  };
}

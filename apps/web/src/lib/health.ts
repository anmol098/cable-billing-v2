import { createDb, type DbClient } from "@cb/db";
import packageJson from "../../package.json";

export type CheckStatus = "ok" | "error" | "not_configured";

export type HealthReport = {
  /** `degraded` (HTTP 503) when a check failed. */
  status: "ok" | "degraded";
  /** `apps/web/package.json` version. */
  version: string;
  /** Deployed commit (Vercel), or null outside Vercel. */
  commit: string | null;
  /** Server time, ISO 8601 UTC. */
  time: string;
  checks: {
    /**
     * `select 1` through `@cb/db` with a short timeout ({@link DB_PING_TIMEOUT_MS}). `error` covers
     * refused, failed and too slow alike: the reason goes nowhere (no internals in a public answer).
     * `not_configured`: no `DATABASE_URL` (local builds only; deployments refuse to boot without it).
     */
    db: { status: CheckStatus };
  };
};

/** How long the database may take to answer `select 1` before the check reports `error`. */
export const DB_PING_TIMEOUT_MS = 2_000;

export type HealthInput = {
  commit?: string | undefined;
  now?: Date;
  /** The database check (route: {@link databasePing}). Default: `not_configured`. */
  pingDb?: () => Promise<CheckStatus>;
};

export async function getHealth({
  commit,
  now = new Date(),
  pingDb = async () => "not_configured",
}: HealthInput = {}): Promise<HealthReport> {
  const db = await pingDb().catch((): CheckStatus => "error");
  return {
    status: db === "error" ? "degraded" : "ok",
    version: packageJson.version,
    commit: commit ?? null,
    time: now.toISOString(),
    checks: { db: { status: db } },
  };
}

/** Resolves `"error"` after `ms` unless `promise` settles first (then: its value, or `"error"`). */
export function withTimeout(promise: Promise<CheckStatus>, ms: number): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckStatus>((resolve) => {
    timer = setTimeout(() => resolve("error"), ms);
  });
  return Promise.race([promise.catch((): CheckStatus => "error"), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * One `select 1` in a read-only `withPlatform` transaction: proves the database answers and that
 * the runtime role can switch to `app_platform`, like every request has to. Reads no table, so no
 * tenant data. `ok` or throws.
 */
export async function pingDatabase(db: Pick<DbClient, "withPlatform">): Promise<CheckStatus> {
  await db.withPlatform((tx) => tx.execute("select 1"), { accessMode: "read only" });
  return "ok";
}

type Pinger = { db: DbClient; inFlight?: Promise<CheckStatus> | undefined };
const pingers = new Map<string, Pinger>();

/**
 * The health route's database check. Uptime checks call `/api/health` every minute, so it stays
 * cheap: its own pool of at most 2 connections (created on first use, never at import), and
 * concurrent requests share one ping instead of queueing one each. A ping that takes longer than
 * `timeoutMs` reports `error`; the next request starts a new one.
 */
export function databasePing(
  connectionString: string | undefined,
  { timeoutMs = DB_PING_TIMEOUT_MS }: { timeoutMs?: number } = {},
): () => Promise<CheckStatus> {
  return () => {
    if (!connectionString) return Promise.resolve("not_configured");
    let pinger = pingers.get(connectionString);
    if (!pinger) {
      pinger = { db: createDb({ connectionString, max: 2 }) };
      pingers.set(connectionString, pinger);
    }
    if (pinger.inFlight) return pinger.inFlight;
    const owner = pinger;
    const current: Promise<CheckStatus> = withTimeout(
      Promise.resolve().then(() => pingDatabase(owner.db)),
      timeoutMs,
    ).finally(() => {
      if (owner.inFlight === current) owner.inFlight = undefined;
    });
    owner.inFlight = current;
    return current;
  };
}

/** Closes the health check's pools (tests; a server never needs to). */
export async function closeDatabasePings(): Promise<void> {
  const all = [...pingers.values()];
  pingers.clear();
  await Promise.all(all.map(({ db }) => db.end().catch(() => {})));
}

import packageJson from "../../package.json";

export type CheckStatus = "ok" | "error" | "not_configured";

export type HealthReport = {
  status: "ok" | "degraded";
  /** `apps/web/package.json` version. */
  version: string;
  /** Deployed commit (Vercel), or null outside Vercel. */
  commit: string | null;
  /** Server time, ISO 8601 UTC. */
  time: string;
  checks: {
    /** Placeholder until the DB client lands (T-020): it will run `select 1` with a short timeout. */
    db: { status: CheckStatus };
  };
};

export type HealthInput = {
  commit?: string | undefined;
  now?: Date;
  /** Injected so tests (and later T-020) can supply a real ping. */
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

// THROWAWAY (T-010 CI fail-path check, never merged): `any` breaks Biome noExplicitAny.
export const ciFailcheckProbe = (value: any) => value;

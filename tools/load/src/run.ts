/** One load run: preflight, the sign-in plan, the scenarios in order, the result. */
import { cpus, loadavg } from "node:os";
import type { SeedScale } from "@cb/db/seed";
import { SessionCache, SignInBudgetError, SignInGovernor, signInMobile, signInWeb } from "./auth";
import { evaluateBudget } from "./budget";
import { createContext, errorText, pool, type RunOptions } from "./context";
import { jsonOf, Session } from "./http";
import { seedPersonas } from "./personas";
import { isLocalTarget, LOCAL_DISCLAIMER, passOf, RESULT_SCHEMA, type RunResult } from "./report";
import { orderScenarios, plannedLogins, SCENARIOS, type ScenarioName } from "./scenarios";
import { Recorder } from "./stats";

export interface LoadRunInput extends Omit<RunOptions, "personas"> {
  readonly seedScale: SeedScale;
  readonly seed?: string;
  readonly scenarios: readonly ScenarioName[];
  readonly maxSignIns: number;
  /** Where sign-ins are cached between runs; null = no cache. */
  readonly cachePath: string | null;
  readonly label?: string;
}

export class TargetNotReadyError extends Error {
  override readonly name = "TargetNotReadyError";
}

interface Health {
  readonly status?: string;
  readonly version?: string | null;
  readonly commit?: string | null;
  readonly checks?: { readonly db?: { readonly status?: string } };
}

/**
 * `/api/health` must answer 200 with the database `ok` before any load is sent. Then four more
 * calls give the baseline: the fastest health round trip (network + a `select 1`), which every
 * timing in the report includes. Compare it before reading a run from far away (a US CI runner to
 * Singapore adds ~200 ms to every request).
 */
export async function preflight(
  baseUrl: string,
): Promise<{ version: string | null; commit: string | null; baselineMs: number }> {
  const session = new Session(baseUrl, new Recorder());
  const answer = await session.request("/api/health", { timeoutMs: 15_000 });
  const health = jsonOf<Health>(answer);
  if (answer.status !== 200 || health?.checks?.db?.status !== "ok") {
    throw new TargetNotReadyError(
      `${new URL(baseUrl).origin}/api/health answered ${answer.networkError ?? answer.status} (db: ${health?.checks?.db?.status ?? "?"}); the target is not ready`,
    );
  }
  let baselineMs = answer.ms;
  for (let i = 0; i < 4; i += 1) {
    const again = await session.request("/api/health", { timeoutMs: 15_000 });
    if (again.ok) baselineMs = Math.min(baselineMs, again.ms);
  }
  return {
    version: health.version ?? null,
    commit: health.commit ?? null,
    baselineMs: Math.round(baselineMs * 10) / 10,
  };
}

const isLineman = (login: string) => /-lineman\d+$/.test(login);

/** Logins of the run that have no cached sign-in yet (each will cost one real sign-in). */
export function uncachedLogins(
  cache: SessionCache,
  baseUrl: string,
  logins: readonly string[],
): string[] {
  return logins.filter((login) => {
    const entry = cache.get(baseUrl, login);
    if (!entry) return true;
    return entry.kind === "mobile" && Date.parse(entry.refreshExpiresAt) <= Date.now();
  });
}

export async function runLoad(input: LoadRunInput): Promise<RunResult> {
  const startedAt = new Date();
  const loadavgStart = loadavg();
  const target = await preflight(input.baseUrl);
  const personas = seedPersonas(input.seedScale, input.seed);
  const scenarios = orderScenarios(input.scenarios);
  const cache = new SessionCache(input.cachePath);
  const logins = plannedLogins(scenarios, { personas, profile: input.profile });
  const missing = uncachedLogins(cache, input.baseUrl, logins);
  if (missing.length > input.maxSignIns) {
    throw new SignInBudgetError(
      `this run needs ${missing.length} new sign-ins but may make ${input.maxSignIns} (server limit 100 per IP per 15 min). Run \`load warm\` with the same options (every 15 minutes) until it reports none missing.`,
    );
  }
  const recorder = new Recorder();
  const governor = new SignInGovernor(input.maxSignIns);
  const ctx = createContext({ ...input, personas }, recorder, governor, cache);
  const scenarioErrors: Record<string, string> = {};
  input.log(
    `target ${new URL(input.baseUrl).origin} (version ${target.version ?? "?"}, commit ${target.commit ?? "?"}, baseline ${target.baselineMs} ms); profile ${input.profile.name}, seed ${input.seedScale}; ${logins.length} users (${missing.length} to sign in)`,
  );
  try {
    for (const name of scenarios) {
      const scenario = SCENARIOS[name];
      input.log(`▶ ${name}: ${scenario.description}`);
      const started = performance.now();
      try {
        await scenario.run(ctx);
      } catch (error) {
        scenarioErrors[name] = errorText(error);
        input.log(`  stopped: ${errorText(error)}`);
      }
      input.log(`  ${name} took ${((performance.now() - started) / 1000).toFixed(1)} s`);
    }
  } finally {
    cache.save();
  }
  const finishedAt = new Date();
  const metrics = recorder.summaries();
  const counters = recorder.counters();
  // Count rules (e.g. "0 failed jobs") only mean something for scenarios that ran to the end.
  const completed = new Set(scenarios.filter((name) => !(name in scenarioErrors)));
  const budget = evaluateBudget(metrics, counters, input.profile.name, completed);
  const local = isLocalTarget(input.baseUrl);
  return {
    schema: RESULT_SCHEMA,
    label: input.label ?? (local ? "local tooling smoke" : `${input.profile.name} run`),
    target: { origin: new URL(input.baseUrl).origin, local, ...target },
    profile: input.profile.name,
    seedScale: input.seedScale,
    scenarios,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    machine: {
      cpus: cpus().length,
      loadavgStart,
      loadavgEnd: loadavg(),
      node: process.version,
    },
    signIns: { real: governor.signIns, refreshes: governor.refreshes },
    scenarioErrors,
    metrics,
    counters,
    budget,
    pass: passOf(budget, scenarioErrors),
    disclaimer: local ? LOCAL_DISCLAIMER : null,
  };
}

/**
 * Signs in (and caches) up to `maxSignIns` of the run's users that have no cached sign-in, so a big
 * profile can be prepared over several 15-minute windows. Returns how many are still missing.
 */
export async function warmSessions(
  input: LoadRunInput,
): Promise<{ planned: number; signedIn: number; failed: number; missing: number }> {
  await preflight(input.baseUrl);
  const personas = seedPersonas(input.seedScale, input.seed);
  const cache = new SessionCache(input.cachePath);
  const logins = plannedLogins(orderScenarios(input.scenarios), {
    personas,
    profile: input.profile,
  });
  const todo = uncachedLogins(cache, input.baseUrl, logins).slice(0, input.maxSignIns);
  const recorder = new Recorder();
  const governor = new SignInGovernor(input.maxSignIns);
  const deps = {
    baseUrl: input.baseUrl,
    password: input.password,
    recorder,
    governor,
    cache,
    appVersionCode: input.appVersionCode,
  };
  let signedIn = 0;
  const errors = await pool(todo, 4, async (login) => {
    if (isLineman(login)) await signInMobile(deps, login);
    else await signInWeb(deps, login);
    signedIn += 1;
  });
  for (const error of errors) input.log(`  ${errorText(error)}`);
  cache.save();
  return {
    planned: logins.length,
    signedIn,
    failed: errors.length,
    missing: uncachedLogins(cache, input.baseUrl, logins).length,
  };
}

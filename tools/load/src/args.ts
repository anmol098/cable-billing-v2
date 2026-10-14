/** Command-line options for `pnpm load …` (see `pnpm load --help`). */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isSeedScale, SEED_DEV_PASSWORD, type SeedScale } from "@cb/db/seed";
import { DEFAULT_MAX_SIGN_INS, SIGN_IN_PER_IP_LIMIT } from "./auth";
import { isProfileName, PROFILES, type Profile } from "./profiles";
import { isScenarioName, SCENARIO_NAMES, type ScenarioName } from "./scenarios";

export const COMMANDS = ["run", "warm", "plan", "check"] as const;
export type Command = (typeof COMMANDS)[number];

/** The seed's dev password (T-036); override with `LOAD_PASSWORD`. */
export const SEED_PASSWORD: string = SEED_DEV_PASSWORD;

export const HELP = `Usage: pnpm load <command> [options]

Commands
  run     Run the scenarios against --base-url and write summary.json + summary.md.
  warm    Sign in (and cache) the users a run needs, at most --max-sign-ins per call.
          Repeat every 15 minutes until it reports none missing (big profiles).
  plan    Print who a run would sign in and what it would do. Sends nothing.
  check   Re-check a stored summary.json against the current budget: pnpm load check <file> --gate

Options
  --base-url URL         Target, e.g. a Vercel preview URL (env LOAD_BASE_URL).
  --profile NAME         smoke | legacy | 10x (default smoke).
  --seed-scale NAME      The T-036 seed on the target: small | legacy | 10x (default: the profile's).
  --seed N               The seed's --seed value (default 1).
  --scenarios LIST       Comma-separated: ${SCENARIO_NAMES.join(", ")}, or all (default all).
  --gate                 Exit 1 when a budget line fails or a scenario stops (for CI).
  --out DIR              Result folder (default tools/load/results/<timestamp>).
  --label TEXT           A name for the run in the report (env LOAD_LABEL).
  --max-sign-ins N       Real sign-ins this call may make, 0–${SIGN_IN_PER_IP_LIMIT} (default ${DEFAULT_MAX_SIGN_INS}).
  --no-cache             Don't read or write the sign-in cache (tools/load/.cache/sessions.json).
  --app-version-code N   x-app-version-code the phones send (default 1).
  --billing-workers N    Parallel job-worker calls in the billing scenario (default 1).
  -h, --help

Environment
  LOAD_PASSWORD          Password of the seeded users (default the seed's dev password).
  LOAD_CRON_SECRET       The target's CRON_SECRET (only the billing scenario needs it).
  LOAD_VERCEL_BYPASS_SECRET  Vercel "Protection Bypass for Automation" secret of a protected preview.
  LOAD_FORBIDDEN_HOSTS   Comma-separated hosts the tool refuses (set the production host here).

Exit codes: 0 ok · 1 budget failed (with --gate) · 2 bad options or refused · 3 target not ready.
`;

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface CliOptions {
  readonly command: Command;
  readonly help: boolean;
  readonly baseUrl: string | undefined;
  readonly profile: Profile;
  readonly seedScale: SeedScale;
  readonly seed: string;
  readonly scenarios: readonly ScenarioName[];
  readonly gate: boolean;
  readonly out: string;
  readonly label: string | undefined;
  readonly maxSignIns: number;
  readonly cachePath: string | null;
  readonly appVersionCode: number;
  readonly billingWorkers: number;
  readonly password: string;
  readonly cronSecret: string | undefined;
  /** Sent on every request (Vercel deployment-protection bypass for a protected preview). */
  readonly extraHeaders: Readonly<Record<string, string>>;
  /** For `check`: the summary.json to re-check. */
  readonly file: string | undefined;
}

function integer(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  }
  return parsed;
}

/** Refuses non-http(s) URLs and hosts listed in `LOAD_FORBIDDEN_HOSTS`. */
export function checkBaseUrl(raw: string, forbidden: string | undefined): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--base-url is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--base-url must be http(s)");
  }
  const hosts = (forbidden ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.includes(url.hostname.toLowerCase())) {
    throw new UsageError(`${url.hostname} is in LOAD_FORBIDDEN_HOSTS: never load-test production`);
  }
  return url.origin;
}

export function parseCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  now = new Date(),
  toolDir = ".",
): CliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      "base-url": { type: "string" },
      profile: { type: "string" },
      "seed-scale": { type: "string" },
      seed: { type: "string" },
      scenarios: { type: "string" },
      gate: { type: "boolean", default: false },
      out: { type: "string" },
      label: { type: "string" },
      "max-sign-ins": { type: "string" },
      "no-cache": { type: "boolean", default: false },
      "app-version-code": { type: "string" },
      "billing-workers": { type: "string" },
    },
  });
  const [first, file] = positionals;
  const command = (first ?? "run") as Command;
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`unknown command "${first}" (${COMMANDS.join(", ")})`);
  }
  const profileName = values.profile ?? "smoke";
  if (!isProfileName(profileName)) throw new UsageError(`unknown --profile "${profileName}"`);
  const profile = PROFILES[profileName];
  const seedScale = values["seed-scale"] ?? profile.seedScale;
  if (!isSeedScale(seedScale)) throw new UsageError(`unknown --seed-scale "${seedScale}"`);
  const list = (values.scenarios ?? "all").split(",").map((name) => name.trim());
  const scenarios: ScenarioName[] = [];
  for (const name of list) {
    if (name === "all") scenarios.push(...SCENARIO_NAMES);
    else if (isScenarioName(name)) scenarios.push(name);
    else throw new UsageError(`unknown scenario "${name}" (${SCENARIO_NAMES.join(", ")}, all)`);
  }
  const rawUrl = values["base-url"] ?? env.LOAD_BASE_URL;
  const baseUrl = rawUrl ? checkBaseUrl(rawUrl, env.LOAD_FORBIDDEN_HOSTS) : undefined;
  if ((command === "run" || command === "warm") && !baseUrl && !values.help) {
    throw new UsageError("--base-url (or LOAD_BASE_URL) is required");
  }
  if (command === "check" && !file && !values.help) {
    throw new UsageError("check needs the summary.json to re-check");
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    command,
    help: values.help ?? false,
    baseUrl,
    profile,
    seedScale,
    seed: values.seed ?? "1",
    scenarios: [...new Set(scenarios)],
    gate: values.gate ?? false,
    out: values.out ?? join(toolDir, "results", `${stamp}-${profile.name}`),
    label: values.label ?? env.LOAD_LABEL,
    maxSignIns: integer(
      values["max-sign-ins"],
      "max-sign-ins",
      DEFAULT_MAX_SIGN_INS,
      0,
      SIGN_IN_PER_IP_LIMIT,
    ),
    cachePath: values["no-cache"] ? null : join(toolDir, ".cache", "sessions.json"),
    appVersionCode: integer(values["app-version-code"], "app-version-code", 1, 1, 2_100_000_000),
    billingWorkers: integer(values["billing-workers"], "billing-workers", 1, 1, 4),
    password: env.LOAD_PASSWORD || SEED_PASSWORD,
    cronSecret: env.LOAD_CRON_SECRET || undefined,
    extraHeaders: env.LOAD_VERCEL_BYPASS_SECRET
      ? { "x-vercel-protection-bypass": env.LOAD_VERCEL_BYPASS_SECRET }
      : {},
    file,
  };
}

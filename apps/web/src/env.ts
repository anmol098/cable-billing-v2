/**
 * Environment variables, validated with Zod. Import `serverEnv` / `clientEnv` (and the helpers
 * below) instead of reading `process.env` anywhere else in the app. Every variable is documented in
 * `apps/web/.env.example`; how to obtain each one is in `docs/runbooks/environments.md`.
 *
 * - **Server** variables are parsed from `process.env` when this module first loads on the server.
 *   `next.config.ts` and `src/instrumentation.ts` import it, so `next build`, `next start` and
 *   `next dev` fail fast with a readable list of problems. In the browser `serverEnv` is a guard
 *   that throws on any read, so a server secret can never be bundled by accident.
 * - **Client** variables must start with `NEXT_PUBLIC_` and must be listed one by one in
 *   `clientSource` below: Next.js only inlines `process.env.NEXT_PUBLIC_X` when it is written out
 *   literally.
 *
 * Policy (T-011): two layers, so that `next build` with no env at all still works (local, CI).
 *
 * 1. **Format** is always checked: a variable that is set must be valid, everywhere. Every
 *    variable is optional at this layer; `""` counts as unset.
 * 2. **Presence** depends on where the code runs (`deploymentEnvProblems`):
 *    - local / CI (no `VERCEL_ENV`): nothing is required. Features that need a variable call
 *      `requireServerEnv(...)` when they run and fail there with a clear `EnvError`.
 *    - Vercel preview (and the staging custom environment, which Vercel also reports as
 *      `preview`): `REQUIRED_IN_PREVIEW`, checked when a server instance boots.
 *    - Vercel production: `REQUIRED_IN_PRODUCTION` plus key-mode rules, checked by `next build`
 *      (so a broken production deploy never goes live) and again at boot.
 */
import { z } from "zod";

const isServer = typeof window === "undefined";

// Zod's JIT probes `new Function()`, which a CSP without 'unsafe-eval' rejects (and reports).
// The browser doesn't need the speed-up, so turn it off there before the first parse. This module
// is the first app code the browser runs (via instrumentation-client.ts).
if (!isServer) z.config({ jitless: true });

/** Treat `FOO=` (empty string, common in Vercel and `.env` files) the same as unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const vercelEnv = z.enum(["production", "preview", "development"]);

/** An http(s) origin such as `https://example.com` (no path, query or hash); trailing `/` dropped. */
const origin = z
  .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash;
  }, "must be an origin only, like https://example.com (no path, query or hash)")
  .transform((value) => new URL(value).origin);

const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: "must be a postgres:// or postgresql:// connection string",
});

/** A shared secret we generate ourselves (`openssl rand -base64 32`). */
const generatedSecret = (min: number) =>
  z.string().min(min, `must be at least ${min} characters (generate: openssl rand -base64 32)`);

/** `noreply@example.com` or `Cable Billing <noreply@example.com>`. */
const emailFrom = z
  .string()
  .regex(
    /^(?:[^<>@\r\n]+\s<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/,
    'must be "name@domain" or "Name <name@domain>"',
  );

/** A bare host name as Vercel provides it (`my-app-git-x.vercel.app`, no protocol). */
const host = z.string().regex(/^[a-z0-9.-]+(?::\d+)?$/i, "must be a host name without protocol");

/** Variables that only work together: when one of a pair is set, the other must be too. */
const PAIRS: ReadonlyArray<readonly [keyof ServerShape, keyof ServerShape]> = [
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"],
];

const serverShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- Vercel system variables (set automatically; never set them by hand) ---
  /** `production`, `preview` (includes custom environments such as staging) or `development`. */
  VERCEL_ENV: optional(vercelEnv),
  /** The commit being deployed. Reported by `/api/health`, used as the Sentry release. */
  VERCEL_GIT_COMMIT_SHA: optional(z.string().min(1)),
  /** Host of this deployment (`<project>-<hash>.vercel.app`). Fallback base URL on previews. */
  VERCEL_URL: optional(host),
  /** Host that always points at the latest deployment of the git branch. Preferred on previews. */
  VERCEL_BRANCH_URL: optional(host),

  // --- Database (Neon; Docker Postgres locally) ---
  /** Pooled connection string used by the app at runtime (Neon host with `-pooler`). */
  DATABASE_URL: optional(postgresUrl),
  /** Direct (unpooled) connection string: migrations, drizzle-kit, long sessions. */
  DATABASE_URL_UNPOOLED: optional(postgresUrl),

  // --- Auth (Better Auth) ---
  /** Signs and encrypts session cookies and tokens. Rotating it signs everyone out. */
  BETTER_AUTH_SECRET: optional(generatedSecret(32)),

  // --- Public URLs (the domain is not decided yet, D-21: never hard-code a host) ---
  /** Origin of the web app: auth callbacks, links in emails. Optional off Vercel (see baseUrls). */
  APP_BASE_URL: optional(origin),
  /** Origin used for public receipt links (`/r/<token>`). Defaults to APP_BASE_URL. */
  RECEIPT_BASE_URL: optional(origin),

  // --- Email (Resend) ---
  RESEND_API_KEY: optional(z.string().startsWith("re_", 'must start with "re_"')),
  /** Sender, e.g. `Cable Billing <noreply@your-domain>`; the domain must be verified in Resend. */
  EMAIL_FROM: optional(emailFrom),

  // --- Bot protection on sign-up (Cloudflare Turnstile); site key is NEXT_PUBLIC_ ---
  TURNSTILE_SECRET_KEY: optional(z.string().min(1)),

  // --- Rate limiting (Upstash Redis REST) ---
  UPSTASH_REDIS_REST_URL: optional(z.url({ protocol: /^https$/, error: "must be an https URL" })),
  UPSTASH_REDIS_REST_TOKEN: optional(z.string().min(1)),

  // --- Cron (Vercel sends `Authorization: Bearer <CRON_SECRET>`) ---
  CRON_SECRET: optional(generatedSecret(16)),

  // --- SaaS subscription (Razorpay, D-12) ---
  RAZORPAY_KEY_ID: optional(
    z
      .string()
      .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must look like "rzp_test_…" or "rzp_live_…"'),
  ),
  RAZORPAY_KEY_SECRET: optional(z.string().min(1)),
  /** The secret typed into the Razorpay webhook settings; verifies webhook signatures. */
  RAZORPAY_WEBHOOK_SECRET: optional(generatedSecret(16)),
  /** The ₹400 + GST = ₹472/month plan (D-22). Test and live mode have different plan ids. */
  RAZORPAY_PLAN_ID: optional(z.string().regex(/^plan_[A-Za-z0-9]+$/, 'must look like "plan_…"')),

  // --- Monitoring (Sentry, E-08) ---
  /** Sentry DSN for server and edge code. Sentry stays disabled while it is unset. */
  SENTRY_DSN: optional(z.url()),
  /** Overrides the Sentry environment name (default: VERCEL_ENV, else NODE_ENV). */
  SENTRY_ENVIRONMENT: optional(z.string().min(1)),
  /** Build only (`next.config.ts`): source-map upload target. Upload runs only with the token. */
  SENTRY_ORG: optional(z.string().min(1)),
  SENTRY_PROJECT: optional(z.string().min(1)),
  SENTRY_AUTH_TOKEN: optional(z.string().min(1)),
};
type ServerShape = typeof serverShape;

export const serverSchema = z.object(serverShape).superRefine((env, ctx) => {
  for (const [a, b] of PAIRS) {
    if (Boolean(env[a]) !== Boolean(env[b])) {
      const missing = env[a] ? b : a;
      ctx.addIssue({
        code: "custom",
        path: [missing],
        message: `must be set together with ${missing === a ? b : a}`,
      });
    }
  }
});

export const clientSchema = z.object({
  /** Sentry DSN for browser code. Sentry stays disabled in the browser while it is unset. */
  NEXT_PUBLIC_SENTRY_DSN: optional(z.url()),
  /** Exposed automatically by Vercel; used as the browser's Sentry environment. */
  NEXT_PUBLIC_VERCEL_ENV: optional(vercelEnv),
  /** Cloudflare Turnstile site key (public) for the sign-up widget. */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optional(z.string().min(1)),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;
export type AppEnv = ServerEnv & ClientEnv;

export class EnvError extends Error {
  override name = "EnvError";
}

const HELP = "See apps/web/.env.example and docs/runbooks/environments.md.";

/**
 * Parses `source` with `schema` and throws one `EnvError` listing every invalid variable.
 * Values are never echoed, only names and reasons, because they may be secrets.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined>,
  label: string,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
  throw new EnvError(`Invalid ${label} environment variables:\n${lines.join("\n")}\n${HELP}`);
}

// ---------------------------------------------------------------------------------------------
// Presence rules per deployment
// ---------------------------------------------------------------------------------------------

/** Needed by every Vercel deployment, previews included (the Neon integration sets DATABASE_URL). */
export const REQUIRED_IN_PREVIEW = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
] as const satisfies ReadonlyArray<keyof AppEnv>;

/** Needed by production. RECEIPT_BASE_URL is optional (defaults to APP_BASE_URL). */
export const REQUIRED_IN_PRODUCTION = [
  ...REQUIRED_IN_PREVIEW,
  "APP_BASE_URL",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "TURNSTILE_SECRET_KEY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_PLAN_ID",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
] as const satisfies ReadonlyArray<keyof AppEnv>;

export type DeploymentTarget = "production" | "preview" | "local";

/** Where this code runs. `vercel dev` (`VERCEL_ENV=development`) counts as local. */
export function deploymentTarget(env: Pick<ServerEnv, "VERCEL_ENV">): DeploymentTarget {
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview") return "preview";
  return "local";
}

/** Cloudflare's documented Turnstile test keys (always pass / always fail / …). */
const TURNSTILE_TEST_KEY = /^[123]x0+[A-F]{2}$/;

/**
 * Everything wrong with the environment for the current deployment target, as readable lines
 * (names and reasons only, never values). Empty when the environment is fine.
 */
export function deploymentEnvProblems(env: AppEnv): string[] {
  const target = deploymentTarget(env);
  if (target === "local") return [];
  const required: ReadonlyArray<keyof AppEnv> =
    target === "production" ? REQUIRED_IN_PRODUCTION : REQUIRED_IN_PREVIEW;
  const problems = required
    .filter((key) => env[key] === undefined)
    .map((key) => `${key}: required in ${target}`);

  const liveRazorpay = env.RAZORPAY_KEY_ID?.startsWith("rzp_live_");
  if (target === "production") {
    if (env.RAZORPAY_KEY_ID && !liveRazorpay)
      problems.push("RAZORPAY_KEY_ID: production must use live-mode keys (rzp_live_…)");
    for (const key of ["TURNSTILE_SECRET_KEY", "NEXT_PUBLIC_TURNSTILE_SITE_KEY"] as const) {
      const value = env[key];
      if (value && TURNSTILE_TEST_KEY.test(value))
        problems.push(`${key}: production must not use a Cloudflare test key`);
    }
    for (const key of ["APP_BASE_URL", "RECEIPT_BASE_URL"] as const) {
      if (env[key]?.startsWith("http://")) problems.push(`${key}: production must use https`);
    }
    if (env.EMAIL_FROM?.includes("@resend.dev"))
      problems.push("EMAIL_FROM: production must send from your own verified domain");
  } else if (liveRazorpay) {
    problems.push("RAZORPAY_KEY_ID: only production may use live-mode keys; use rzp_test_…");
  }
  return problems;
}

/** Throws one `EnvError` listing every problem from `deploymentEnvProblems`. */
export function assertDeploymentEnv(env: AppEnv): void {
  const problems = deploymentEnvProblems(env);
  if (problems.length === 0) return;
  const target = deploymentTarget(env);
  const lines = problems.map((problem) => `  - ${problem}`).join("\n");
  throw new EnvError(`Environment is not ready for ${target}:\n${lines}\n${HELP}`);
}

/** True while `next build` prerenders pages (Next sets NEXT_PHASE in the build process). */
export function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

// ---------------------------------------------------------------------------------------------
// Feature helpers
// ---------------------------------------------------------------------------------------------

type Present<E, K extends keyof E> = { [P in K]-?: Exclude<E[P], undefined> };

/**
 * Returns the named variables, or throws an `EnvError` naming every one that is unset. Pure
 * version of `requireServerEnv` (use it for client variables: `requireEnv(clientEnv, [...])`).
 */
export function requireEnv<E extends object, K extends keyof E & string>(
  env: E,
  keys: readonly K[],
): Present<E, K> {
  const missing = keys.filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new EnvError(`Missing environment variable(s): ${missing.join(", ")}. ${HELP}`);
  }
  return Object.fromEntries(keys.map((key) => [key, env[key]])) as Present<E, K>;
}

/**
 * Call where a feature needs its variables, at use time (not at module load), so builds and
 * unrelated routes keep working without them:
 * `const { DATABASE_URL } = requireServerEnv("DATABASE_URL");`
 */
export function requireServerEnv<K extends keyof ServerEnv & string>(
  ...keys: K[]
): Present<ServerEnv, K> {
  return requireEnv(serverEnv, keys);
}

/** Local fallback when no base URL is configured and we are not on Vercel (`next dev`). */
const LOCAL_ORIGIN = "http://localhost:3000";

export type BaseUrls = {
  /** Origin of the web app, no trailing slash. */
  app: string;
  /** Origin for public receipt links (`${receipt}/r/<token>`), no trailing slash. */
  receipt: string;
};

/**
 * Resolves the public origins without hard-coding a domain (D-21):
 * `APP_BASE_URL`, else on a Vercel preview the branch URL (or deployment URL), else locally
 * `http://localhost:3000`. Production always has APP_BASE_URL (enforced at build).
 * `RECEIPT_BASE_URL` defaults to the app origin.
 */
export function resolveBaseUrls(
  env: Pick<
    ServerEnv,
    "APP_BASE_URL" | "RECEIPT_BASE_URL" | "VERCEL_ENV" | "VERCEL_URL" | "VERCEL_BRANCH_URL"
  >,
): BaseUrls {
  const target = deploymentTarget(env);
  let app = env.APP_BASE_URL;
  if (!app && target === "preview") {
    const previewHost = env.VERCEL_BRANCH_URL ?? env.VERCEL_URL;
    if (previewHost) app = `https://${previewHost}`;
  }
  if (!app && target === "local") app = LOCAL_ORIGIN;
  if (!app) throw new EnvError(`APP_BASE_URL is not set for ${target}. ${HELP}`);
  return { app, receipt: env.RECEIPT_BASE_URL ?? app };
}

/** `resolveBaseUrls(serverEnv)`: server only. */
export function baseUrls(): BaseUrls {
  return resolveBaseUrls(serverEnv);
}

// ---------------------------------------------------------------------------------------------
// Parsed values
// ---------------------------------------------------------------------------------------------

/** Literal `process.env.NEXT_PUBLIC_*` reads so Next.js can inline them into the browser bundle. */
const clientSource = {
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
};

export const clientEnv: ClientEnv = parseEnv(clientSchema, clientSource, "client");

const browserGuard = new Proxy({} as ServerEnv, {
  get(_target, key) {
    throw new EnvError(`serverEnv.${String(key)} was read in the browser; use clientEnv instead.`);
  },
});

export const serverEnv: ServerEnv = isServer
  ? parseEnv(serverSchema, process.env, "server")
  : browserGuard;

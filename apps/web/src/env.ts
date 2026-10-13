/**
 * Environment variables, validated with Zod. Import `serverEnv` / `clientEnv` instead of reading
 * `process.env` anywhere else in the app.
 *
 * - **Server** variables are parsed from `process.env` when this module first loads on the server.
 *   `next.config.ts` and `src/instrumentation.ts` import it, so `next build`, `next start` and
 *   `next dev` fail fast with a readable list of problems. In the browser `serverEnv` is a guard
 *   that throws on any read, so a server secret can never be bundled by accident.
 * - **Client** variables must start with `NEXT_PUBLIC_` and must be listed one by one in
 *   `clientSource` below: Next.js only inlines `process.env.NEXT_PUBLIC_X` when it is written out
 *   literally.
 *
 * Every variable is optional for now so that a build needs no env at all (T-005). T-011 owns this
 * file next and adds the rest of `.env.example` (database, auth, email, Razorpay …).
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

export const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Set by Vercel: `production`, `preview` or `development`. Unset locally and in CI. */
  VERCEL_ENV: optional(z.enum(["production", "preview", "development"])),
  /** Set by Vercel: the commit being deployed. Reported by `/api/health`. */
  VERCEL_GIT_COMMIT_SHA: optional(z.string().min(1)),
  /** Sentry DSN for server and edge code. Sentry stays disabled while it is unset (E-08). */
  SENTRY_DSN: optional(z.url()),
  /** Overrides the Sentry environment name (default: VERCEL_ENV, else NODE_ENV). */
  SENTRY_ENVIRONMENT: optional(z.string().min(1)),
});

export const clientSchema = z.object({
  /** Sentry DSN for browser code. Sentry stays disabled in the browser while it is unset. */
  NEXT_PUBLIC_SENTRY_DSN: optional(z.url()),
  /** Exposed automatically by Vercel; used as the browser's Sentry environment. */
  NEXT_PUBLIC_VERCEL_ENV: optional(z.enum(["production", "preview", "development"])),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;

export class EnvError extends Error {
  override name = "EnvError";
}

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
  throw new EnvError(`Invalid ${label} environment variables:\n${lines.join("\n")}`);
}

/** Literal `process.env.NEXT_PUBLIC_*` reads so Next.js can inline them into the browser bundle. */
const clientSource = {
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
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

/**
 * The app's server singletons for auth (T-026): the service runtime (database client, logger,
 * clock; T-025) and the auth service (@cb/core `createAuthService`). Server-only.
 *
 * Built lazily on first use, so `next build` and routes that don't need them work without any
 * environment (T-011). What each environment gets:
 *
 * | | Rate limits | Reset emails |
 * |---|---|---|
 * | production | Upstash (required by the env module) | Resend (required) |
 * | preview / staging | Upstash when set, else in memory (logged) | Resend when set, else not sent (logged) |
 * | local, CI, e2e | in memory | Resend when set, else captured (`next dev` prints them) |
 */
import {
  type AuthService,
  createAuthService,
  createCaptureTransport,
  createLogger,
  createMemoryRateLimiter,
  createResendTransport,
  createServiceRuntime,
  createUpstashRateLimiter,
  type EmailTransport,
  type Logger,
  type RateLimiter,
  type ServiceRuntime,
  startRuntimeRoleCheck,
} from "@cb/core";
import { createDb } from "@cb/db";
import * as Sentry from "@sentry/nextjs";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { baseUrls, deploymentTarget, requireServerEnv, serverEnv } from "@/env";
import { renderResetEmail } from "./reset-email";

type Singletons = { runtime: ServiceRuntime; auth: AuthService };

// Kept on globalThis so `next dev` hot reloads don't open a new pool each time.
const KEY = Symbol.for("@cb/web/auth-singletons");
const holder = globalThis as unknown as Record<symbol, Singletons | undefined>;

function rateLimiterFor(logger: Logger): RateLimiter {
  const url = serverEnv.UPSTASH_REDIS_REST_URL;
  const token = serverEnv.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createUpstashRateLimiter({ url, token });
  if (deploymentTarget(serverEnv) !== "local") {
    logger.warn("auth.rate_limiter_in_memory", { reason: "upstash_not_configured" });
  }
  return createMemoryRateLimiter();
}

function emailTransportFor(logger: Logger): EmailTransport {
  const apiKey = serverEnv.RESEND_API_KEY;
  const from = serverEnv.EMAIL_FROM;
  if (apiKey && from) return createResendTransport({ apiKey, from });
  const local = deploymentTarget(serverEnv) === "local";
  if (!local) logger.warn("auth.email_not_configured", { reason: "resend_not_configured" });
  return createCaptureTransport({
    // Local development only: show the reset email in the terminal (never on Vercel, never in
    // a production build, which is what e2e runs).
    onSend: (message) => {
      if (local && serverEnv.NODE_ENV === "development") {
        console.warn(`[dev email] ${message.subject}\n${message.text}`);
      }
    },
  });
}

/** Runs `task` after the response is sent (Next's `after`), or just lets it finish. */
function runInBackground(task: Promise<unknown>): void {
  try {
    after(() => task);
  } catch {
    void task;
  }
}

function create(): Singletons {
  const { DATABASE_URL, BETTER_AUTH_SECRET } = requireServerEnv(
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
  );
  const logger = createLogger();
  const runtime = createServiceRuntime({
    db: createDb({ connectionString: DATABASE_URL }),
    logger,
  });
  startRuntimeRoleCheck(runtime, {
    onUnsafe: (report) =>
      Sentry.captureMessage("Unsafe database runtime role", {
        level: "error",
        extra: { issues: report.issues.map((issue) => issue.code) },
      }),
  });
  const transport = emailTransportFor(logger);
  const auth = createAuthService({
    db: runtime.db,
    secret: BETTER_AUTH_SECRET,
    baseURL: baseUrls().app,
    rateLimiter: rateLimiterFor(logger),
    sendPasswordResetEmail: (email) => transport.send(renderResetEmail(email)),
    logger,
    runInBackground,
    // Copies Better Auth's Set-Cookie headers into Next's cookie store; must be the last plugin.
    plugins: [nextCookies()],
  });
  return { runtime, auth };
}

function singletons(): Singletons {
  let value = holder[KEY];
  if (!value) {
    value = create();
    holder[KEY] = value;
  }
  return value;
}

/** The app's service runtime (pass it to `service.call` and `resolveTenantContext`). */
export function getServerRuntime(): ServiceRuntime {
  return singletons().runtime;
}

/** The auth service. Use the helpers in `@/lib/auth/session` in pages and actions. */
export function getAuthService(): AuthService {
  return singletons().auth;
}

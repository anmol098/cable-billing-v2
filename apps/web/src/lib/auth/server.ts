/**
 * The app's server singletons for auth (T-026): the service runtime (database client, logger,
 * clock; T-025), the auth service (@cb/core `createAuthService`) and the self sign-up service
 * (@cb/core `createSignupService`, T-027; same rate limiter and email transport). Server-only.
 *
 * Built lazily on first use, so `next build` and routes that don't need them work without any
 * environment (T-011). What each environment gets:
 *
 * | | Rate limits | Emails (reset, sign-up) | Sign-up bot check |
 * |---|---|---|---|
 * | production | Upstash (required by the env module) | Resend (required) | Turnstile (required) |
 * | preview / staging | Upstash when set, else in memory (logged) | Resend when set, else not sent (logged) | Turnstile when set, else off (logged) |
 * | local, CI, e2e | in memory | Resend when set, else captured (`next dev` prints them; `EMAIL_OUTBOX_DIR` writes files for e2e) | Turnstile when set, else off |
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthEmailMessage,
  type AuthEmailTransport,
  type AuthService,
  type BotCheck,
  createAuthService,
  createCaptureTransport,
  createLogger,
  createMemoryRateLimiter,
  createResendTransport,
  createServiceRuntime,
  createSignupService,
  createTurnstileVerifier,
  createUpstashRateLimiter,
  disabledBotCheck,
  type Logger,
  type RateLimiter,
  type ServiceRuntime,
  type SignupService,
  startRuntimeRoleCheck,
} from "@cb/core";
import { createDb } from "@cb/db";
import * as Sentry from "@sentry/nextjs";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { baseUrls, deploymentTarget, requireServerEnv, serverEnv } from "@/env";
import { renderInviteEmail } from "./invite-email";
import { renderResetEmail } from "./reset-email";
import { renderSignupEmail } from "./signup-email";

type Singletons = {
  runtime: ServiceRuntime;
  auth: AuthService;
  rateLimiter: RateLimiter;
  signup: SignupService;
};

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

function emailTransportFor(logger: Logger): AuthEmailTransport {
  const apiKey = serverEnv.RESEND_API_KEY;
  const from = serverEnv.EMAIL_FROM;
  if (apiKey && from) return createResendTransport({ apiKey, from });
  const local = deploymentTarget(serverEnv) === "local";
  if (!local) logger.warn("auth.email_not_configured", { reason: "resend_not_configured" });
  // Local and CI end-to-end tests only (the env module refuses it on Vercel).
  const outbox = local ? serverEnv.EMAIL_OUTBOX_DIR : undefined;
  return createCaptureTransport({
    // Local development only: show the email in the terminal (never on Vercel, never in a
    // production build, which is what e2e runs).
    onSend: (message) => {
      if (local && serverEnv.NODE_ENV === "development") {
        console.warn(`[dev email] ${message.subject}\n${message.text}`);
      }
      if (outbox) writeToOutbox(outbox, message);
    },
  });
}

/** One JSON file per email, for the e2e tests (`EMAIL_OUTBOX_DIR`). */
function writeToOutbox(dir: string, message: AuthEmailMessage): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${Date.now()}-${randomUUID()}.json`),
    JSON.stringify({ to: message.to, subject: message.subject, text: message.text }),
  );
}

function botCheckFor(logger: Logger): BotCheck {
  const secret = serverEnv.TURNSTILE_SECRET_KEY;
  if (secret) return createTurnstileVerifier({ secret });
  if (deploymentTarget(serverEnv) !== "local") {
    logger.warn("signup.bot_check_off", { reason: "turnstile_not_configured" });
  }
  return disabledBotCheck();
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
  const rateLimiter = rateLimiterFor(logger);
  const auth = createAuthService({
    db: runtime.db,
    secret: BETTER_AUTH_SECRET,
    baseURL: baseUrls().app,
    rateLimiter,
    // T-032: the same link, worded as an invitation when the Owner just added a staff member.
    sendPasswordResetEmail: (email) =>
      transport.send(
        email.invite
          ? renderInviteEmail({ ...email, invite: email.invite })
          : renderResetEmail(email),
      ),
    logger,
    runInBackground,
    // Copies Better Auth's Set-Cookie headers into Next's cookie store; must be the last plugin.
    plugins: [nextCookies()],
  });
  const signup = createSignupService({
    runtime,
    baseURL: baseUrls().app,
    rateLimiter,
    botCheck: botCheckFor(logger),
    sendEmail: (email) => transport.send(renderSignupEmail(email)),
  });
  return { runtime, auth, rateLimiter, signup };
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

/**
 * The rate limiter the auth service uses. The mobile sign-in (T-028) shares it, so web and phone
 * sign-in attempts count against the same per-account limit (in memory too, not only on Upstash).
 */
export function getRateLimiter(): RateLimiter {
  return singletons().rateLimiter;
}

/** Self sign-up (`/signup`, `/verify/<token>`, T-027). */
export function getSignupService(): SignupService {
  return singletons().signup;
}

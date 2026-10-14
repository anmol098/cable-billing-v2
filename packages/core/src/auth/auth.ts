/**
 * Web authentication (T-026, PLAN §9.2, E-04): Better Auth configured for Cable Billing, wrapped
 * in an `AuthService` whose methods the web's server actions call.
 *
 * - **Who:** owners and staff (email or user name + password, 30-day sliding session) and platform
 *   admins (email + password + TOTP, 8-hour session). Linemen can never get a web session; disabled
 *   users and users of a suspended operator neither (checked when a session is created).
 * - **Database:** Better Auth's Drizzle adapter over `withPlatform` transactions (./adapter.ts),
 *   T-021's tables, UUIDv7 ids, verification tokens stored hashed.
 * - **Passwords:** argon2id (./password.ts).
 * - **Rate limits:** a `before` hook on sign-in, password reset and 2FA; Upstash in production,
 *   in memory elsewhere (./rate-limit.ts).
 * - **Cookies:** `cb.session_token` (prefixed `__Secure-` on https), httpOnly, SameSite=Lax,
 *   Secure whenever the app's base URL is https.
 * - **No HTTP endpoints:** the web never mounts `auth.handler`; every flow goes through these
 *   methods from server actions (Next.js checks their Origin), so Better Auth's other endpoints are
 *   not reachable from outside.
 * - **Audit:** sign-in, blocked sign-in, sign-out, sign-out everywhere, reset requested/completed,
 *   2FA enabled (./audit-events.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { type DbClient, operators, sessions, type UserRole, users, uuidv7 } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { APIError, type BetterAuthPlugin, betterAuth } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { twoFactor, username } from "better-auth/plugins";
import { and, eq, ne } from "drizzle-orm";
import type { ServiceRuntime } from "../context/runtime";
import {
  type ContextError,
  resolveTenantContext,
  type TenantContext,
} from "../context/tenant-context";
import { serviceError } from "../errors/errors";
import { createLogger, errorLogFields, type Logger } from "../logging/logger";
import { scrubText } from "../logging/pii";
import { platformAuthAdapter } from "./adapter";
import { type AuthAuditAction, type AuthAuditSubject, recordAuthEvent } from "./audit-events";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from "./password";
import {
  isWebRole,
  platformAdminSessionExpiry,
  SESSION_POLICY,
  type SignInBlockReason,
  type SignInSubject,
  type WebRole,
  webSignInBlock,
} from "./policy";
import { AUTH_RATE_LIMITS, type RateLimiter, type RateLimitRule, rateLimitKey } from "./rate-limit";
import { CLIENT_IP_HEADERS, clientInfo, clientIp, requestIdFromHeaders } from "./request-info";

/** Cookie name prefix: `cb.session_token`, `cb.two_factor`. */
export const AUTH_COOKIE_PREFIX = "cb";
/** Where Better Auth thinks it lives. Never mounted as a route (see the module comment). */
export const AUTH_BASE_PATH = "/api/auth";

/** What the reset email needs. `resetUrl` is single-use and expires (SESSION_POLICY). */
export interface PasswordResetEmail {
  readonly to: string;
  readonly language: "hi" | "en";
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
  /**
   * Set when the Owner just added this staff member and chose "email them a link" (T-032): the
   * same single-use link, worded as an invitation ("set your password").
   */
  readonly invite?: PasswordResetInvite;
}

/** What an invitation email adds to the reset link (T-032). */
export interface PasswordResetInvite {
  /** The business that added them. */
  readonly businessName: string;
  /** Their sign-in name (they can also sign in with the email). */
  readonly login: string;
}

export interface CreateAuthServiceOptions {
  readonly db: DbClient;
  /** `BETTER_AUTH_SECRET` (≥ 32 chars). Signs cookies, encrypts TOTP secrets. */
  readonly secret: string;
  /** The app's origin (`baseUrls().app`), e.g. `https://app.example.com`. */
  readonly baseURL: string;
  readonly rateLimiter: RateLimiter;
  /** Sends the reset email (the web renders it in the user's language). Errors are logged. */
  readonly sendPasswordResetEmail: (email: PasswordResetEmail) => Promise<void>;
  readonly logger?: Logger;
  /** Clock for the platform admin's 8-hour cap. */
  readonly now?: () => Date;
  /** Appended after ours; the web passes `nextCookies()` (it must be last). */
  readonly plugins?: BetterAuthPlugin[];
  /** Runs work after the response (the web passes Next's `after`). Default: awaited. */
  readonly runInBackground?: (task: Promise<unknown>) => void;
}

/** Why an auth call failed. The UI maps each code to one plain sentence. */
export type AuthFailureCode =
  /** Wrong login/password (or the login doesn't exist: same answer, same timing class). */
  | "INVALID_CREDENTIALS"
  | "RATE_LIMITED"
  /** Password was right, but this role can't use the web (lineman). */
  | "ROLE_NOT_ALLOWED"
  /** Password was right, but the user or their operator is switched off. */
  | "ACCOUNT_DISABLED"
  /** Wrong 2FA code. */
  | "INVALID_CODE"
  /** The 2FA step timed out or was used up: sign in again. */
  | "TWO_FACTOR_EXPIRED"
  /**
   * The code was right but turning on 2-step sign-in did not finish as expected; every session of
   * the user was ended to be safe (T-086b). Sign in again and try once more.
   */
  | "SIGN_IN_AGAIN"
  /** Reset link invalid, used or expired. */
  | "INVALID_TOKEN"
  /** New password too short or too long. */
  | "INVALID_PASSWORD"
  /** No (valid) session. */
  | "UNAUTHENTICATED";

export interface AuthFailure {
  readonly code: AuthFailureCode;
  /** For RATE_LIMITED. */
  readonly retryAfterSeconds?: number;
}

export type AuthResult<T> = Result<T, AuthFailure>;

export type SignInOutcome =
  | {
      readonly status: "signed_in";
      readonly userId: string;
      readonly role: WebRole;
      /** Platform admin without TOTP yet: send them to the enrolment page. */
      readonly twoFactorEnrolmentRequired: boolean;
    }
  /** Password right; now the TOTP code (platform admins). */
  | { readonly status: "two_factor_required" };

/** A valid web session, after every policy check. */
export interface WebSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly role: WebRole;
  /** `null` for a platform admin. */
  readonly operatorId: string | null;
  readonly language: "hi" | "en";
  /** The **user** has TOTP on (Better Auth's `user.twoFactorEnabled`). */
  readonly twoFactorEnabled: boolean;
  /**
   * **This session** passed a TOTP check (the sign-in 2FA step, or enrolment), T-086b. A platform
   * admin's session that lacks it while their TOTP is on is revoked by `getSession`.
   */
  readonly twoFactorVerified: boolean;
  /** Platform admin who must enrol TOTP before anything else. */
  readonly twoFactorEnrolmentRequired: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface TwoFactorEnrolment {
  /** `otpauth://totp/...` for authenticator apps. */
  readonly totpUri: string;
  /** The base32 secret, for typing into the app by hand. */
  readonly secret: string;
  /** One-time recovery codes. Shown once. */
  readonly backupCodes: readonly string[];
}

const SIGN_IN_PATHS = new Set(["/sign-in/username", "/sign-in/email"]);

/**
 * The Better Auth endpoint (twoFactor plugin, `auth.api.verifyTOTP`) that creates a session only
 * after a TOTP code was checked: the sign-in 2FA step (`verifyTwoFactor`) and the enrolment
 * re-issue (`confirmTwoFactorEnrolment`). A session created by any other endpoint is password-only.
 */
const TOTP_VERIFY_PATH = "/two-factor/verify-totp";

/** Error codes our hooks put into Better Auth errors. */
const RATE_LIMITED = "RATE_LIMITED";
const ROLE_NOT_ALLOWED = "ROLE_NOT_ALLOWED";
const ACCOUNT_DISABLED = "ACCOUNT_DISABLED";

const RESET_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const TOTP_CODE = /^\d{6}$/;

type Body = Record<string, unknown> | undefined;

interface CallScope {
  readonly headers: Headers;
  /** Set by `onPasswordReset`. */
  resetSubject?: AuthAuditSubject;
  /** Set by `requestPasswordReset({ invite })` (T-032): the link email is an invitation. */
  readonly invite?: PasswordResetInvite;
  /** Set by the session-create hook: the token of a session that passed TOTP in this call. */
  totpSessionToken?: string;
}

/** Builds the auth service. No I/O until a method is called. */
export function createAuthService(options: CreateAuthServiceOptions) {
  const { db, rateLimiter } = options;
  const logger = options.logger ?? createLogger();
  const now = options.now ?? (() => new Date());
  /**
   * Per-call state shared with Better Auth callbacks that don't receive the request: the caller's
   * headers (audit metadata) and what a callback learned (who reset their password).
   */
  const scope = new AsyncLocalStorage<CallScope>();
  const scopedHeaders = (fallback?: Headers | null) =>
    fallback ?? scope.getStore()?.headers ?? new Headers();

  const audit = (
    action: AuthAuditAction,
    subject: AuthAuditSubject,
    headers: Headers,
    after?: Record<string, string | number | boolean>,
  ) => recordAuthEvent({ db, logger }, { action, subject, headers, ...(after ? { after } : {}) });

  /** The user's role, status and operator status, read fresh (platform path). */
  async function loadSubject(userId: string): Promise<(SignInSubject & { userId: string }) | null> {
    const rows = await db.withPlatform(
      (tx) =>
        tx
          .select({
            role: users.role,
            status: users.status,
            operatorId: users.operatorId,
            operatorStatus: operators.status,
          })
          .from(users)
          .leftJoin(operators, eq(operators.id, users.operatorId))
          .where(eq(users.id, userId))
          .limit(1),
      { accessMode: "read only" },
    );
    const row = rows[0];
    return row ? { userId, ...row } : null;
  }

  /** Counts one attempt; fails open (logged) when the limiter itself is down. */
  async function hit(key: string, rule: RateLimitRule, path: string): Promise<void> {
    let result: Awaited<ReturnType<RateLimiter["hit"]>>;
    try {
      result = await rateLimiter.hit(key, rule);
    } catch (error) {
      logger.error("auth.rate_limit_unavailable", {
        limiter: rateLimiter.kind,
        path,
        ...errorLogFields(error),
      });
      return;
    }
    if (result.allowed) return;
    logger.warn("auth.rate_limited", { path, scope: key.split(":").slice(0, 2).join(":") });
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { code: RATE_LIMITED, message: "Too many attempts", retryAfter: result.retryAfterSeconds },
      { "Retry-After": String(result.retryAfterSeconds) },
    );
  }

  /** Same account key for "ramesh" and "ramesh@x.in" when both are the same user. */
  async function accountKey(identifier: string): Promise<string> {
    const value = identifier.trim().toLowerCase();
    const rows = await db.withPlatform(
      (tx) =>
        tx
          .select({ id: users.id })
          .from(users)
          .where(value.includes("@") ? eq(users.email, value) : eq(users.login, value))
          .limit(1),
      { accessMode: "read only" },
    );
    const id = rows[0]?.id;
    return id ? rateLimitKey("signin:account", id) : rateLimitKey("signin:login", value);
  }

  const rateLimitHook = createAuthMiddleware(async (ctx) => {
    const path = ctx.path;
    const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();
    const ip = clientIp(headers) ?? "unknown";
    const body = ctx.body as Body;
    if (SIGN_IN_PATHS.has(path)) {
      await hit(rateLimitKey("signin:ip", ip), AUTH_RATE_LIMITS.signInPerIp, path);
      const identifier = body?.username ?? body?.email;
      if (typeof identifier === "string" && identifier.trim()) {
        await hit(await accountKey(identifier), AUTH_RATE_LIMITS.signInPerAccount, path);
      }
    } else if (path === "/request-password-reset") {
      await hit(rateLimitKey("reset:ip", ip), AUTH_RATE_LIMITS.resetRequestPerIp, path);
      if (typeof body?.email === "string") {
        const email = body.email.trim().toLowerCase();
        await hit(rateLimitKey("reset:email", email), AUTH_RATE_LIMITS.resetRequestPerEmail, path);
      }
    } else if (path === "/reset-password") {
      await hit(rateLimitKey("reset-password:ip", ip), AUTH_RATE_LIMITS.resetPerIp, path);
    } else if (path.startsWith("/two-factor/")) {
      await hit(rateLimitKey("2fa:ip", ip), AUTH_RATE_LIMITS.twoFactorPerIp, path);
    }
  });

  const auth = betterAuth({
    appName: "Cable Billing",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: AUTH_BASE_PATH,
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      log: (level, message) => {
        const fields = { message: scrubText(String(message)).slice(0, 200) };
        if (level === "error") logger.error("auth.library_error", fields);
        else logger.warn("auth.library_warning", fields);
      },
    },
    database: platformAuthAdapter(db),
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: options.baseURL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { ipAddressHeaders: [...CLIENT_IP_HEADERS] },
      ...(options.runInBackground ? { backgroundTasks: { handler: options.runInBackground } } : {}),
    },
    // Better Auth's own limiter only covers its HTTP router, which we don't mount; ours runs as a
    // hook for every call (see rateLimitHook).
    rateLimit: { enabled: false },
    session: {
      expiresIn: SESSION_POLICY.tenantExpiresInSeconds,
      updateAge: SESSION_POLICY.updateAgeSeconds,
      cookieCache: { enabled: false },
      additionalFields: {
        // T-086b: set only by the session-create hook below (never input, never copied).
        twoFactorVerifiedAt: { type: "date", required: false, input: false },
      },
    },
    verification: { storeIdentifier: "hashed" },
    emailAndPassword: {
      enabled: true,
      // Owners are created by sign-up provisioning (T-027), staff and linemen by the owner (T-032).
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      password: { hash: hashPassword, verify: verifyPassword },
      resetPasswordTokenExpiresIn: SESSION_POLICY.resetTokenExpiresInSeconds,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        const store = scope.getStore();
        const subject = subjectOf(user as unknown as Record<string, unknown>);
        if (store && subject) store.resetSubject = subject;
      },
      sendResetPassword: async ({ user, token }) => {
        const extra = user as typeof user & { role?: UserRole; status?: string; language?: string };
        // Email reset is for owners and staff only (linemen: the owner resets them, T-032).
        if (extra.role !== "owner" && extra.role !== "staff") return;
        if (extra.status !== "active" || !user.email) return;
        const subject = subjectOf(user as unknown as Record<string, unknown>);
        if (subject) {
          await audit("auth.password_reset_requested", subject, scopedHeaders());
        }
        const invite = scope.getStore()?.invite;
        try {
          await options.sendPasswordResetEmail({
            to: user.email,
            language: extra.language === "hi" ? "hi" : "en",
            resetUrl: `${options.baseURL}/reset/${encodeURIComponent(token)}`,
            expiresInMinutes: Math.round(SESSION_POLICY.resetTokenExpiresInSeconds / 60),
            ...(invite ? { invite } : {}),
          });
          logger.info("auth.reset_email_sent", { user_id: user.id });
        } catch (error) {
          // Never surface (the answer must not depend on whether the address has an account).
          logger.error("auth.reset_email_failed", { user_id: user.id, ...errorLogFields(error) });
        }
      },
    },
    user: {
      additionalFields: {
        operatorId: { type: "string", required: false, input: false },
        role: { type: "string", required: false, input: false },
        language: { type: "string", required: false, input: false },
        phone: { type: "string", required: false, input: false, returned: false },
        status: { type: "string", required: false, input: false },
        legacySource: { type: "string", required: false, input: false, returned: false },
        legacyId: { type: "string", required: false, input: false, returned: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // The one gate every web session passes (password sign-in, 2FA step, re-issues).
          before: async (session, ctx) => {
            const subject = await loadSubject(session.userId);
            if (!subject) {
              throw new APIError("UNAUTHORIZED", { code: "INVALID_CREDENTIALS", message: "" });
            }
            const block = webSignInBlock(subject);
            if (block) {
              const headers = scopedHeaders(ctx?.headers ?? ctx?.request?.headers);
              await audit("auth.sign_in_blocked", subject, headers, { reason: block });
              logger.warn("auth.sign_in_blocked", { user_id: subject.userId, reason: block });
              throw blockedError(block);
            }
            // T-086b: record whether THIS session passed TOTP. Only the TOTP verify endpoint
            // creates a session after checking a code (sign-in 2FA step, enrolment re-issue);
            // every other session is password-only. Forced either way, so a value can never be
            // carried over from an older session that Better Auth re-issues.
            const totpVerified = ctx?.path === TOTP_VERIFY_PATH;
            const twoFactorVerifiedAt = totpVerified ? now() : null;
            if (totpVerified) {
              const store = scope.getStore();
              if (store) store.totpSessionToken = session.token;
            }
            if (subject.role === "platform_admin") {
              const createdAt = session.createdAt ?? now();
              const cap = platformAdminSessionExpiry(createdAt);
              const expiresAt = session.expiresAt < cap ? session.expiresAt : cap;
              return { data: { ...session, expiresAt, twoFactorVerifiedAt } };
            }
            return { data: { ...session, twoFactorVerifiedAt } };
          },
        },
        update: {
          // Better Auth slides every session it refreshes to `expiresIn` (30 days); a platform
          // admin's must stay within 8 hours of sign-in. (getSession also enforces the cap.)
          before: async (data, ctx) => {
            // T-086b: the TOTP marker is written only when a session is created, never updated
            // (Better Auth never sends it: the field is `input: false`; this keeps it that way).
            if ("twoFactorVerifiedAt" in data) {
              throw new Error("sessions.two_factor_verified_at is never updated");
            }
            const current = (
              ctx?.context as
                | { session?: { session?: { createdAt?: Date }; user?: { role?: unknown } } | null }
                | undefined
            )?.session;
            if (!data.expiresAt || current?.user?.role !== "platform_admin") return { data };
            const createdAt = current.session?.createdAt;
            const cap = platformAdminSessionExpiry(createdAt ? new Date(createdAt) : now());
            const expiresAt = new Date(data.expiresAt) < cap ? new Date(data.expiresAt) : cap;
            return { data: { ...data, expiresAt } };
          },
        },
      },
    },
    hooks: { before: rateLimitHook },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 100,
        // Matches the DB rule (no spaces, 3–100); `@` means "this is an email" on the login form.
        usernameValidator: (value) => /^[^\s@]{3,100}$/.test(value),
        schema: { user: { fields: { username: "login", displayUsername: "displayLogin" } } },
      }),
      twoFactor({
        issuer: "Cable Billing",
        twoFactorCookieMaxAge: SESSION_POLICY.twoFactorChallengeSeconds,
        totpOptions: { digits: 6, period: 30 },
      }),
      ...(options.plugins ?? []),
    ],
  });

  /** Runs a Better Auth call with the caller's headers available to callbacks. */
  const withHeaders = <T>(headers: Headers, fn: () => Promise<T>, store: CallScope = { headers }) =>
    scope.run(store, fn);

  /** An `APIError` → our failure code (anything else is rethrown: a bug or an outage). */
  function failureOf(error: unknown, fallback: AuthFailureCode): AuthFailure {
    if (!isAPIError(error)) throw error;
    const code = (error.body as { code?: unknown } | undefined)?.code;
    if (code === RATE_LIMITED || code === "ACCOUNT_TEMPORARILY_LOCKED") {
      const retry = Number((error.body as { retryAfter?: unknown }).retryAfter);
      return {
        code: "RATE_LIMITED",
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
      };
    }
    if (code === ROLE_NOT_ALLOWED) return { code: "ROLE_NOT_ALLOWED" };
    if (code === ACCOUNT_DISABLED) return { code: "ACCOUNT_DISABLED" };
    if (code === "INVALID_TWO_FACTOR_COOKIE" || code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
      return { code: "TWO_FACTOR_EXPIRED" };
    }
    if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") {
      return { code: "INVALID_PASSWORD" };
    }
    if (error.statusCode >= 500) throw error;
    return { code: fallback };
  }

  function subjectOf(user: Record<string, unknown>): AuthAuditSubject | null {
    const role = user.role;
    if (typeof user.id !== "string" || typeof role !== "string") return null;
    return {
      userId: user.id,
      role: role as UserRole,
      operatorId: typeof user.operatorId === "string" ? user.operatorId : null,
    };
  }

  /** Reads and checks the session in `headers`. Invalid sessions are deleted. */
  async function getSession(headers: Headers): Promise<WebSession | null> {
    const data = await auth.api.getSession({ headers });
    if (!data) return null;
    const { session, user } = data;
    const subject = await loadSubject(user.id);
    const revoke = async (reason: string) => {
      await db.withPlatform((tx) => tx.delete(sessions).where(eq(sessions.id, session.id)));
      logger.info("auth.session_revoked", { user_id: user.id, reason });
      return null;
    };
    if (!subject) return revoke("unknown_user");
    const block = webSignInBlock(subject);
    if (block || !isWebRole(subject.role)) return revoke(block ?? "role_not_allowed");
    const createdAt = new Date(session.createdAt);
    if (subject.role === "platform_admin" && now() >= platformAdminSessionExpiry(createdAt)) {
      return revoke("platform_admin_session_expired");
    }
    const extra = user as typeof user & { language?: string; twoFactorEnabled?: boolean | null };
    const twoFactorEnabled = extra.twoFactorEnabled === true;
    const verifiedAt = (session as typeof session & { twoFactorVerifiedAt?: Date | string | null })
      .twoFactorVerifiedAt;
    const twoFactorVerified = verifiedAt !== null && verifiedAt !== undefined;
    // T-086b: once an admin has TOTP on, a session that never passed it (opened with the password
    // before enrolment) is not an admin session: end it, so they sign in again with the code.
    if (subject.role === "platform_admin" && twoFactorEnabled && !twoFactorVerified) {
      return revoke("two_factor_not_verified_in_session");
    }
    return {
      sessionId: session.id,
      userId: user.id,
      role: subject.role,
      operatorId: subject.operatorId,
      language: extra.language === "hi" ? "hi" : "en",
      twoFactorEnabled,
      twoFactorVerified,
      twoFactorEnrolmentRequired: subject.role === "platform_admin" && !twoFactorEnabled,
      createdAt,
      expiresAt: new Date(session.expiresAt),
    };
  }

  const service = {
    /** The Better Auth instance (for T-027/T-032 helpers; never mount `auth.handler`). */
    auth,

    /**
     * Password sign-in. `login` is a user name / mobile number, or an email (contains `@`).
     * Unknown login and wrong password give the same answer.
     */
    async signIn(input: {
      login: string;
      password: string;
      headers: Headers;
    }): Promise<AuthResult<SignInOutcome>> {
      const login = input.login.trim();
      if (!login || !input.password || input.password.length > PASSWORD_MAX_LENGTH) {
        return err({ code: "INVALID_CREDENTIALS" });
      }
      try {
        // The 2FA plugin replaces the response with `{ twoFactorRedirect }`, so read it loosely.
        const data = await withHeaders<Record<string, unknown> | null>(input.headers, () =>
          login.includes("@")
            ? auth.api.signInEmail({
                body: { email: login.toLowerCase(), password: input.password, rememberMe: true },
                headers: input.headers,
              })
            : auth.api.signInUsername({
                body: { username: login, password: input.password, rememberMe: true },
                headers: input.headers,
              }),
        );
        if (data?.twoFactorRedirect === true) {
          logger.info("auth.two_factor_challenge");
          return ok({ status: "two_factor_required" });
        }
        const user = data?.user as Record<string, unknown> | undefined;
        const subject = user ? subjectOf(user) : null;
        if (!user || !subject || !isWebRole(subject.role)) {
          throw new Error("signIn: Better Auth returned no usable user");
        }
        await audit("auth.signed_in", subject, input.headers, { method: "password" });
        logger.info("auth.signed_in", { user_id: subject.userId, role: subject.role });
        return ok({
          status: "signed_in",
          userId: subject.userId,
          role: subject.role,
          twoFactorEnrolmentRequired:
            subject.role === "platform_admin" && user.twoFactorEnabled !== true,
        });
      } catch (error) {
        const failure = failureOf(error, "INVALID_CREDENTIALS");
        logger.info("auth.sign_in_failed", { code: failure.code });
        return err(failure);
      }
    },

    /** Second step for a 2FA user: the 6-digit code from the authenticator app. */
    async verifyTwoFactor(input: {
      code: string;
      headers: Headers;
    }): Promise<AuthResult<Extract<SignInOutcome, { status: "signed_in" }>>> {
      const code = input.code.replace(/\s+/g, "");
      if (!TOTP_CODE.test(code)) return err({ code: "INVALID_CODE" });
      const store: CallScope = { headers: input.headers };
      try {
        const data = await withHeaders(
          input.headers,
          () => auth.api.verifyTOTP({ body: { code }, headers: input.headers }),
          store,
        );
        // T-086b: a sign-in is only a sign-in when Better Auth made a new, TOTP-checked session.
        // With a session cookie (and no 2FA challenge) it checks the code against that session
        // and returns its old token, creating nothing: not a sign-in, so not reported as one.
        if (store.totpSessionToken === undefined) {
          logger.warn("auth.two_factor_no_new_session");
          return err({ code: "TWO_FACTOR_EXPIRED" });
        }
        const subject = subjectOf(data.user as unknown as Record<string, unknown>);
        if (!subject || !isWebRole(subject.role)) throw new Error("verifyTwoFactor: no user");
        await audit("auth.signed_in", subject, input.headers, { method: "password_totp" });
        logger.info("auth.signed_in", { user_id: subject.userId, role: subject.role });
        return ok({
          status: "signed_in",
          userId: subject.userId,
          role: subject.role,
          twoFactorEnrolmentRequired: false,
        });
      } catch (error) {
        const failure = failureOf(error, "INVALID_CODE");
        logger.info("auth.two_factor_failed", { code: failure.code });
        return err(failure);
      }
    },

    /**
     * Starts TOTP enrolment for the signed-in user (platform admins must, before /admin).
     * Re-asks the password. Returns the secret to put in an authenticator app.
     */
    async startTwoFactorEnrolment(input: {
      password: string;
      headers: Headers;
    }): Promise<AuthResult<TwoFactorEnrolment>> {
      const session = await getSession(input.headers);
      if (!session) return err({ code: "UNAUTHENTICATED" });
      if (session.twoFactorEnabled) return err({ code: "INVALID_CODE" });
      try {
        const data = await withHeaders(input.headers, () =>
          auth.api.enableTwoFactor({
            body: { password: input.password, method: "totp" },
            headers: input.headers,
          }),
        );
        if (!("totpURI" in data) || typeof data.totpURI !== "string") {
          throw new Error("startTwoFactorEnrolment: no TOTP URI");
        }
        const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
        return ok({ totpUri: data.totpURI, secret, backupCodes: data.backupCodes ?? [] });
      } catch (error) {
        return err(failureOf(error, "INVALID_CREDENTIALS"));
      }
    },

    /**
     * Finishes enrolment with a first code from the app. The session is re-issued (marked as
     * having passed TOTP) and **every other session of the user is ended** (T-086b, for every
     * role: owners and staff too): a session opened with the password alone, in another browser,
     * before enrolment, must not live on. If Better Auth didn't re-issue this browser's session,
     * every session is ended and the answer is SIGN_IN_AGAIN (nothing is audited as turned on).
     */
    async confirmTwoFactorEnrolment(input: {
      code: string;
      headers: Headers;
    }): Promise<AuthResult<{ userId: string; role: WebRole; otherSessionsEnded: number }>> {
      const session = await getSession(input.headers);
      if (!session) return err({ code: "UNAUTHENTICATED" });
      // Already on: nothing to confirm (startTwoFactorEnrolment refuses the same way).
      if (session.twoFactorEnabled) return err({ code: "INVALID_CODE" });
      const code = input.code.replace(/\s+/g, "");
      if (!TOTP_CODE.test(code)) return err({ code: "INVALID_CODE" });
      const store: CallScope = { headers: input.headers };
      try {
        await withHeaders(
          input.headers,
          () => auth.api.verifyTOTP({ body: { code }, headers: input.headers }),
          store,
        );
      } catch (error) {
        return err(failureOf(error, "INVALID_CODE"));
      }
      const subject = {
        userId: session.userId,
        role: session.role,
        operatorId: session.operatorId,
      };
      const keep = store.totpSessionToken;
      const rows = await db.withPlatform((tx) =>
        tx
          .select({ enabled: users.twoFactorEnabled })
          .from(users)
          .where(eq(users.id, session.userId)),
      );
      const enabled = rows[0]?.enabled === true;
      if (keep === undefined || !enabled) {
        // Better Auth accepted the code but did not turn TOTP on with a fresh, TOTP-checked session
        // for this browser (e.g. a `two_factors` row already `verified` while the user's flag is
        // off). Fail closed: end every session of the user, this one too, claim nothing in the
        // audit log, and ask them to sign in again.
        const ended = await db.withPlatform((tx) =>
          tx
            .delete(sessions)
            .where(eq(sessions.userId, session.userId))
            .returning({ id: sessions.id }),
        );
        logger.error("auth.two_factor_enrolment_incomplete", {
          user_id: session.userId,
          reason: keep === undefined ? "no_verified_session" : "not_enabled",
          sessions: ended.length,
        });
        return err({ code: "SIGN_IN_AGAIN" });
      }
      // Keep only the session Better Auth just issued for this browser (it passed TOTP).
      const ended = await db.withPlatform((tx) =>
        tx
          .delete(sessions)
          .where(and(eq(sessions.userId, session.userId), ne(sessions.token, keep)))
          .returning({ id: sessions.id }),
      );
      if (ended.length > 0) {
        await audit("auth.other_sessions_ended", subject, input.headers, {
          sessions: ended.length,
          reason: "two_factor_enabled",
        });
        logger.info("auth.other_sessions_ended", {
          user_id: session.userId,
          sessions: ended.length,
        });
      }
      await audit("auth.two_factor_enabled", subject, input.headers, { method: "totp" });
      logger.info("auth.two_factor_enabled", { user_id: session.userId });
      return ok({ userId: session.userId, role: session.role, otherSessionsEnded: ended.length });
    },

    getSession,

    /** Ends this browser's session (deletes it and clears the cookie). */
    async signOut(input: { headers: Headers }): Promise<AuthResult<void>> {
      const session = await getSession(input.headers);
      await withHeaders(input.headers, () => auth.api.signOut({ headers: input.headers }));
      if (!session) return err({ code: "UNAUTHENTICATED" });
      await audit(
        "auth.signed_out",
        { userId: session.userId, role: session.role, operatorId: session.operatorId },
        input.headers,
      );
      logger.info("auth.signed_out", { user_id: session.userId });
      return ok(undefined);
    },

    /** Ends every session of the signed-in user (all browsers), then this one's cookie. */
    async signOutEverywhere(input: {
      headers: Headers;
    }): Promise<AuthResult<{ sessions: number }>> {
      const session = await getSession(input.headers);
      if (!session) {
        await withHeaders(input.headers, () => auth.api.signOut({ headers: input.headers }));
        return err({ code: "UNAUTHENTICATED" });
      }
      const deleted = await db.withPlatform((tx) =>
        tx
          .delete(sessions)
          .where(eq(sessions.userId, session.userId))
          .returning({ id: sessions.id }),
      );
      await withHeaders(input.headers, () => auth.api.signOut({ headers: input.headers }));
      await audit(
        "auth.signed_out_everywhere",
        { userId: session.userId, role: session.role, operatorId: session.operatorId },
        input.headers,
        { sessions: deleted.length },
      );
      logger.info("auth.signed_out_everywhere", {
        user_id: session.userId,
        sessions: deleted.length,
      });
      return ok({ sessions: deleted.length });
    },

    /**
     * Emails a reset link to an owner/staff address. The answer is the same whether or not the
     * address has an account (only RATE_LIMITED differs, and it counts every address alike).
     *
     * `invite` (T-032, after the Owner added a staff member without a password): the same link,
     * worded as an invitation in the email. Same rules, limits and audit as a reset.
     */
    async requestPasswordReset(input: {
      email: string;
      headers: Headers;
      invite?: PasswordResetInvite;
    }): Promise<AuthResult<void>> {
      const email = input.email.trim().toLowerCase();
      if (!email.includes("@") || email.length > 254) return ok(undefined);
      const store: CallScope = {
        headers: input.headers,
        ...(input.invite ? { invite: input.invite } : {}),
      };
      try {
        await withHeaders(
          input.headers,
          () => auth.api.requestPasswordReset({ body: { email }, headers: input.headers }),
          store,
        );
      } catch (error) {
        const failure = failureOf(error, "INVALID_CREDENTIALS");
        if (failure.code === "RATE_LIMITED") return err(failure);
        logger.warn("auth.reset_request_failed", { code: failure.code });
        return ok(undefined);
      }
      return ok(undefined);
    },

    /** Sets a new password with a reset link's token (single use). Signs out every session. */
    async resetPassword(input: {
      token: string;
      newPassword: string;
      headers: Headers;
    }): Promise<AuthResult<void>> {
      if (!RESET_TOKEN.test(input.token)) return err({ code: "INVALID_TOKEN" });
      if (
        input.newPassword.length < PASSWORD_MIN_LENGTH ||
        input.newPassword.length > PASSWORD_MAX_LENGTH
      ) {
        return err({ code: "INVALID_PASSWORD" });
      }
      const store: CallScope = { headers: input.headers };
      try {
        await withHeaders(
          input.headers,
          () =>
            auth.api.resetPassword({
              body: { token: input.token, newPassword: input.newPassword },
              headers: input.headers,
            }),
          store,
        );
      } catch (error) {
        return err(failureOf(error, "INVALID_TOKEN"));
      }
      if (store.resetSubject) {
        await audit("auth.password_reset_completed", store.resetSubject, input.headers);
        logger.info("auth.password_reset_completed", { user_id: store.resetSubject.userId });
      }
      return ok(undefined);
    },

    /**
     * The TenantContext for the signed-in owner/staff (channel `web`, T-025). Platform admins get
     * FORBIDDEN (`not_a_tenant_user`); no session gives UNAUTHENTICATED (`no_session`).
     */
    async tenantContext(
      runtime: Pick<ServiceRuntime, "db">,
      headers: Headers,
    ): Promise<Result<TenantContext, ContextError>> {
      const session = await getSession(headers);
      if (!session) {
        return err(serviceError("UNAUTHENTICATED", "No web session", { reason: "no_session" }));
      }
      const client = clientInfo(headers);
      return resolveTenantContext(runtime, {
        userId: session.userId,
        channel: "web",
        requestId: requestIdFromHeaders(headers),
        ...(client ? { client } : {}),
      });
    },
  };

  return service;
}

export type AuthService = ReturnType<typeof createAuthService>;

function blockedError(reason: SignInBlockReason): APIError {
  return new APIError("FORBIDDEN", {
    code: reason === "role_not_allowed" ? ROLE_NOT_ALLOWED : ACCOUNT_DISABLED,
    message: "Sign-in not allowed",
  });
}

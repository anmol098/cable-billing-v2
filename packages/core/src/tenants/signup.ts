/**
 * Self sign-up (T-027, D-15, PLAN §12.3): an owner signs up on `/signup`, proves the email with a
 * link, and only then is the tenant created ({@link provisionTenant}). Until then there is no
 * `users` row, so an unverified sign-up can never sign in.
 *
 * 1. `start` (the `/signup` form): checks the fields, the rate limits and Turnstile, hashes the
 *    password (argon2id) and keeps a **pending sign-up** in Better Auth's `verifications` table
 *    (auth path only: `app_platform`), keyed by the SHA-256 of a random link token and expiring
 *    after 24 hours. It emails the link `/verify/<token>`. If the email already has an account, it
 *    sends a "you already have an account" email instead; the page says "check your email" either
 *    way (no account enumeration), and both paths hash the password (same timing class).
 * 2. `pending` (the `/verify/<token>` page): what the page shows (business name, email).
 * 3. `complete` (the "Start" button on that page): the owner types the password again; if it
 *    matches, the tenant is provisioned with the pending sign-up's own `operatorId` as the
 *    idempotency key (a retry or a second tab gets the same tenant), then the pending sign-up is
 *    deleted. Asking for the password proves the person who clicked the link is the person who
 *    signed up (someone who typed another person's email can't activate it), and email link
 *    scanners that open links can't use the link up (opening the page changes nothing).
 *
 * The web signs the owner in right after `complete` with the same password (T-026 sign-in, so
 * the usual session gate and audit apply).
 */
import { createHash, randomBytes } from "node:crypto";
import { LANGUAGES, type Language, type Tx, users, uuidv7, verifications } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, eq, gt, like, lt } from "drizzle-orm";
import * as z from "zod";
import {
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "../auth/password";
import type { RateLimiter, RateLimitRule } from "../auth/rate-limit";
import { rateLimitKey } from "../auth/rate-limit";
import { clientInfo, clientIp, requestIdFromHeaders } from "../auth/request-info";
import type { ServiceRuntime } from "../context/runtime";
import { errorLogFields } from "../logging/logger";
import type { BotCheck } from "./bot-check";
import { provisionTenant } from "./provision";
import { normalizeIndianMobile, TRIAL_DAYS, trialLastDay } from "./rules";

/** How long a sign-up link works. */
export const SIGNUP_LINK_TTL_SECONDS = 24 * 60 * 60;
/** `verifications.identifier` prefix of pending sign-ups (the rest is the token's SHA-256). */
export const SIGNUP_IDENTIFIER_PREFIX = "signup:";

/**
 * Limits (tunable). Per-IP limits are generous (carrier-grade NAT); per-email limits stop someone
 * flooding one inbox; per-link limits stop password guessing on a stolen link.
 */
export const SIGNUP_RATE_LIMITS = Object.freeze({
  startPerIp: { limit: 20, windowSeconds: 60 * 60 },
  startPerEmail: { limit: 3, windowSeconds: 60 * 60 },
  completePerIp: { limit: 30, windowSeconds: 15 * 60 },
  completePerLink: { limit: 10, windowSeconds: 15 * 60 },
} satisfies Record<string, RateLimitRule>);

/** Field limits of the sign-up form (also used by the web form). */
export const SIGNUP_FIELD_LIMITS = Object.freeze({
  businessNameMax: 120,
  ownerNameMax: 120,
  emailMax: 254,
});

/** The emails sign-up sends. The web renders them in `language`. */
export type SignupEmail =
  | {
      readonly kind: "verify";
      readonly to: string;
      readonly language: Language;
      readonly verifyUrl: string;
      readonly expiresInHours: number;
    }
  | {
      /** Someone signed up with an email that already has an account. */
      readonly kind: "already_registered";
      readonly to: string;
      readonly language: Language;
      readonly signInUrl: string;
      readonly resetUrl: string;
    };

export interface CreateSignupServiceOptions {
  readonly runtime: Pick<ServiceRuntime, "db" | "logger" | "now">;
  /** The app's origin, e.g. `https://app.example.com` (links in emails). */
  readonly baseURL: string;
  readonly rateLimiter: RateLimiter;
  readonly botCheck: BotCheck;
  /** Sends one email. Errors make `start` answer EMAIL_FAILED. */
  readonly sendEmail: (email: SignupEmail) => Promise<void>;
  /** Link tokens (tests). Default: 32 random bytes, base64url. */
  readonly newToken?: () => string;
}

export type SignupField = "business_name" | "owner_name" | "mobile" | "email" | "password";
export type SignupFieldProblem = "required" | "too_long" | "too_short" | "invalid";

export type SignupFailure =
  | {
      readonly code: "VALIDATION";
      readonly fields: Partial<Record<SignupField, SignupFieldProblem>>;
    }
  | { readonly code: "RATE_LIMITED"; readonly retryAfterSeconds: number }
  /** Turnstile said no (or could not be reached). */
  | { readonly code: "BOT_CHECK_FAILED" }
  /** The email could not be sent; nothing to do but try again. */
  | { readonly code: "EMAIL_FAILED" }
  /** The link is malformed, expired or already used. */
  | { readonly code: "INVALID_LINK" }
  /** `complete`: the password does not match the one given at sign-up. */
  | { readonly code: "WRONG_PASSWORD" }
  /** `complete`: the email got an account in the meantime (e.g. another sign-up link). */
  | { readonly code: "ACCOUNT_EXISTS" };

export interface SignupStartInput {
  readonly businessName: string;
  readonly ownerName: string;
  readonly mobile: string;
  readonly email: string;
  readonly password: string;
  /** The language the form was shown in: the owner's language and the email's. */
  readonly language: Language;
  /** The Turnstile widget's token (`cf-turnstile-response`). */
  readonly botToken: string;
  readonly headers: Headers;
}

/** What `/verify/<token>` shows before the owner confirms. */
export interface PendingSignupView {
  readonly businessName: string;
  readonly email: string;
  readonly expiresAt: Date;
}

export interface CompletedSignup {
  readonly operatorId: string;
  readonly ownerUserId: string;
  /** Sign in with this (it is what the owner typed). */
  readonly email: string;
  readonly ownerLogin: string;
  /** False when an earlier or parallel click already created the tenant. */
  readonly created: boolean;
  /** Last free IST day, e.g. `2026-11-12`. */
  readonly trialLastDay: string | null;
}

/** The pending sign-up kept in `verifications.value` (JSON). */
const pendingSchema = z.object({
  v: z.literal(1),
  operatorId: z.uuid(),
  businessName: z.string(),
  ownerName: z.string(),
  mobile: z.string(),
  email: z.string(),
  language: z.enum(LANGUAGES),
  passwordHash: z.string(),
});
type PendingSignup = z.infer<typeof pendingSchema>;

/** Link tokens: 32 random bytes as base64url (43 characters). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

/** Checks and normalises the form. Returns per-field problems (never the values). */
export function validateSignupFields(input: {
  businessName: string;
  ownerName: string;
  mobile: string;
  email: string;
  password: string;
}): Result<
  { businessName: string; ownerName: string; mobile: string; email: string; password: string },
  Partial<Record<SignupField, SignupFieldProblem>>
> {
  const problems: Partial<Record<SignupField, SignupFieldProblem>> = {};
  const businessName = collapse(input.businessName);
  const ownerName = collapse(input.ownerName);
  const email = input.email.trim().toLowerCase();
  if (!businessName) problems.business_name = "required";
  else if (businessName.length > SIGNUP_FIELD_LIMITS.businessNameMax)
    problems.business_name = "too_long";
  if (!ownerName) problems.owner_name = "required";
  else if (ownerName.length > SIGNUP_FIELD_LIMITS.ownerNameMax) problems.owner_name = "too_long";
  const mobile = normalizeIndianMobile(input.mobile);
  if (!input.mobile.trim()) problems.mobile = "required";
  else if (!mobile) problems.mobile = "invalid";
  if (!email) problems.email = "required";
  else if (email.length > SIGNUP_FIELD_LIMITS.emailMax || !z.email().safeParse(email).success)
    problems.email = "invalid";
  if (!input.password) problems.password = "required";
  else if (input.password.length < PASSWORD_MIN_LENGTH) problems.password = "too_short";
  else if (input.password.length > PASSWORD_MAX_LENGTH) problems.password = "too_long";
  if (Object.keys(problems).length > 0 || !mobile) return err(problems);
  return ok({ businessName, ownerName, mobile, email, password: input.password });
}

/** `verifications.identifier` of a link token. */
export function signupIdentifier(token: string): string {
  return `${SIGNUP_IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("hex")}`;
}

export function createSignupService(options: CreateSignupServiceOptions) {
  const { runtime, rateLimiter, botCheck } = options;
  const { db, logger } = runtime;
  const baseURL = options.baseURL.replace(/\/+$/, "");
  const newToken = options.newToken ?? (() => randomBytes(32).toString("base64url"));

  /** Counts one attempt. Fails open (logged) when the limiter is down, like sign-in (T-026). */
  async function limited(key: string, rule: RateLimitRule): Promise<SignupFailure | null> {
    try {
      const result = await rateLimiter.hit(key, rule);
      if (result.allowed) return null;
      logger.warn("signup.rate_limited", { scope: key.split(":").slice(0, 2).join(":") });
      return { code: "RATE_LIMITED", retryAfterSeconds: result.retryAfterSeconds };
    } catch (error) {
      logger.error("signup.rate_limit_unavailable", {
        limiter: rateLimiter.kind,
        ...errorLogFields(error),
      });
      return null;
    }
  }

  async function findPending(tx: Tx, token: string) {
    const rows = await tx
      .select({
        id: verifications.id,
        value: verifications.value,
        expiresAt: verifications.expiresAt,
      })
      .from(verifications)
      .where(
        and(
          eq(verifications.identifier, signupIdentifier(token)),
          gt(verifications.expiresAt, runtime.now()),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let json: unknown;
    try {
      json = JSON.parse(row.value);
    } catch {
      return null;
    }
    const parsed = pendingSchema.safeParse(json);
    return parsed.success ? { id: row.id, expiresAt: row.expiresAt, pending: parsed.data } : null;
  }

  async function loadPending(token: string) {
    if (!TOKEN.test(token)) return null;
    return db.withPlatform((tx) => findPending(tx, token), { accessMode: "read only" });
  }

  return {
    /** `/signup`: see the module comment. Same answer whether or not the email has an account. */
    async start(input: SignupStartInput): Promise<Result<{ status: "email_sent" }, SignupFailure>> {
      const fields = validateSignupFields(input);
      if (!fields.ok) return err({ code: "VALIDATION", fields: fields.error });
      const { businessName, ownerName, mobile, email, password } = fields.value;
      const ip = clientIp(input.headers);

      const byIp = await limited(
        rateLimitKey("signup:ip", ip ?? "unknown"),
        SIGNUP_RATE_LIMITS.startPerIp,
      );
      if (byIp) return err(byIp);
      let human: boolean;
      try {
        human = await botCheck.verify({ token: input.botToken, ip });
      } catch (error) {
        logger.error("signup.bot_check_unavailable", {
          checker: botCheck.kind,
          ...errorLogFields(error),
        });
        human = false;
      }
      if (!human) {
        logger.info("signup.bot_check_failed", { checker: botCheck.kind });
        return err({ code: "BOT_CHECK_FAILED" });
      }
      const byEmail = await limited(
        rateLimitKey("signup:email", email),
        SIGNUP_RATE_LIMITS.startPerEmail,
      );
      if (byEmail) return err(byEmail);

      // Hash first, on both paths, so the answer takes about as long whether or not the email
      // already has an account.
      const passwordHash = await hashPassword(password);
      const now = runtime.now();
      const token = newToken();
      const hasAccount = await db.withPlatform(async (tx) => {
        // Expired pending sign-ups (and their password hashes) don't outlive their link.
        await tx
          .delete(verifications)
          .where(
            and(
              like(verifications.identifier, `${SIGNUP_IDENTIFIER_PREFIX}%`),
              lt(verifications.expiresAt, now),
            ),
          );
        const existing = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (existing.length > 0) return true;
        const pending: PendingSignup = {
          v: 1,
          operatorId: uuidv7(),
          businessName,
          ownerName,
          mobile,
          email,
          language: input.language,
          passwordHash,
        };
        await tx.insert(verifications).values({
          id: uuidv7(),
          identifier: signupIdentifier(token),
          value: JSON.stringify(pending),
          expiresAt: new Date(now.getTime() + SIGNUP_LINK_TTL_SECONDS * 1000),
        });
        return false;
      });

      try {
        await options.sendEmail(
          hasAccount
            ? {
                kind: "already_registered",
                to: email,
                language: input.language,
                signInUrl: `${baseURL}/login`,
                resetUrl: `${baseURL}/reset`,
              }
            : {
                kind: "verify",
                to: email,
                language: input.language,
                verifyUrl: `${baseURL}/verify/${token}`,
                expiresInHours: SIGNUP_LINK_TTL_SECONDS / 3600,
              },
        );
      } catch (error) {
        logger.error("signup.email_failed", { ...errorLogFields(error) });
        return err({ code: "EMAIL_FAILED" });
      }
      logger.info("signup.email_sent", { kind: hasAccount ? "already_registered" : "verify" });
      return ok({ status: "email_sent" });
    },

    /** `/verify/<token>`: the pending sign-up, or `null` (malformed, expired or used link). */
    async pending(token: string): Promise<PendingSignupView | null> {
      const found = await loadPending(token);
      if (!found) return null;
      return {
        businessName: found.pending.businessName,
        email: found.pending.email,
        expiresAt: found.expiresAt,
      };
    },

    /**
     * The "Start" button on `/verify/<token>`: password check, then provisioning (idempotent on
     * the pending sign-up's operator id), then the pending sign-up is deleted.
     */
    async complete(input: {
      token: string;
      password: string;
      headers: Headers;
    }): Promise<Result<CompletedSignup, SignupFailure>> {
      if (!TOKEN.test(input.token)) return err({ code: "INVALID_LINK" });
      const ip = clientIp(input.headers);
      const byIp = await limited(
        rateLimitKey("signup-complete:ip", ip ?? "unknown"),
        SIGNUP_RATE_LIMITS.completePerIp,
      );
      if (byIp) return err(byIp);
      const byLink = await limited(
        rateLimitKey("signup-complete:link", input.token),
        SIGNUP_RATE_LIMITS.completePerLink,
      );
      if (byLink) return err(byLink);

      const found = await loadPending(input.token);
      if (!found) return err({ code: "INVALID_LINK" });
      const { pending } = found;
      if (
        input.password.length > PASSWORD_MAX_LENGTH ||
        !(await verifyPassword({ hash: pending.passwordHash, password: input.password }))
      ) {
        logger.info("signup.wrong_password");
        return err({ code: "WRONG_PASSWORD" });
      }

      const client = clientInfo(input.headers);
      const provisioned = await provisionTenant(runtime, {
        operatorId: pending.operatorId,
        business: { name: pending.businessName },
        owner: {
          name: pending.ownerName,
          email: pending.email,
          emailVerified: true,
          phone: pending.mobile,
          language: pending.language,
          passwordHash: pending.passwordHash,
        },
        trialDays: TRIAL_DAYS,
        actor: { kind: "self_signup" },
        request: {
          requestId: requestIdFromHeaders(input.headers),
          ...(client?.ip ? { ip: client.ip } : {}),
          ...(client?.userAgent ? { userAgent: client.userAgent } : {}),
        },
      });
      const removePending = () =>
        db.withPlatform((tx) => tx.delete(verifications).where(eq(verifications.id, found.id)));
      if (!provisioned.ok) {
        const reason = provisioned.error.details?.reason;
        if (reason === "email_taken") {
          await removePending();
          return err({ code: "ACCOUNT_EXISTS" });
        }
        // login_taken (ten candidates taken), operator_id_in_use or VALIDATION: not expected.
        throw new Error(
          `signup: provisioning refused (${String(reason ?? provisioned.error.code)})`,
        );
      }
      await removePending();
      const tenant = provisioned.value;
      return ok({
        operatorId: tenant.operatorId,
        ownerUserId: tenant.ownerUserId,
        email: pending.email,
        ownerLogin: tenant.ownerLogin,
        created: tenant.status === "created",
        trialLastDay: tenant.trialEndsAt ? trialLastDayOf(tenant.trialEndsAt) : null,
      });
    },
  };
}

/** The last free IST day for a stored `trial_ends_at` (the instant after it). */
function trialLastDayOf(trialEnd: Date): string {
  return trialLastDay(new Date(trialEnd.getTime() - 1), 0);
}

export type SignupService = ReturnType<typeof createSignupService>;

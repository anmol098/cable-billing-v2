/**
 * Platform admin enrolment by a one-time setup link (T-086d, PLAN §9.2).
 *
 * Only the person a platform admin account was made for can attach an authenticator to it:
 *
 * 1. **Issue** (`createPlatformAdmin`, `reissueAdminSetupLink`; run by the reviewed CLI
 *    `packages/core/scripts/create-platform-admin.ts`): the admin user is created **without a
 *    password** (or, for an existing admin who never turned on TOTP, their password, sessions and
 *    any half-made TOTP row are removed), and a single-use link `/admin-setup/<token>` is made. The
 *    token is 32 random bytes; only its SHA-256 is stored (like T-050's receipt links), in Better
 *    Auth's `verifications` table ("password-reset and similar one-time tokens", platform path
 *    only) under the `cb-admin-setup:` prefix. It expires after {@link ADMIN_SETUP_LINK_TTL_SECONDS}.
 *    A new link for the same admin removes the older ones.
 * 2. **Start** (`start`, a POST from the link page, so link scanners that only GET learn nothing):
 *    a fresh random TOTP secret is made, stored encrypted (Better Auth's `symmetricEncrypt`, the
 *    same as its own `two_factors.secret`) on the link row, replacing any earlier one, and shown.
 * 3. **Complete** (`complete`): the new password (twice in the UI) and a first code from the app.
 *    The code is checked against the stored secret, then in **one transaction** the link row is
 *    consumed (deleted, only if unexpired and still holding that same secret), the password is set,
 *    the `two_factors` row is written (`verified`, no backup codes: the backup-code endpoint is not
 *    reachable), `users.two_factor_enabled` is set and every session of the user is ended. Then the
 *    admin is signed in through the normal path (password → Better Auth's TOTP challenge → the
 *    same code), so the session carries T-086b's TOTP mark and passes every usual gate.
 *
 * Without a setup link a platform admin can't get TOTP: sign-in refuses an admin without it
 * (`SETUP_LINK_REQUIRED`, auth.ts), and the self-enrolment methods refuse platform admins.
 *
 * Wrong codes on the link page are not counted per user: the secret is only ever shown to whoever
 * holds the link, so guessing it gains nothing. The per-IP limit applies to start and complete.
 */
import { createHash, randomBytes } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import {
  accounts,
  type DbClient,
  sessions,
  twoFactors,
  users,
  uuidv7,
  verifications,
} from "@cb/db";
import { err, ok } from "@cb/domain";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt, like } from "drizzle-orm";
import { createLogger, errorLogFields, type Logger } from "../logging/logger";
import { type AuthAuditSubject, recordAuthEvent } from "./audit-events";
import { type AuthResult, type AuthService, TOTP_OPTIONS } from "./auth";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";
import { AUTH_RATE_LIMITS, type RateLimiter, rateLimitKey } from "./rate-limit";
import { clientIp } from "./request-info";

/** The setup page: `/admin-setup/<token>`. */
export const ADMIN_SETUP_PATH = "/admin-setup";
/** How long a setup link works (once): 1 hour, like a password-reset link. */
export const ADMIN_SETUP_LINK_TTL_SECONDS = 60 * 60;

/** `verifications.identifier` prefix of setup links (Better Auth's own identifiers are hashes). */
const IDENTIFIER_PREFIX = "cb-admin-setup:";
/** 32 random bytes, base64url without padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOTP_CODE = /^\d{6}$/;
const LOGIN = /^[^\s@A-Z]{3,100}$/;
const EMAIL = /^[^\s@A-Z]+@[^\s@A-Z]+\.[^\s@A-Z]+$/;

/** The setup page URL for a token. */
export function adminSetupUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${ADMIN_SETUP_PATH}/${token}`;
}

function identifierOf(token: string): string {
  return `${IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/** The link row's `value`: who it is for, and the pending TOTP secret (encrypted) once started. */
interface LinkValue {
  readonly userId: string;
  readonly secret: string | null;
}

/** Always `{"userId":"…","secret":…}` in this order, so a user's links can be found by prefix. */
function linkValue(value: LinkValue): string {
  return JSON.stringify({ userId: value.userId, secret: value.secret });
}

function userLinksPattern(userId: string): string {
  return `{"userId":"${userId}",%`;
}

function parseLinkValue(raw: string): LinkValue | null {
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; secret?: unknown };
    if (typeof parsed.userId !== "string") return null;
    const secret = typeof parsed.secret === "string" ? parsed.secret : null;
    return { userId: parsed.userId, secret };
  } catch {
    return null;
  }
}

/** Why issuing a link was refused (the CLI prints the code). */
export type AdminSetupIssueErrorCode =
  | "invalid_input"
  | "already_exists"
  | "not_found"
  | "not_a_platform_admin"
  | "disabled"
  | "already_enrolled";

export class AdminSetupIssueError extends Error {
  constructor(readonly code: AdminSetupIssueErrorCode) {
    super(`admin setup: ${code}`);
    this.name = "AdminSetupIssueError";
  }
}

export interface IssuedAdminSetupLink {
  readonly userId: string;
  /** The raw token: put it in the link, never store or log it. */
  readonly token: string;
  readonly expiresAt: Date;
}

interface IssueDeps {
  readonly db: DbClient;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

type PlatformTx = Parameters<Parameters<DbClient["withPlatform"]>[0]>[0];

async function insertLink(tx: PlatformTx, userId: string, at: Date): Promise<IssuedAdminSetupLink> {
  // Older links of this admin stop working.
  await tx
    .delete(verifications)
    .where(
      and(
        like(verifications.identifier, `${IDENTIFIER_PREFIX}%`),
        like(verifications.value, userLinksPattern(userId)),
      ),
    );
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(at.getTime() + ADMIN_SETUP_LINK_TTL_SECONDS * 1000);
  await tx.insert(verifications).values({
    id: uuidv7(),
    identifier: identifierOf(token),
    value: linkValue({ userId, secret: null }),
    expiresAt,
    createdAt: at,
    updatedAt: at,
  });
  return { userId, token, expiresAt };
}

/** Rolls the "Done" transaction back: the link's secret changed after the code was checked. */
class SecretReplaced extends Error {}

const adminSubject = (userId: string): AuthAuditSubject => ({
  userId,
  role: "platform_admin",
  operatorId: null,
});

/**
 * Creates a platform admin **without a password** and returns their one-time setup link token.
 * `email` and `login` are stored lower case; both must be unused.
 */
export async function createPlatformAdmin(
  deps: IssueDeps,
  input: { email: string; name: string; login: string; language: "en" | "hi" },
): Promise<IssuedAdminSetupLink> {
  const logger = deps.logger ?? createLogger();
  const at = (deps.now ?? (() => new Date()))();
  const email = input.email.trim().toLowerCase();
  const login = input.login.trim().toLowerCase();
  const name = input.name.trim();
  if (!EMAIL.test(email) || email.length > 254 || !LOGIN.test(login) || !name) {
    throw new AdminSetupIssueError("invalid_input");
  }
  const issued = await deps.db.withPlatform(async (tx) => {
    const taken = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .union(tx.select({ id: users.id }).from(users).where(eq(users.login, login)));
    if (taken.length > 0) throw new AdminSetupIssueError("already_exists");
    const userId = uuidv7();
    await tx.insert(users).values({
      id: userId,
      operatorId: null,
      role: "platform_admin",
      name,
      login,
      email,
      language: input.language,
    });
    return insertLink(tx, userId, at);
  });
  await recordAuthEvent(
    { db: deps.db, logger },
    {
      action: "auth.admin_setup_link_issued",
      subject: adminSubject(issued.userId),
      headers: new Headers(),
      after: { reissued: false },
    },
  );
  logger.info("auth.admin_setup_link_issued", { user_id: issued.userId, reissued: false });
  return issued;
}

/**
 * A new setup link for an existing platform admin who has **not** turned on TOTP (e.g. one made
 * before T-086d, or whose link ran out). Their password, sessions, any unfinished TOTP row and older
 * links are removed, so the link is the only way in. An admin with TOTP on is refused.
 */
export async function reissueAdminSetupLink(
  deps: IssueDeps,
  input: { email: string },
): Promise<IssuedAdminSetupLink> {
  const logger = deps.logger ?? createLogger();
  const at = (deps.now ?? (() => new Date()))();
  const email = input.email.trim().toLowerCase();
  const issued = await deps.db.withPlatform(async (tx) => {
    const [user] = await tx
      .select({
        id: users.id,
        role: users.role,
        status: users.status,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(users)
      .where(eq(users.email, email))
      .for("update");
    if (!user) throw new AdminSetupIssueError("not_found");
    if (user.role !== "platform_admin") throw new AdminSetupIssueError("not_a_platform_admin");
    if (user.status !== "active") throw new AdminSetupIssueError("disabled");
    if (user.twoFactorEnabled) throw new AdminSetupIssueError("already_enrolled");
    await tx
      .delete(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.delete(twoFactors).where(eq(twoFactors.userId, user.id));
    return insertLink(tx, user.id, at);
  });
  await recordAuthEvent(
    { db: deps.db, logger },
    {
      action: "auth.admin_setup_link_issued",
      subject: adminSubject(issued.userId),
      headers: new Headers(),
      after: { reissued: true },
    },
  );
  logger.info("auth.admin_setup_link_issued", { user_id: issued.userId, reissued: true });
  return issued;
}

export interface CreateAdminSetupServiceOptions {
  /** The auth service: its Better Auth instance signs the admin in once setup is done. */
  readonly auth: AuthService;
  readonly db: DbClient;
  readonly rateLimiter: RateLimiter;
  readonly logger?: Logger;
  /** Clock for link expiry. */
  readonly now?: () => Date;
}

/** What the setup page shows after "Start": the key to add to an authenticator app. */
export interface AdminSetupKey {
  readonly email: string;
  /** Base32, for typing into the app by hand. */
  readonly secret: string;
  /** `otpauth://totp/...`. */
  readonly totpUri: string;
}

/** The link's checks that hold before anything is changed. */
interface LiveLink {
  readonly identifier: string;
  readonly raw: string;
  readonly value: LinkValue;
  readonly email: string;
}

/** The web side of the setup link: the page's check, "Start" and "Done". */
export function createAdminSetupService(options: CreateAdminSetupServiceOptions) {
  const { auth: authService, db, rateLimiter } = options;
  const logger = options.logger ?? createLogger();
  const now = options.now ?? (() => new Date());
  const secretKey = async () => (await authService.auth.$context).secretConfig;

  /** The unexpired link for `token`, for an active platform admin who has no TOTP yet. */
  async function liveLink(token: string): Promise<LiveLink | null> {
    if (!TOKEN.test(token)) return null;
    const identifier = identifierOf(token);
    const rows = await db.withPlatform(
      (tx) =>
        tx
          .select({ value: verifications.value })
          .from(verifications)
          .where(and(eq(verifications.identifier, identifier), gt(verifications.expiresAt, now())))
          .limit(1),
      { accessMode: "read only" },
    );
    const raw = rows[0]?.value;
    const value = raw ? parseLinkValue(raw) : null;
    if (!raw || !value) return null;
    const [user] = await db.withPlatform(
      (tx) =>
        tx
          .select({
            role: users.role,
            status: users.status,
            email: users.email,
            twoFactorEnabled: users.twoFactorEnabled,
          })
          .from(users)
          .where(eq(users.id, value.userId)),
      { accessMode: "read only" },
    );
    if (
      user?.role !== "platform_admin" ||
      user.status !== "active" ||
      user.twoFactorEnabled ||
      !user.email
    ) {
      return null;
    }
    return { identifier, raw, value, email: user.email };
  }

  /** Counts one try per IP; fails open (logged) like the auth hooks. */
  async function limited(headers: Headers): Promise<AuthResult<void>> {
    const ip = clientIp(headers) ?? "unknown";
    try {
      const result = await rateLimiter.hit(
        rateLimitKey("admin-setup:ip", ip),
        AUTH_RATE_LIMITS.resetPerIp,
      );
      if (result.allowed) return ok(undefined);
      logger.warn("auth.rate_limited", { path: ADMIN_SETUP_PATH, scope: "admin-setup:ip" });
      return err({ code: "RATE_LIMITED", retryAfterSeconds: result.retryAfterSeconds });
    } catch (error) {
      logger.error("auth.rate_limit_unavailable", {
        limiter: rateLimiter.kind,
        path: ADMIN_SETUP_PATH,
        ...errorLogFields(error),
      });
      return ok(undefined);
    }
  }

  /**
   * After the transaction: the normal sign-in path with the new password, then Better Auth's TOTP
   * challenge with the same code. The browser's own cookies are left out (a session of somebody
   * else in this browser must not turn the TOTP step into an existing-session check). `false` when
   * it didn't work out (the admin then signs in by hand; the setup itself is done).
   */
  async function signInAfterSetup(
    email: string,
    password: string,
    code: string,
    headers: Headers,
  ): Promise<boolean> {
    const fresh = new Headers(headers);
    fresh.delete("cookie");
    try {
      const first = await authService.auth.api.signInEmail({
        body: { email, password, rememberMe: true },
        headers: fresh,
        returnHeaders: true,
      });
      const body = first.response as unknown as Record<string, unknown> | null;
      if (body?.twoFactorRedirect !== true) {
        throw new Error("admin setup sign-in: no TOTP challenge");
      }
      const cookie = first.headers
        .getSetCookie()
        .map((line) => line.split(";")[0]?.trim() ?? "")
        .filter((pair) => {
          const value = pair.slice(pair.indexOf("=") + 1);
          return pair.includes("=") && value !== "";
        })
        .join("; ");
      const challenge = new Headers(fresh);
      if (cookie) challenge.set("cookie", cookie);
      const verified = await authService.verifyTwoFactor({ code, headers: challenge });
      if (!verified.ok)
        logger.warn("auth.admin_setup_sign_in_failed", { code: verified.error.code });
      return verified.ok;
    } catch (error) {
      logger.error("auth.admin_setup_sign_in_failed", errorLogFields(error));
      return false;
    }
  }

  return {
    /** For the page: the email of the admin the link is for, or `null` (unknown, used, expired). */
    async inspect(token: string): Promise<{ readonly email: string } | null> {
      const link = await liveLink(token);
      return link ? { email: link.email } : null;
    },

    /**
     * "Start": a new TOTP secret for this link (replacing any earlier one), to add to the app.
     * INVALID_TOKEN when the link is unknown, used, expired, or its admin can't use it any more.
     */
    async start(input: { token: string; headers: Headers }): Promise<AuthResult<AdminSetupKey>> {
      if (!TOKEN.test(input.token)) return err({ code: "INVALID_TOKEN" });
      const allowed = await limited(input.headers);
      if (!allowed.ok) return allowed;
      const link = await liveLink(input.token);
      if (!link) return err({ code: "INVALID_TOKEN" });
      const secret = generateRandomString(32);
      const encrypted = await symmetricEncrypt({ key: await secretKey(), data: secret });
      const updated = await db.withPlatform((tx) =>
        tx
          .update(verifications)
          .set({
            value: linkValue({ userId: link.value.userId, secret: encrypted }),
            updatedAt: now(),
          })
          .where(
            and(eq(verifications.identifier, link.identifier), gt(verifications.expiresAt, now())),
          )
          .returning({ id: verifications.id }),
      );
      if (updated.length === 0) return err({ code: "INVALID_TOKEN" });
      const totpUri = createOTP(secret, {
        digits: TOTP_OPTIONS.digits,
        period: TOTP_OPTIONS.period,
      }).url(TOTP_OPTIONS.issuer, link.email);
      logger.info("auth.admin_setup_started", { user_id: link.value.userId });
      return ok({
        email: link.email,
        secret: new URL(totpUri).searchParams.get("secret") ?? "",
        totpUri,
      });
    },

    /**
     * "Done": sets the password and turns on TOTP with the first code, using up the link, then
     * signs the admin in (`signedIn: false` if that last step failed: setup is still done).
     * INVALID_CODE (wrong code, or "Start" not pressed / pressed again elsewhere), INVALID_PASSWORD,
     * INVALID_TOKEN (unknown, used, expired), RATE_LIMITED.
     */
    async complete(input: {
      token: string;
      password: string;
      code: string;
      headers: Headers;
    }): Promise<AuthResult<{ readonly userId: string; readonly signedIn: boolean }>> {
      if (!TOKEN.test(input.token)) return err({ code: "INVALID_TOKEN" });
      if (
        input.password.length < PASSWORD_MIN_LENGTH ||
        input.password.length > PASSWORD_MAX_LENGTH
      ) {
        return err({ code: "INVALID_PASSWORD" });
      }
      const code = input.code.replace(/\s+/g, "");
      if (!TOTP_CODE.test(code)) return err({ code: "INVALID_CODE" });
      const allowed = await limited(input.headers);
      if (!allowed.ok) return allowed;
      const link = await liveLink(input.token);
      if (!link) return err({ code: "INVALID_TOKEN" });
      if (!link.value.secret) return err({ code: "INVALID_CODE" });
      const key = await secretKey();
      const secret = await symmetricDecrypt({ key, data: link.value.secret });
      const right = await createOTP(secret, {
        digits: TOTP_OPTIONS.digits,
        period: TOTP_OPTIONS.period,
      }).verify(code);
      if (!right) {
        logger.info("auth.admin_setup_wrong_code", { user_id: link.value.userId });
        return err({ code: "INVALID_CODE" });
      }
      const passwordHash = await hashPassword(input.password);
      const noBackupCodes = await symmetricEncrypt({ key, data: JSON.stringify([]) });
      const userId = link.value.userId;
      const outcome = await db
        .withPlatform(async (tx) => {
          // Single use: only the first request deletes the row; an expired one is never used.
          const consumed = await tx
            .delete(verifications)
            .where(
              and(
                eq(verifications.identifier, link.identifier),
                gt(verifications.expiresAt, now()),
              ),
            )
            .returning({ value: verifications.value });
          if (consumed.length !== 1) return "used" as const;
          // "Start" pressed again elsewhere: the code was checked against an older secret.
          if (consumed[0]?.value !== link.raw) throw new SecretReplaced();
          const [user] = await tx
            .select({
              role: users.role,
              status: users.status,
              twoFactorEnabled: users.twoFactorEnabled,
            })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");
          if (
            user?.role !== "platform_admin" ||
            user.status !== "active" ||
            user.twoFactorEnabled
          ) {
            return "used" as const;
          }
          await tx
            .delete(accounts)
            .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
          await tx.insert(accounts).values({
            id: uuidv7(),
            userId,
            accountId: userId,
            providerId: "credential",
            password: passwordHash,
          });
          await tx.delete(twoFactors).where(eq(twoFactors.userId, userId));
          await tx.insert(twoFactors).values({
            id: uuidv7(),
            userId,
            secret: link.value.secret ?? "",
            backupCodes: noBackupCodes,
            verified: true,
            failedVerificationCount: 0,
            lockedUntil: null,
          });
          await tx
            .update(users)
            .set({ twoFactorEnabled: true, updatedAt: now() })
            .where(eq(users.id, userId));
          await tx.delete(sessions).where(eq(sessions.userId, userId));
          await tx
            .delete(verifications)
            .where(
              and(
                like(verifications.identifier, `${IDENTIFIER_PREFIX}%`),
                like(verifications.value, userLinksPattern(userId)),
              ),
            );
          return "done" as const;
        })
        .catch((error: unknown) => {
          // Thrown to undo the delete (the link stays usable); anything else is an outage.
          if (error instanceof SecretReplaced) return "restarted" as const;
          throw error;
        });
      if (outcome === "used") return err({ code: "INVALID_TOKEN" });
      if (outcome === "restarted") return err({ code: "INVALID_CODE" });
      await recordAuthEvent(
        { db, logger },
        {
          action: "auth.admin_setup_completed",
          subject: adminSubject(userId),
          headers: input.headers,
          after: { method: "totp" },
        },
      );
      logger.info("auth.admin_setup_completed", { user_id: userId });
      const signedIn = await signInAfterSetup(link.email, input.password, code, input.headers);
      return ok({ userId, signedIn });
    },
  };
}

export type AdminSetupService = ReturnType<typeof createAdminSetupService>;

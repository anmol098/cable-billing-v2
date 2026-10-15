/**
 * Platform admin enrolment by a one-time setup link (T-086d, PLAN §9.2).
 *
 * Only the person a platform admin account was made for can attach an authenticator to it:
 *
 * 1. **Issue** (`createPlatformAdmin`, `reissueAdminSetupLink`; run by the reviewed CLI
 *    `packages/core/scripts/create-platform-admin.ts`, `--by` an enrolled admin or `--bootstrap`
 *    for the very first one, recorded as the audit actor): the admin gets an **unusable** password
 *    (an argon2 hash of random bytes, so sign-in costs the same time as for anyone else), and their
 *    sessions and any half-made TOTP row are removed. A single-use link `/admin-setup#<token>` is
 *    made. The token is 32 random bytes in the URL **fragment**, which browsers never send, so it
 *    never reaches request logs. Only its SHA-256 is stored (like T-050's receipt links), in Better
 *    Auth's `verifications` table ("password-reset and similar one-time tokens", platform path
 *    only) under the `cb-admin-setup:` prefix. It expires after {@link ADMIN_SETUP_LINK_TTL_SECONDS}.
 *    A new link for the same admin removes the older ones.
 * 2. **Start** (`start`, a POST from the link page, so link scanners that only GET learn nothing):
 *    a fresh random TOTP secret is made, stored encrypted (Better Auth's `symmetricEncrypt`, the
 *    same as its own `two_factors.secret`) on the link row with a new key id, replacing any earlier
 *    one, and shown. "Done" sends the key id back, so "the key changed" is told apart from a wrong
 *    code.
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
import { and, eq, gt, like, sql } from "drizzle-orm";
import { createLogger, errorLogFields, type Logger } from "../logging/logger";
import { type AuthAuditSubject, recordAuthEvent } from "./audit-events";
import { type AuthResult, type AuthService, TOTP_OPTIONS } from "./auth";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";
import { AUTH_RATE_LIMITS, type RateLimiter, rateLimitKey } from "./rate-limit";
import { clientIp } from "./request-info";

/** The setup page: `/admin-setup#<token>` (the token is in the fragment, see {@link adminSetupUrl}). */
export const ADMIN_SETUP_PATH = "/admin-setup";
/** How long a setup link works (once): 1 hour, like a password-reset link. */
export const ADMIN_SETUP_LINK_TTL_SECONDS = 60 * 60;

/** `verifications.identifier` prefix of setup links (Better Auth's own identifiers are hashes). */
const IDENTIFIER_PREFIX = "cb-admin-setup:";
/** 32 random bytes, base64url without padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const TOTP_CODE = /^\d{6}$/;
const LOGIN = /^[^\s@A-Z]{3,100}$/;
const EMAIL = /^[^\s@A-Z]+@[^\s@A-Z]+\.[^\s@A-Z]+$/;

/**
 * The setup link for a token: `<app>/admin-setup#<token>`. The token is in the URL **fragment**,
 * which browsers never send to the server, so it can't end up in request logs, Vercel's logs or
 * Sentry's URLs; the page reads it in the browser and sends it in the body of its Server Actions.
 */
export function adminSetupUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${ADMIN_SETUP_PATH}#${token}`;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `baseUrl` can't be the origin of a setup link, or `null` when it can: an origin (no path,
 * query or fragment) on `https://`, or on `http://` only for localhost.
 */
export function adminSetupBaseUrlProblem(baseUrl: string | undefined): string | null {
  if (!baseUrl) return "missing";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "not a URL";
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    return "must be an origin only";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return null;
  return "must be https:// (http:// only for localhost)";
}

function identifierOf(token: string): string {
  return `${IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/**
 * The link row's `value`: who it is for, and once "Start" was pressed the pending TOTP secret
 * (encrypted) with a random id for that key (so "Done" can tell "the key changed" from "wrong code").
 */
interface LinkValue {
  readonly userId: string;
  readonly secret: string | null;
  readonly keyId: string | null;
}

/** Always `{"userId":"…",…}` first, so a user's links can be found by prefix. */
function linkValue(value: LinkValue): string {
  return JSON.stringify({ userId: value.userId, secret: value.secret, keyId: value.keyId });
}

function userLinksPattern(userId: string): string {
  return `{"userId":"${userId}",%`;
}

function parseLinkValue(raw: string): LinkValue | null {
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; secret?: unknown; keyId?: unknown };
    if (typeof parsed.userId !== "string") return null;
    const secret = typeof parsed.secret === "string" ? parsed.secret : null;
    const keyId = typeof parsed.keyId === "string" ? parsed.keyId : null;
    return { userId: parsed.userId, secret, keyId };
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
  | "already_enrolled"
  /** `--by` is not an active platform admin with 2-step sign-in on. */
  | "issuer_not_allowed"
  /** `--bootstrap` while an enrolled platform admin exists (they must issue it with `--by`). */
  | "bootstrap_not_allowed";

export class AdminSetupIssueError extends Error {
  constructor(readonly code: AdminSetupIssueErrorCode) {
    super(`admin setup: ${code}`);
    this.name = "AdminSetupIssueError";
  }
}

/**
 * Who is issuing the link (recorded as the audit event's actor, never the new admin):
 * - `admin`: an active platform admin with 2-step sign-in on (`--by <email>`);
 * - `bootstrap`: the very first admin, allowed only while no enrolled platform admin exists. The
 *   actor is then the system, and the OS user and host the command ran on are recorded.
 */
export type AdminSetupIssuer =
  | { readonly kind: "admin"; readonly email: string }
  | { readonly kind: "bootstrap"; readonly osUser: string; readonly host: string };

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

interface ResolvedIssuer {
  readonly actor: { readonly userId: string; readonly role: "platform_admin" } | null;
  readonly after: Readonly<Record<string, string>>;
}

/** Checks the issuer inside the issuing transaction (see {@link AdminSetupIssuer}). */
async function resolveIssuer(tx: PlatformTx, by: AdminSetupIssuer): Promise<ResolvedIssuer> {
  if (by.kind === "admin") {
    const [issuer] = await tx
      .select({
        id: users.id,
        role: users.role,
        status: users.status,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(users)
      .where(eq(users.email, by.email.trim().toLowerCase()));
    if (
      issuer?.role !== "platform_admin" ||
      issuer.status !== "active" ||
      !issuer.twoFactorEnabled
    ) {
      throw new AdminSetupIssueError("issuer_not_allowed");
    }
    return { actor: { userId: issuer.id, role: "platform_admin" }, after: { by: "admin" } };
  }
  // One bootstrap at a time; it stays allowed only until some admin has enrolled.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cb-admin-setup-bootstrap'))`);
  const enrolled = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "platform_admin"),
        eq(users.status, "active"),
        eq(users.twoFactorEnabled, true),
      ),
    )
    .limit(1);
  if (enrolled.length > 0) throw new AdminSetupIssueError("bootstrap_not_allowed");
  return {
    actor: null,
    after: {
      by: "bootstrap",
      os_user: by.osUser.slice(0, 64) || "unknown",
      os_host: by.host.slice(0, 128) || "unknown",
    },
  };
}

/**
 * An argon2id hash of 32 random bytes nobody knows, as the credential password of an admin who
 * hasn't set one yet: sign-in then hashes and fails like any wrong password (Better Auth answers a
 * user **without** a credential row without hashing, which would tell login names apart by time).
 * The setup link replaces it; nothing treats "has a credential row" as "has set a password".
 */
async function unusablePasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString("base64url"));
}

async function replaceCredential(tx: PlatformTx, userId: string, hash: string): Promise<void> {
  await tx
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
  await tx.insert(accounts).values({
    id: uuidv7(),
    userId,
    accountId: userId,
    providerId: "credential",
    password: hash,
  });
}

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
    value: linkValue({ userId, secret: null, keyId: null }),
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

async function auditIssued(
  deps: IssueDeps,
  logger: Logger,
  userId: string,
  issuer: ResolvedIssuer,
  reissued: boolean,
): Promise<void> {
  await recordAuthEvent(
    { db: deps.db, logger },
    {
      action: "auth.admin_setup_link_issued",
      subject: adminSubject(userId),
      actor: issuer.actor,
      headers: new Headers(),
      after: { reissued, ...issuer.after },
    },
  );
  logger.info("auth.admin_setup_link_issued", {
    user_id: userId,
    issued_by: issuer.actor?.userId ?? "bootstrap",
    reissued,
  });
}

/**
 * Creates a platform admin **without a usable password** and returns their one-time setup link
 * token. `email` and `login` are stored lower case; both must be unused. `by` is checked and
 * recorded as the actor (see {@link AdminSetupIssuer}).
 */
export async function createPlatformAdmin(
  deps: IssueDeps,
  input: {
    email: string;
    name: string;
    login: string;
    language: "en" | "hi";
    by: AdminSetupIssuer;
  },
): Promise<IssuedAdminSetupLink> {
  const logger = deps.logger ?? createLogger();
  const at = (deps.now ?? (() => new Date()))();
  const email = input.email.trim().toLowerCase();
  const login = input.login.trim().toLowerCase();
  const name = input.name.trim();
  if (!EMAIL.test(email) || email.length > 254 || !LOGIN.test(login) || !name) {
    throw new AdminSetupIssueError("invalid_input");
  }
  const unusable = await unusablePasswordHash();
  const { issued, issuer } = await deps.db.withPlatform(async (tx) => {
    const issuer = await resolveIssuer(tx, input.by);
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
    await replaceCredential(tx, userId, unusable);
    return { issued: await insertLink(tx, userId, at), issuer };
  });
  await auditIssued(deps, logger, issued.userId, issuer, false);
  return issued;
}

/**
 * A new setup link for an existing platform admin who has **not** turned on TOTP (e.g. one made
 * before T-086d, or whose link ran out). Their password is replaced by an unusable one, and their
 * sessions, any unfinished TOTP row and older links are removed, so the link is the only way in.
 * An admin with TOTP on is refused.
 */
export async function reissueAdminSetupLink(
  deps: IssueDeps,
  input: { email: string; by: AdminSetupIssuer },
): Promise<IssuedAdminSetupLink> {
  const logger = deps.logger ?? createLogger();
  const at = (deps.now ?? (() => new Date()))();
  const email = input.email.trim().toLowerCase();
  const unusable = await unusablePasswordHash();
  const { issued, issuer } = await deps.db.withPlatform(async (tx) => {
    const issuer = await resolveIssuer(tx, input.by);
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
    await replaceCredential(tx, user.id, unusable);
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.delete(twoFactors).where(eq(twoFactors.userId, user.id));
    return { issued: await insertLink(tx, user.id, at), issuer };
  });
  await auditIssued(deps, logger, issued.userId, issuer, true);
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
  /** Which key this is: "Done" sends it back, so a key replaced elsewhere is told apart. */
  readonly keyId: string;
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
      const keyId = randomBytes(8).toString("hex");
      const updated = await db.withPlatform((tx) =>
        tx
          .update(verifications)
          .set({
            value: linkValue({ userId: link.value.userId, secret: encrypted, keyId }),
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
        keyId,
      });
    },

    /**
     * "Done": sets the password and turns on TOTP with the first code, using up the link, then
     * signs the admin in (`signedIn: false` if that last step failed: setup is still done).
     * INVALID_CODE (wrong code), SETUP_KEY_CHANGED (`keyId` is not the link's current key: "Start"
     * was pressed again elsewhere, or never), INVALID_PASSWORD, INVALID_TOKEN (unknown, used,
     * expired), RATE_LIMITED.
     */
    async complete(input: {
      token: string;
      /** The `keyId` "Start" returned with the key the code comes from. */
      keyId: string;
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
      if (!link.value.secret || !KEY_ID.test(input.keyId) || link.value.keyId !== input.keyId) {
        return err({ code: "SETUP_KEY_CHANGED" });
      }
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
      if (outcome === "restarted") return err({ code: "SETUP_KEY_CHANGED" });
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

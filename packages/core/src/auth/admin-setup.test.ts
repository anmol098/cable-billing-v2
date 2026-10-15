/**
 * T-086d against a real database and real Better Auth:
 * - a platform admin gets TOTP only through their own one-time setup link (single use, expires,
 *   stored hashed); a password alone never gets an admin in or lets anyone enrol;
 * - every wrong 2FA code counts toward the per-user lockout, including Better Auth's
 *   existing-session branch (enrolment, or a code typed in a browser that is already signed in).
 */
import { createHash, createHmac } from "node:crypto";
import { uuidv7 } from "@cb/db";
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAdminContext } from "../admin/context";
import { newRequestId } from "../context/runtime";
import { captureLogs, seedTenant } from "../testing";
import {
  ADMIN_SETUP_LINK_TTL_SECONDS,
  AdminSetupIssueError,
  type AdminSetupIssuer,
  type AdminSetupService,
  adminSetupBaseUrlProblem,
  adminSetupUrl,
  createAdminSetupService,
  createPlatformAdmin,
  reissueAdminSetupLink,
} from "./admin-setup";
import { type AuthService, createAuthService, TWO_FACTOR_LOCKOUT } from "./auth";
import { hashPassword } from "./password";
import { createMemoryRateLimiter } from "./rate-limit";

const PASSWORD = "admin setup password 42";
const SECRET = "t086d-test-secret-not-for-production-0123456789abcdef";
const BASE_URL = "http://localhost:3000";
const SESSION_COOKIE = "cb.session_token";

class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly ip: string) {}
  headers(): Headers {
    const headers = new Headers({ "x-real-ip": this.ip, "user-agent": "vitest-browser/1.0" });
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    return headers;
  }
  apply(setCookie: string): void {
    const [pair] = setCookie.split(";");
    const index = pair?.indexOf("=") ?? -1;
    if (!pair || index < 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (/max-age=0(;|$)/i.test(setCookie) || value === "") this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

/** Plays Next's `nextCookies()`: Set-Cookie goes to the browser whose IP made the call. */
function cookieJarPlugin(browsers: () => Iterable<Browser>): BetterAuthPlugin {
  return {
    id: "test-cookie-jar",
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const setCookies = ctx.context.responseHeaders?.getSetCookie() ?? [];
            const ip = ctx.headers?.get("x-real-ip");
            const browser = [...browsers()].find((b) => b.ip === ip);
            for (const cookie of setCookies) browser?.apply(cookie);
          }),
        },
      ],
    },
  };
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret. */
function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A 6-digit code that is surely wrong now (5 minutes ahead, outside the ±30 s window). */
const wrongCode = (secret: string) => totp(secret, Date.now() + 5 * 60_000);

describe("adminSetupBaseUrlProblem (the CLI's base URL rule)", () => {
  it("wants an https origin; http only for localhost", () => {
    for (const ok of [
      "https://app.example.com",
      "https://app.example.com/",
      "http://localhost:3000",
      "http://127.0.0.1:3100",
    ]) {
      expect(adminSetupBaseUrlProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      undefined,
      "",
      "app.example.com",
      "http://app.example.com",
      "http://localhost.evil.test",
      "https://app.example.com/path",
      "https://app.example.com/?x=1",
      "ftp://app.example.com",
    ]) {
      expect(adminSetupBaseUrlProblem(bad), String(bad)).not.toBeNull();
    }
  });
});

describeDb("platform admin setup link and 2FA lockout (T-086d)", () => {
  const t = useTestDatabase();
  const logs = captureLogs();
  const browsers = new Set<Browser>();
  let ipCounter = 0;
  let clock = () => new Date();
  let auth: AuthService;
  let setup: AdminSetupService;
  let runSeq = 0;
  /** The first admin, made with `--bootstrap` and enrolled; issues every other link here. */
  const ROOT_EMAIL = "root-admin@platform.test";
  let rootId = "";
  const byRoot = () => ({ kind: "admin" as const, email: ROOT_EMAIL });

  const newBrowser = () => {
    ipCounter += 1;
    const browser = new Browser(`192.0.2.${ipCounter}`);
    browsers.add(browser);
    return browser;
  };
  const issueDeps = () => ({ db: t.current.db, logger: logs.logger, now: () => clock() });
  const newAdmin = (name = "Asha Admin") => {
    runSeq += 1;
    const login = `adm${runSeq}-${uuidv7().slice(-8)}`;
    return createPlatformAdmin(issueDeps(), {
      email: `${login}@platform.test`,
      name,
      login,
      language: "en",
      by: byRoot(),
    });
  };
  const query = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    t.current.admin.query<T>(sql, params).then((r) => r.rows);
  const emailOf = async (userId: string) =>
    (await query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]))[0]?.email ??
    "";
  const auditActions = async (userId: string) =>
    (
      await query<{ action: string; operator_id: string | null; after: unknown }>(
        "SELECT action, operator_id, after FROM audit_events WHERE actor_id = $1 ORDER BY at, id",
        [userId],
      )
    ).map((r) => r.action);
  /** `auth.admin_setup_link_issued` events about `userId` (whoever issued them). */
  const issuedEvents = (userId: string) =>
    query<{
      actor_id: string | null;
      actor_role: string | null;
      operator_id: string | null;
      after: unknown;
    }>(
      `SELECT actor_id, actor_role, operator_id, after FROM audit_events
       WHERE action = 'auth.admin_setup_link_issued' AND entity_id = $1 ORDER BY at, id`,
      [userId],
    );
  const twoFactorRow = async (userId: string) =>
    (
      await query<{ failed: number; locked_until: Date | null; verified: boolean }>(
        "SELECT failed_verification_count AS failed, locked_until, verified FROM two_factors WHERE user_id = $1",
        [userId],
      )
    )[0];
  const adminContext = (userId: string, sessionId: string) =>
    resolveAdminContext({ db: t.current.db }, { userId, sessionId, requestId: newRequestId() });

  /** Opens the link in `browser`, presses Start, then Done with the right code. */
  async function enrolWithLink(token: string, browser = newBrowser()) {
    const started = await setup.start({ token, headers: browser.headers() });
    if (!started.ok) throw new Error(`start: ${started.error.code}`);
    const done = await setup.complete({
      token,
      keyId: started.value.keyId,
      password: PASSWORD,
      code: totp(started.value.secret),
      headers: browser.headers(),
    });
    if (!done.ok) throw new Error(`complete: ${done.error.code}`);
    return { browser, secret: started.value.secret, signedIn: done.value.signedIn };
  }

  beforeAll(async () => {
    auth = createAuthService({
      db: t.current.db,
      secret: SECRET,
      baseURL: BASE_URL,
      rateLimiter: createMemoryRateLimiter(),
      sendPasswordResetEmail: async () => {},
      logger: logs.logger,
      now: () => clock(),
      plugins: [cookieJarPlugin(() => browsers)],
    });
    setup = createAdminSetupService({
      auth,
      db: t.current.db,
      rateLimiter: createMemoryRateLimiter(),
      logger: logs.logger,
      now: () => clock(),
    });
    // The very first admin: no enrolled admin exists yet, so --bootstrap is allowed.
    const root = await createPlatformAdmin(issueDeps(), {
      email: ROOT_EMAIL,
      name: "Root Admin",
      login: "root-admin",
      language: "en",
      by: { kind: "bootstrap", osUser: "tester", host: "ci-host" },
    });
    rootId = root.userId;
    await enrolWithLink(root.token);
  });

  beforeEach(() => {
    clock = () => new Date();
  });

  describe("the setup link", () => {
    it("creates an admin with an unusable password; the link sets it, turns on TOTP and signs in, once", async () => {
      const issued = await newAdmin();
      const email = await emailOf(issued.userId);
      expect(adminSetupUrl(`${BASE_URL}/`, issued.token)).toBe(
        `${BASE_URL}/admin-setup#${issued.token}`,
      );
      // An unusable password (argon2id of random bytes), no TOTP; the token itself is stored
      // nowhere, only its SHA-256.
      const credential = await query<{ password: string }>(
        "SELECT password FROM accounts WHERE user_id = $1 AND provider_id = 'credential'",
        [issued.userId],
      );
      expect(credential).toHaveLength(1);
      expect(credential[0]?.password).toMatch(/^\$argon2id\$/);
      const stored = await query<{ identifier: string; value: string; expires_at: Date }>(
        "SELECT identifier, value, expires_at FROM verifications WHERE value LIKE $1",
        [`{"userId":"${issued.userId}",%`],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.identifier).toBe(
        `cb-admin-setup:${createHash("sha256").update(issued.token).digest("base64url")}`,
      );
      const everything = JSON.stringify(await query("SELECT identifier, value FROM verifications"));
      expect(everything).not.toContain(issued.token);
      expect((stored[0]?.expires_at.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(
        ADMIN_SETUP_LINK_TTL_SECONDS * 1000,
      );

      // Nobody can sign in with any password before the link is used, and the answer costs a
      // password check like any wrong password (no early "no credential" answer by login name).
      const early = newBrowser();
      const login = (
        await query<{ login: string }>("SELECT login FROM users WHERE id = $1", [issued.userId])
      )[0]?.login;
      for (const typed of [email, login ?? ""]) {
        const before = logs.records.length;
        expect(
          await auth.signIn({ login: typed, password: PASSWORD, headers: early.headers() }),
        ).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
        expect(logs.records.slice(before)).toContainEqual(
          expect.objectContaining({ event: "auth.library_warning", message: "Invalid password" }),
        );
      }

      // The page knows whom the link is for.
      expect(await setup.inspect(issued.token)).toEqual({ email });

      const browser = newBrowser();
      // "Done" before "Start": no key was shown yet ("press Start").
      expect(
        await setup.complete({
          keyId: "0000000000000000",
          token: issued.token,
          password: PASSWORD,
          code: "123456",
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "SETUP_KEY_CHANGED" } });
      const started = await setup.start({ token: issued.token, headers: browser.headers() });
      if (!started.ok) throw new Error(started.error.code);
      expect(started.value.email).toBe(email);
      expect(started.value.secret).toMatch(/^[A-Z2-7]+$/);
      expect(started.value.totpUri).toMatch(/^otpauth:\/\/totp\/Cable%20Billing:/);
      expect(started.value.keyId).toMatch(/^[0-9a-f]{16}$/);
      // The pending secret is stored encrypted, never as shown.
      const pending = await query<{ value: string }>(
        "SELECT value FROM verifications WHERE identifier = $1",
        [stored[0]?.identifier],
      );
      expect(pending[0]?.value).not.toContain(started.value.secret);

      // Wrong code, short password: refused, the link still works.
      expect(
        await setup.complete({
          keyId: started.value.keyId,
          token: issued.token,
          password: PASSWORD,
          code: wrongCode(started.value.secret),
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_CODE" } });
      expect(
        await setup.complete({
          keyId: started.value.keyId,
          token: issued.token,
          password: "short",
          code: totp(started.value.secret),
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_PASSWORD" } });
      expect(await setup.inspect(issued.token)).toEqual({ email });

      const done = await setup.complete({
        keyId: started.value.keyId,
        token: issued.token,
        password: PASSWORD,
        code: totp(started.value.secret),
        headers: browser.headers(),
      });
      expect(done).toEqual({ ok: true, value: { userId: issued.userId, signedIn: true } });

      // Signed in with a TOTP-verified session that the admin gate accepts.
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);
      const session = await auth.getSession(browser.headers());
      expect(session).toMatchObject({
        userId: issued.userId,
        role: "platform_admin",
        twoFactorEnabled: true,
        twoFactorVerified: true,
        twoFactorEnrolmentRequired: false,
      });
      expect((await adminContext(issued.userId, session?.sessionId ?? "")).ok).toBe(true);
      expect(await twoFactorRow(issued.userId)).toMatchObject({ verified: true, failed: 0 });

      // Single use: the link is gone, whatever is tried with it.
      expect(
        await query("SELECT 1 FROM verifications WHERE value LIKE $1", [
          `{"userId":"${issued.userId}",%`,
        ]),
      ).toHaveLength(0);
      const other = newBrowser();
      expect(await setup.inspect(issued.token)).toBeNull();
      expect(await setup.start({ token: issued.token, headers: other.headers() })).toEqual({
        ok: false,
        error: { code: "INVALID_TOKEN" },
      });
      expect(
        await setup.complete({
          keyId: started.value.keyId,
          token: issued.token,
          password: "another password 1",
          code: totp(started.value.secret),
          headers: other.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });

      // From now on: password, then the code (the same authenticator), like every admin.
      const later = newBrowser();
      expect(
        await auth.signIn({ login: email, password: PASSWORD, headers: later.headers() }),
      ).toEqual({ ok: true, value: { status: "two_factor_required" } });
      expect(
        (await auth.verifyTwoFactor({ code: totp(started.value.secret), headers: later.headers() }))
          .ok,
      ).toBe(true);

      expect(await auditActions(issued.userId)).toEqual([
        "auth.admin_setup_completed",
        "auth.signed_in",
        "auth.signed_in",
      ]);
      const events = await query<{ operator_id: string | null; after: unknown }>(
        "SELECT operator_id, after FROM audit_events WHERE actor_id = $1 ORDER BY at, id",
        [issued.userId],
      );
      expect(events.map((e) => e.operator_id)).toEqual([null, null, null]);
      expect(events[1]?.after).toEqual({ method: "password_totp" });
      // The link was issued by the root admin (the actor), about this admin (the entity).
      expect(await issuedEvents(issued.userId)).toEqual([
        {
          actor_id: rootId,
          actor_role: "platform_admin",
          operator_id: null,
          after: { reissued: false, by: "admin" },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(email);
      // The link and the password never reach the logs.
      const logged = JSON.stringify(logs.records);
      expect(logged).not.toContain(issued.token);
      expect(logged).not.toContain(PASSWORD);
    });

    it("refuses an expired link, a made-up one and a malformed one", async () => {
      const issued = await newAdmin();
      const browser = newBrowser();
      const started = await setup.start({ token: issued.token, headers: browser.headers() });
      if (!started.ok) throw new Error(started.error.code);

      clock = () => new Date(Date.now() + ADMIN_SETUP_LINK_TTL_SECONDS * 1000 + 1000);
      expect(await setup.inspect(issued.token)).toBeNull();
      expect(await setup.start({ token: issued.token, headers: browser.headers() })).toEqual({
        ok: false,
        error: { code: "INVALID_TOKEN" },
      });
      expect(
        await setup.complete({
          keyId: started.value.keyId,
          token: issued.token,
          password: PASSWORD,
          code: totp(started.value.secret),
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
      expect(await twoFactorRow(issued.userId)).toBeUndefined();
      clock = () => new Date();

      const madeUp = Buffer.alloc(32, 7).toString("base64url");
      for (const token of [madeUp, "not-a-token", `${issued.token}x`, ""]) {
        expect(await setup.inspect(token)).toBeNull();
        expect(await setup.start({ token, headers: browser.headers() })).toEqual({
          ok: false,
          error: { code: "INVALID_TOKEN" },
        });
        expect(
          await setup.complete({
            token,
            keyId: "0000000000000000",
            password: PASSWORD,
            code: "123456",
            headers: browser.headers(),
          }),
        ).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
      }
    });

    it("pressing Start again replaces the key: Done with the old key says the key changed", async () => {
      const issued = await newAdmin();
      const first = newBrowser();
      const second = newBrowser();
      const old = await setup.start({ token: issued.token, headers: first.headers() });
      const fresh = await setup.start({ token: issued.token, headers: second.headers() });
      if (!old.ok || !fresh.ok) throw new Error("start failed");
      expect(fresh.value.secret).not.toBe(old.value.secret);
      expect(
        await setup.complete({
          keyId: old.value.keyId,
          token: issued.token,
          password: PASSWORD,
          code: totp(old.value.secret),
          headers: first.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "SETUP_KEY_CHANGED" } });
      // Even the new key's code is refused with the old key id: the page must Start again.
      expect(
        await setup.complete({
          keyId: old.value.keyId,
          token: issued.token,
          password: PASSWORD,
          code: totp(fresh.value.secret),
          headers: first.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "SETUP_KEY_CHANGED" } });
      const done = await setup.complete({
        keyId: fresh.value.keyId,
        token: issued.token,
        password: PASSWORD,
        code: totp(fresh.value.secret),
        headers: second.headers(),
      });
      expect(done.ok).toBe(true);
    });

    it("two Done requests at once: exactly one wins", async () => {
      const issued = await newAdmin();
      const a = newBrowser();
      const b = newBrowser();
      const started = await setup.start({ token: issued.token, headers: a.headers() });
      if (!started.ok) throw new Error(started.error.code);
      const code = totp(started.value.secret);
      const results = await Promise.all(
        [a, b].map((browser) =>
          setup.complete({
            keyId: started.value.keyId,
            token: issued.token,
            password: PASSWORD,
            code,
            headers: browser.headers(),
          }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, error: { code: "INVALID_TOKEN" } },
      ]);
      expect(
        await query("SELECT 1 FROM two_factors WHERE user_id = $1", [issued.userId]),
      ).toHaveLength(1);
      expect(
        await query("SELECT 1 FROM accounts WHERE user_id = $1", [issued.userId]),
      ).toHaveLength(1);
    }, 60_000);

    it("an admin without TOTP is refused at sign-in with the right password, and moved to a link", async () => {
      // An admin made before T-086d: a password, no TOTP.
      const legacy = await createUser(t.current, { operatorId: null });
      await t.current.admin.query(
        `INSERT INTO accounts (id, user_id, account_id, provider_id, password)
         VALUES ($1, $2::uuid, $2::text, 'credential', $3)`,
        [uuidv7(), legacy.userId, await hashPassword(PASSWORD)],
      );
      const email = await emailOf(legacy.userId);
      const browser = newBrowser();
      for (const login of [email, legacy.login]) {
        expect(
          await auth.signIn({ login, password: PASSWORD, headers: browser.headers() }),
        ).toEqual({
          ok: false,
          error: { code: "SETUP_LINK_REQUIRED" },
        });
      }
      // A wrong password still gets the ordinary answer (nothing about the account is told).
      expect(
        await auth.signIn({
          login: email,
          password: "wrong password!",
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(
        await query("SELECT 1 FROM sessions WHERE user_id = $1", [legacy.userId]),
      ).toHaveLength(0);
      const blocked = await query<{ action: string; after: unknown }>(
        "SELECT action, after FROM audit_events WHERE actor_id = $1 ORDER BY at, id",
        [legacy.userId],
      );
      expect(blocked).toEqual([
        { action: "auth.sign_in_blocked", after: { reason: "admin_setup_required" } },
        { action: "auth.sign_in_blocked", after: { reason: "admin_setup_required" } },
      ]);

      // A session row it may still hold from before T-086d (getSession would end it on its next
      // request, see below); the reissue removes it at once.
      await t.current.admin.query(
        "INSERT INTO sessions (id, user_id, token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')",
        [uuidv7(), legacy.userId, `legacy-${uuidv7()}`],
      );

      // The coordinator's one-off step: a new link. The old password and session stop working.
      const first = await reissueAdminSetupLink(issueDeps(), {
        email: email.toUpperCase(),
        by: byRoot(),
      });
      const issued = await reissueAdminSetupLink(issueDeps(), { email, by: byRoot() });
      // The old password is replaced by an unusable one (a credential row stays, so sign-in still
      // costs a password check).
      const credential = await query<{ password: string }>(
        "SELECT password FROM accounts WHERE user_id = $1",
        [legacy.userId],
      );
      expect(credential).toHaveLength(1);
      expect(credential[0]?.password).toMatch(/^\$argon2id\$/);
      expect(
        await query("SELECT 1 FROM sessions WHERE user_id = $1", [legacy.userId]),
      ).toHaveLength(0);
      expect(await setup.inspect(first.token)).toBeNull(); // the older link stopped working
      expect(
        await auth.signIn({ login: email, password: PASSWORD, headers: browser.headers() }),
      ).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      const { signedIn } = await enrolWithLink(issued.token);
      expect(signedIn).toBe(true);
      expect((await auditActions(legacy.userId)).slice(-2)).toEqual([
        "auth.admin_setup_completed",
        "auth.signed_in",
      ]);
      expect(await issuedEvents(legacy.userId)).toEqual([
        {
          actor_id: rootId,
          actor_role: "platform_admin",
          operator_id: null,
          after: { reissued: true, by: "admin" },
        },
        {
          actor_id: rootId,
          actor_role: "platform_admin",
          operator_id: null,
          after: { reissued: true, by: "admin" },
        },
      ]);

      // Who can't get a link: an admin who has TOTP, a tenant user, an unknown address; and an
      // address or login that is taken can't be a new admin.
      const tenant = await seedTenant(t.current);
      const ownerEmail = `owner-${uuidv7().slice(-8)}@cable.test`;
      await t.current.admin.query("UPDATE users SET email = $1 WHERE id = $2", [
        ownerEmail,
        tenant.users.owner,
      ]);
      const refusals: Array<[string, () => Promise<unknown>]> = [
        ["already_enrolled", () => reissueAdminSetupLink(issueDeps(), { email, by: byRoot() })],
        [
          "not_a_platform_admin",
          () => reissueAdminSetupLink(issueDeps(), { email: ownerEmail, by: byRoot() }),
        ],
        [
          "not_found",
          () => reissueAdminSetupLink(issueDeps(), { email: "nobody@nowhere.test", by: byRoot() }),
        ],
        [
          "already_exists",
          () =>
            createPlatformAdmin(issueDeps(), {
              email,
              name: "Dup",
              login: "dup-admin",
              language: "en",
              by: byRoot(),
            }),
        ],
        [
          "invalid_input",
          () =>
            createPlatformAdmin(issueDeps(), {
              email: "not an email",
              name: "X",
              login: "x-admin",
              language: "en",
              by: byRoot(),
            }),
        ],
      ];
      for (const [code, attempt] of refusals) {
        const error = await attempt().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, code).toBeInstanceOf(AdminSetupIssueError);
        expect(error, code).toMatchObject({ code });
      }
    }, 60_000);

    it("records who issued a link; only an enrolled admin can, or --bootstrap before any exists", async () => {
      // The root admin was bootstrapped: the actor is the system, with where the command ran.
      expect(await issuedEvents(rootId)).toEqual([
        {
          actor_id: null,
          actor_role: null,
          operator_id: null,
          after: { reissued: false, by: "bootstrap", os_user: "tester", os_host: "ci-host" },
        },
      ]);
      // Now that an admin has enrolled, --bootstrap is refused; so is any issuer who isn't an
      // active platform admin with 2-step sign-in on.
      const pending = await newAdmin(); // has no TOTP yet
      const pendingEmail = await emailOf(pending.userId);
      const tenant = await seedTenant(t.current);
      const ownerEmail = `owner-${uuidv7().slice(-8)}@cable.test`;
      await t.current.admin.query("UPDATE users SET email = $1 WHERE id = $2", [
        ownerEmail,
        tenant.users.owner,
      ]);
      const disabled = await newAdmin();
      await enrolWithLink(disabled.token);
      const disabledEmail = await emailOf(disabled.userId);
      await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
        disabled.userId,
      ]);
      const newcomer = (by: AdminSetupIssuer) => () =>
        createPlatformAdmin(issueDeps(), {
          email: `new-${uuidv7().slice(-8)}@platform.test`,
          name: "New Admin",
          login: `new-${uuidv7().slice(-8)}`,
          language: "en",
          by,
        });
      const refusals: Array<[string, () => Promise<unknown>]> = [
        ["bootstrap_not_allowed", newcomer({ kind: "bootstrap", osUser: "x", host: "y" })],
        ["issuer_not_allowed", newcomer({ kind: "admin", email: pendingEmail })],
        ["issuer_not_allowed", newcomer({ kind: "admin", email: ownerEmail })],
        ["issuer_not_allowed", newcomer({ kind: "admin", email: disabledEmail })],
        ["issuer_not_allowed", newcomer({ kind: "admin", email: "nobody@nowhere.test" })],
        [
          "bootstrap_not_allowed",
          () =>
            reissueAdminSetupLink(issueDeps(), {
              email: pendingEmail,
              by: { kind: "bootstrap", osUser: "x", host: "y" },
            }),
        ],
        [
          "issuer_not_allowed",
          () =>
            reissueAdminSetupLink(issueDeps(), {
              email: pendingEmail,
              by: { kind: "admin", email: pendingEmail },
            }),
        ],
      ];
      for (const [code, attempt] of refusals) {
        const error = await attempt().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, code).toBeInstanceOf(AdminSetupIssueError);
        expect(error, code).toMatchObject({ code });
      }
      // Refused issues change nothing: no new user, no new link for the pending admin.
      expect(await issuedEvents(pending.userId)).toHaveLength(1);
      expect(await query("SELECT 1 FROM users WHERE name = 'New Admin'")).toHaveLength(0);
    }, 60_000);

    it("a legacy admin session without TOTP is ended; admins can never self-enrol", async () => {
      const issued = await newAdmin();
      const { browser } = await enrolWithLink(issued.token);
      // Enrolled admin: the self-enrolment methods refuse, whatever is typed.
      expect(
        await auth.startTwoFactorEnrolment({ password: PASSWORD, headers: browser.headers() }),
      ).toEqual({ ok: false, error: { code: "SETUP_LINK_REQUIRED" } });
      expect(
        await auth.confirmTwoFactorEnrolment({ code: "123456", headers: browser.headers() }),
      ).toEqual({ ok: false, error: { code: "SETUP_LINK_REQUIRED" } });
      expect(
        await query("SELECT verified FROM two_factors WHERE user_id = $1", [issued.userId]),
      ).toEqual([{ verified: true }]);

      // If TOTP were ever off for an admin (data fixed by hand), their session would be ended.
      await t.current.admin.query("UPDATE users SET two_factor_enabled = false WHERE id = $1", [
        issued.userId,
      ]);
      expect(await auth.getSession(browser.headers())).toBeNull();
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          event: "auth.session_revoked",
          user_id: issued.userId,
          reason: "admin_setup_required",
        }),
      );
    });
  });

  describe("every wrong code counts toward the per-user lockout", () => {
    it("10 wrong codes typed in a signed-in browser lock the account, for every way in", async () => {
      const issued = await newAdmin();
      const { browser, secret } = await enrolWithLink(issued.token);
      const email = await emailOf(issued.userId);
      // A code typed in a browser that is already signed in: Better Auth's existing-session
      // branch (it creates no session; our service answers TWO_FACTOR_EXPIRED for a right code).
      for (let i = 1; i <= TWO_FACTOR_LOCKOUT.maxFailedAttempts; i += 1) {
        expect(
          await auth.verifyTwoFactor({ code: wrongCode(secret), headers: browser.headers() }),
        ).toEqual({ ok: false, error: { code: "INVALID_CODE" } });
        expect((await twoFactorRow(issued.userId))?.failed).toBe(i);
      }
      const row = await twoFactorRow(issued.userId);
      expect(row?.locked_until?.getTime() ?? 0).toBeGreaterThan(
        Date.now() + (TWO_FACTOR_LOCKOUT.durationSeconds - 60) * 1000,
      );
      // Locked: even the right code is refused, here and at a fresh sign-in elsewhere.
      const here = await auth.verifyTwoFactor({ code: totp(secret), headers: browser.headers() });
      expect(here).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
      if (!here.ok) expect(here.error.retryAfterSeconds).toBeGreaterThan(60);
      const elsewhere = newBrowser();
      expect(
        await auth.signIn({ login: email, password: PASSWORD, headers: elsewhere.headers() }),
      ).toEqual({ ok: true, value: { status: "two_factor_required" } });
      expect(
        await auth.verifyTwoFactor({ code: totp(secret), headers: elsewhere.headers() }),
      ).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
      expect(elsewhere.cookies.has(SESSION_COOKIE)).toBe(false);
      expect((await twoFactorRow(issued.userId))?.failed).toBe(
        TWO_FACTOR_LOCKOUT.maxFailedAttempts,
      );

      // When the lock runs out, the right code works again and the count starts over.
      await t.current.admin.query(
        "UPDATE two_factors SET locked_until = now() - interval '1 second' WHERE user_id = $1",
        [issued.userId],
      );
      const again = newBrowser();
      await auth.signIn({ login: email, password: PASSWORD, headers: again.headers() });
      expect(
        (await auth.verifyTwoFactor({ code: totp(secret), headers: again.headers() })).ok,
      ).toBe(true);
      expect(await twoFactorRow(issued.userId)).toMatchObject({ failed: 0, locked_until: null });
      expect(
        logs.records.filter(
          (r) => r.event === "auth.two_factor_locked" && r.user_id === issued.userId,
        ).length,
      ).toBeGreaterThan(0);
    }, 120_000);

    it("one counter for both branches: a sign-in failure counts once, a signed-in failure once, a right code resets", async () => {
      const issued = await newAdmin();
      const { browser, secret } = await enrolWithLink(issued.token);
      const email = await emailOf(issued.userId);
      // Sign-in challenge branch: Better Auth counts it (and we don't count it again).
      const signIn = newBrowser();
      await auth.signIn({ login: email, password: PASSWORD, headers: signIn.headers() });
      await auth.verifyTwoFactor({ code: wrongCode(secret), headers: signIn.headers() });
      expect((await twoFactorRow(issued.userId))?.failed).toBe(1);
      // Existing-session branch: we count it.
      await auth.verifyTwoFactor({ code: wrongCode(secret), headers: browser.headers() });
      expect((await twoFactorRow(issued.userId))?.failed).toBe(2);
      // A right code in the signed-in browser starts the count over (consecutive failures).
      expect(
        await auth.verifyTwoFactor({ code: totp(secret), headers: browser.headers() }),
      ).toEqual({
        ok: false,
        error: { code: "TWO_FACTOR_EXPIRED" },
      });
      expect((await twoFactorRow(issued.userId))?.failed).toBe(0);
    }, 60_000);

    it("10 wrong codes while turning on 2-step sign-in (owner) lock it; TOTP stays off", async () => {
      const tenant = await seedTenant(t.current);
      const owner = await createUser(t.current, { operatorId: tenant.operatorId, role: "owner" });
      await t.current.admin.query(
        `INSERT INTO accounts (id, user_id, account_id, provider_id, password)
         VALUES ($1, $2::uuid, $2::text, 'credential', $3)`,
        [uuidv7(), owner.userId, await hashPassword(PASSWORD)],
      );
      const browser = newBrowser();
      await auth.signIn({ login: owner.login, password: PASSWORD, headers: browser.headers() });
      const enrolment = await auth.startTwoFactorEnrolment({
        password: PASSWORD,
        headers: browser.headers(),
      });
      if (!enrolment.ok) throw new Error(enrolment.error.code);
      for (let i = 1; i <= TWO_FACTOR_LOCKOUT.maxFailedAttempts; i += 1) {
        expect(
          await auth.confirmTwoFactorEnrolment({
            code: wrongCode(enrolment.value.secret),
            headers: browser.headers(),
          }),
        ).toEqual({ ok: false, error: { code: "INVALID_CODE" } });
      }
      expect((await twoFactorRow(owner.userId))?.failed).toBe(TWO_FACTOR_LOCKOUT.maxFailedAttempts);
      expect(
        await auth.confirmTwoFactorEnrolment({
          code: totp(enrolment.value.secret),
          headers: browser.headers(),
        }),
      ).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
      expect(await auth.getSession(browser.headers())).toMatchObject({
        role: "owner",
        twoFactorEnabled: false,
      });
      expect(await auditActions(owner.userId)).toEqual(["auth.signed_in"]);
    }, 120_000);
  });
});

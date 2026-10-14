/**
 * Web authentication against a real database (T-026): sign-in by login and email, role and status
 * gates (lineman never, disabled never), rate limits, sessions (cookie flags, sliding, revocation,
 * sign out everywhere), the platform admin's TOTP enrolment / 2FA step / 8-hour cap, password reset
 * (single use, expiry, no enumeration), tenant context building and the audit trail.
 */
import { createHmac } from "node:crypto";
import { auditEvents, sessions, uuidv7 } from "@cb/db";
import {
  createTenant,
  createUser,
  describeDb,
  type TestUser,
  useTestDatabase,
} from "@cb/db/testing";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAdminContext } from "../admin/context";
import { newRequestId } from "../context/runtime";
import { captureLogs, type SeededTenant, seedTenant } from "../testing";
import { createAuthService, type PasswordResetEmail } from "./auth";
import { hashPassword } from "./password";
import { SESSION_POLICY } from "./policy";
import { AUTH_RATE_LIMITS, createMemoryRateLimiter } from "./rate-limit";

const PASSWORD = "correct horse 42";
const SECRET = "t026-test-secret-not-for-production-0123456789abcdef";
const BASE_URL = "http://localhost:3000";
const SESSION_COOKIE = "cb.session_token";
const TWO_FACTOR_COOKIE = "cb.two_factor";

/** A browser: its cookies, its IP. */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly setCookies: string[] = [];
  constructor(readonly ip = "203.0.113.10") {}
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
    this.setCookies.push(setCookie);
    const [pair] = setCookie.split(";");
    const index = pair?.indexOf("=") ?? -1;
    if (!pair || index < 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = /max-age=0(;|$)/i.test(setCookie) || value === "";
    if (expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
  lastSetCookie(name: string): string | undefined {
    return this.setCookies.findLast((c) => c.startsWith(`${name}=`));
  }
}

/**
 * Plays the part of Next's `nextCookies()`: copies Set-Cookie from every call into the browser
 * whose headers were used (matched by IP, unique per Browser in these tests).
 */
function cookieJarPlugin(browsers: () => Iterable<Browser>): BetterAuthPlugin {
  return {
    id: "test-cookie-jar",
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const setCookies = ctx.context.responseHeaders?.getSetCookie() ?? [];
            if (setCookies.length === 0) return;
            const ip = ctx.headers?.get("x-real-ip");
            const browser = [...browsers()].find((b) => b.ip === ip);
            for (const cookie of setCookies) browser?.apply(cookie);
          }),
        },
      ],
    },
  };
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from an `otpauth://` URI's base32 secret. */
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
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

describeDb("web authentication (Better Auth)", () => {
  const t = useTestDatabase();
  const browsers = new Set<Browser>();
  const emails: PasswordResetEmail[] = [];
  const logs = captureLogs();
  let clock = () => new Date();
  let ipCounter = 0;

  const newBrowser = () => {
    ipCounter += 1;
    const browser = new Browser(`198.51.100.${ipCounter}`);
    browsers.add(browser);
    return browser;
  };

  let service: ReturnType<typeof createAuthService>;
  let tenant: SeededTenant;
  let suspended: SeededTenant;
  let admin: TestUser;
  let ownerEmail: string;

  const setPassword = async (userId: string, password = PASSWORD) => {
    await t.current.admin.query(
      `INSERT INTO accounts (id, user_id, account_id, provider_id, password)
       VALUES ($1, $2::uuid, $2::text, 'credential', $3)
       ON CONFLICT (provider_id, account_id) DO UPDATE SET password = EXCLUDED.password`,
      [uuidv7(), userId, await hashPassword(password)],
    );
  };
  const loginOf = async (userId: string) =>
    (
      await t.current.admin.query<{ login: string }>("SELECT login FROM users WHERE id = $1", [
        userId,
      ])
    ).rows[0]?.login ?? "";
  const sessionRows = async (userId: string) =>
    (
      await t.current.admin.query<{ id: string; expires_at: Date; created_at: Date }>(
        "SELECT id, expires_at, created_at FROM sessions WHERE user_id = $1",
        [userId],
      )
    ).rows;
  const auditRows = async (userId: string) =>
    (
      await t.current.admin.query<{
        action: string;
        operator_id: string | null;
        actor_role: string;
        after: unknown;
        ip: string | null;
        user_agent: string | null;
        request_id: string | null;
      }>(
        "SELECT action, operator_id, actor_role, after, host(ip) AS ip, user_agent, request_id FROM audit_events WHERE actor_id = $1 ORDER BY at, id",
        [userId],
      )
    ).rows;

  beforeAll(async () => {
    service = createAuthService({
      db: t.current.db,
      secret: SECRET,
      baseURL: BASE_URL,
      rateLimiter: createMemoryRateLimiter(),
      sendPasswordResetEmail: async (email) => {
        emails.push(email);
      },
      logger: logs.logger,
      now: () => clock(),
      plugins: [cookieJarPlugin(() => browsers)],
    });
    tenant = await seedTenant(t.current);
    suspended = await seedTenant(t.current);
    await t.current.admin.query("UPDATE operators SET status = 'suspended' WHERE id = $1", [
      suspended.operatorId,
    ]);
    ownerEmail = `owner-${tenant.operatorId.slice(-8)}@cable.test`;
    await t.current.admin.query("UPDATE users SET email = $1 WHERE id = $2", [
      ownerEmail,
      tenant.users.owner,
    ]);
    admin = await createUser(t.current, { operatorId: null });
    for (const userId of [
      ...Object.values(tenant.users),
      ...Object.values(suspended.users),
      admin.userId,
    ]) {
      await setPassword(userId);
    }
  });

  beforeEach(() => {
    clock = () => new Date();
  });

  describe("sign-in", () => {
    it("signs an owner in by user name (any case) and by email, with a safe cookie", async () => {
      const browser = newBrowser();
      const login = await loginOf(tenant.users.owner);
      const byLogin = await service.signIn({
        login: ` ${login.toUpperCase()} `,
        password: PASSWORD,
        headers: browser.headers(),
      });
      expect(byLogin).toEqual({
        ok: true,
        value: {
          status: "signed_in",
          userId: tenant.users.owner,
          role: "owner",
          twoFactorEnrolmentRequired: false,
        },
      });
      const cookie = browser.lastSetCookie(SESSION_COOKIE);
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).toMatch(new RegExp(`Max-Age=${SESSION_POLICY.tenantExpiresInSeconds}`));
      expect(cookie).not.toMatch(/Secure/i); // http base URL (local); https → Secure (below)

      const session = await service.getSession(browser.headers());
      expect(session).toMatchObject({
        userId: tenant.users.owner,
        role: "owner",
        operatorId: tenant.operatorId,
        twoFactorEnrolmentRequired: false,
      });
      const expiresIn = (session?.expiresAt.getTime() ?? 0) - Date.now();
      expect(expiresIn).toBeGreaterThan((SESSION_POLICY.tenantExpiresInSeconds - 60) * 1000);

      const byEmail = await service.signIn({
        login: ownerEmail.toUpperCase(),
        password: PASSWORD,
        headers: newBrowser().headers(),
      });
      expect(byEmail.ok && byEmail.value.status).toBe("signed_in");
    });

    it("builds the owner's TenantContext on the web channel; staff too", async () => {
      for (const role of ["owner", "staff"] as const) {
        const browser = newBrowser();
        await service.signIn({
          login: await loginOf(tenant.users[role]),
          password: PASSWORD,
          headers: browser.headers(),
        });
        const headers = browser.headers();
        headers.set("x-vercel-id", "bom1::iad1::abc12-1700000000000-0123456789ab");
        const ctx = await service.tenantContext({ db: t.current.db }, headers);
        expect(ctx.ok).toBe(true);
        if (!ctx.ok) return;
        expect(ctx.value).toMatchObject({
          operatorId: tenant.operatorId,
          userId: tenant.users[role],
          role,
          channel: "web",
          requestId: "bom1::iad1::abc12-1700000000000-0123456789ab",
          client: { ip: browser.ip, userAgent: "vitest-browser/1.0" },
        });
      }
      const none = await service.tenantContext({ db: t.current.db }, newBrowser().headers());
      expect(none).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    });

    it("gives one answer for a wrong password and an unknown login, and no cookie", async () => {
      const browser = newBrowser();
      const wrong = await service.signIn({
        login: await loginOf(tenant.users.staff),
        password: "not the password",
        headers: browser.headers(),
      });
      const unknown = await service.signIn({
        login: "nobody-here-9999",
        password: PASSWORD,
        headers: browser.headers(),
      });
      const unknownEmail = await service.signIn({
        login: "nobody@nowhere.test",
        password: PASSWORD,
        headers: browser.headers(),
      });
      for (const result of [wrong, unknown, unknownEmail]) {
        expect(result).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      }
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    });

    it("never lets a lineman sign in to the web, even with the right password", async () => {
      const browser = newBrowser();
      const login = await loginOf(tenant.users.lineman);
      const wrong = await service.signIn({
        login,
        password: "nope nope",
        headers: browser.headers(),
      });
      expect(wrong).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });

      const right = await service.signIn({ login, password: PASSWORD, headers: browser.headers() });
      expect(right).toEqual({ ok: false, error: { code: "ROLE_NOT_ALLOWED" } });
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(await sessionRows(tenant.users.lineman)).toEqual([]);
      expect(await auditRows(tenant.users.lineman)).toEqual([
        expect.objectContaining({
          action: "auth.sign_in_blocked",
          operator_id: tenant.operatorId,
          after: { reason: "role_not_allowed" },
        }),
      ]);
    });

    it("refuses disabled users and users of a suspended operator", async () => {
      const disabled = await createUser(t.current, {
        operatorId: tenant.operatorId,
        role: "staff",
      });
      await setPassword(disabled.userId);
      await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
        disabled.userId,
      ]);
      const browser = newBrowser();
      expect(
        await service.signIn({
          login: disabled.login,
          password: PASSWORD,
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "ACCOUNT_DISABLED" } });
      expect(
        await service.signIn({
          login: await loginOf(suspended.users.owner),
          password: PASSWORD,
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "ACCOUNT_DISABLED" } });
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(await sessionRows(disabled.userId)).toEqual([]);
    });

    it("rate-limits wrong passwords per account (×N), across login and email, not other users", async () => {
      const victim = await createUser(t.current, { operatorId: tenant.operatorId, role: "staff" });
      const victimEmail = `victim-${victim.userId.slice(-8)}@cable.test`;
      await t.current.admin.query("UPDATE users SET email = $1 WHERE id = $2", [
        victimEmail,
        victim.userId,
      ]);
      await setPassword(victim.userId);
      const n = AUTH_RATE_LIMITS.signInPerAccount.limit;
      const attacker = newBrowser();
      for (let i = 0; i < n; i += 1) {
        const login = i % 2 === 0 ? victim.login : victimEmail; // alternating doesn't help
        const result = await service.signIn({
          login,
          password: `wrong password ${i}`,
          headers: attacker.headers(),
        });
        expect(result).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      }
      // Attempt N+1 is refused even with the right password, from another IP too.
      const blocked = await service.signIn({
        login: victim.login,
        password: PASSWORD,
        headers: newBrowser().headers(),
      });
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.error.code).toBe("RATE_LIMITED");
      expect(!blocked.ok && blocked.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(await sessionRows(victim.userId)).toEqual([]);
      // Someone else still signs in.
      const other = await service.signIn({
        login: await loginOf(tenant.users.staff),
        password: PASSWORD,
        headers: newBrowser().headers(),
      });
      expect(other.ok).toBe(true);
    });

    it("rate-limits a flood from one IP across many logins", async () => {
      const flooded = createAuthService({
        db: t.current.db,
        secret: SECRET,
        baseURL: BASE_URL,
        rateLimiter: createMemoryRateLimiter(),
        sendPasswordResetEmail: async () => {},
        logger: logs.logger,
      });
      const ip = newBrowser();
      const codes: string[] = [];
      for (let i = 0; i <= AUTH_RATE_LIMITS.signInPerIp.limit; i += 1) {
        const r = await flooded.signIn({
          login: `ghost${i}`,
          password: "x".repeat(8),
          headers: ip.headers(),
        });
        codes.push(r.ok ? "ok" : r.error.code);
      }
      expect(codes.slice(0, -1).every((c) => c === "INVALID_CREDENTIALS")).toBe(true);
      expect(codes.at(-1)).toBe("RATE_LIMITED");
    }, 120_000);

    it("serves an https base URL with Secure, __Secure- prefixed cookies", async () => {
      const secure = createAuthService({
        db: t.current.db,
        secret: SECRET,
        baseURL: "https://app.example.test",
        rateLimiter: createMemoryRateLimiter(),
        sendPasswordResetEmail: async () => {},
        logger: logs.logger,
        plugins: [cookieJarPlugin(() => browsers)],
      });
      const browser = newBrowser();
      const result = await secure.signIn({
        login: await loginOf(tenant.users.owner),
        password: PASSWORD,
        headers: browser.headers(),
      });
      expect(result.ok).toBe(true);
      const cookie = browser.lastSetCookie(`__Secure-${SESSION_COOKIE}`);
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });
  });

  describe("sessions", () => {
    it("slides: an active session is pushed out again (at most daily)", async () => {
      const browser = newBrowser();
      await service.signIn({
        login: await loginOf(tenant.users.staff),
        password: PASSWORD,
        headers: browser.headers(),
      });
      const sessionId = (await service.getSession(browser.headers()))?.sessionId;
      const row = (await sessionRows(tenant.users.staff)).find((s) => s.id === sessionId);
      const before = row?.expires_at.getTime() ?? 0;
      // Pretend the last refresh was 2 days ago.
      const aged = new Date(
        Date.now() + (SESSION_POLICY.tenantExpiresInSeconds - 2 * 86_400) * 1000,
      );
      await t.current.admin.query("UPDATE sessions SET expires_at = $1 WHERE id = $2", [
        aged,
        sessionId,
      ]);
      expect(await service.getSession(browser.headers())).not.toBeNull();
      const refreshed = (await sessionRows(tenant.users.staff)).find((s) => s.id === sessionId);
      expect(refreshed?.expires_at.getTime()).toBeGreaterThan(aged.getTime() + 86_400_000);
      expect(Math.abs((refreshed?.expires_at.getTime() ?? 0) - before)).toBeLessThan(60_000);
    });

    it("drops a session once its user is disabled or turned into a lineman", async () => {
      const user = await createUser(t.current, { operatorId: tenant.operatorId, role: "staff" });
      await setPassword(user.userId);
      const browser = newBrowser();
      await service.signIn({ login: user.login, password: PASSWORD, headers: browser.headers() });
      expect(await service.getSession(browser.headers())).not.toBeNull();
      await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
        user.userId,
      ]);
      expect(await service.getSession(browser.headers())).toBeNull();
      expect(await sessionRows(user.userId)).toEqual([]);

      const other = await createUser(t.current, { operatorId: tenant.operatorId, role: "staff" });
      await setPassword(other.userId);
      const second = newBrowser();
      await service.signIn({ login: other.login, password: PASSWORD, headers: second.headers() });
      await t.current.admin.query("UPDATE users SET role = 'lineman' WHERE id = $1", [
        other.userId,
      ]);
      expect(await service.getSession(second.headers())).toBeNull();
      const ctx = await service.tenantContext({ db: t.current.db }, second.headers());
      expect(ctx).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    });

    it("signs out (session deleted, cookie cleared) and signs out everywhere", async () => {
      const user = await createUser(t.current, { operatorId: tenant.operatorId, role: "owner" });
      await setPassword(user.userId);
      const [laptop, phone, office] = [newBrowser(), newBrowser(), newBrowser()];
      for (const b of [laptop, phone, office]) {
        const r = await service.signIn({
          login: user.login,
          password: PASSWORD,
          headers: b.headers(),
        });
        expect(r.ok).toBe(true);
      }
      expect(await sessionRows(user.userId)).toHaveLength(3);

      expect(await service.signOut({ headers: laptop.headers() })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(laptop.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(await service.getSession(laptop.headers())).toBeNull();
      expect(await sessionRows(user.userId)).toHaveLength(2);

      const everywhere = await service.signOutEverywhere({ headers: phone.headers() });
      expect(everywhere).toEqual({ ok: true, value: { sessions: 2 } });
      expect(await sessionRows(user.userId)).toEqual([]);
      expect(await service.getSession(office.headers())).toBeNull();
      expect(phone.cookies.has(SESSION_COOKIE)).toBe(false);

      const actions = (await auditRows(user.userId)).map((r) => r.action);
      expect(actions).toEqual([
        "auth.signed_in",
        "auth.signed_in",
        "auth.signed_in",
        "auth.signed_out",
        "auth.signed_out_everywhere",
      ]);
    });
  });

  describe("platform admin (TOTP 2FA, 8-hour session)", () => {
    it("must enrol TOTP, then needs the code at every sign-in; 8 hours max", async () => {
      const browser = newBrowser();
      const first = await service.signIn({
        login: await loginOf(admin.userId),
        password: PASSWORD,
        headers: browser.headers(),
      });
      expect(first).toEqual({
        ok: true,
        value: {
          status: "signed_in",
          userId: admin.userId,
          role: "platform_admin",
          twoFactorEnrolmentRequired: true,
        },
      });
      const session = await service.getSession(browser.headers());
      expect(session).toMatchObject({
        role: "platform_admin",
        operatorId: null,
        twoFactorEnrolmentRequired: true,
      });
      const cap = SESSION_POLICY.platformAdminMaxAgeSeconds * 1000;
      const [row] = await sessionRows(admin.userId);
      expect(
        (row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0),
      ).toBeLessThanOrEqual(cap);
      // Not a tenant user.
      const ctx = await service.tenantContext({ db: t.current.db }, browser.headers());
      expect(ctx).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", details: { reason: "not_a_tenant_user" } },
      });

      // Enrol: password again, then a first code.
      expect(
        await service.startTwoFactorEnrolment({
          password: "wrong password!",
          headers: browser.headers(),
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      const enrolment = await service.startTwoFactorEnrolment({
        password: PASSWORD,
        headers: browser.headers(),
      });
      expect(enrolment.ok).toBe(true);
      if (!enrolment.ok) return;
      expect(enrolment.value.totpUri).toMatch(/^otpauth:\/\/totp\//);
      expect(enrolment.value.secret).toMatch(/^[A-Z2-7]+=*$/);
      expect(enrolment.value.backupCodes.length).toBeGreaterThan(0);
      expect(
        await service.confirmTwoFactorEnrolment({ code: "000000", headers: browser.headers() }),
      ).toMatchObject({ ok: false });
      const confirmed = await service.confirmTwoFactorEnrolment({
        code: totp(enrolment.value.secret),
        headers: browser.headers(),
      });
      expect(confirmed).toEqual({
        ok: true,
        value: { userId: admin.userId, role: "platform_admin", otherSessionsEnded: 0 },
      });
      expect(await service.getSession(browser.headers())).toMatchObject({
        twoFactorEnabled: true,
        twoFactorVerified: true,
        twoFactorEnrolmentRequired: false,
      });
      await service.signOut({ headers: browser.headers() });

      // Next sign-in: password, then the code.
      const again = newBrowser();
      const step1 = await service.signIn({
        login: await loginOf(admin.userId),
        password: PASSWORD,
        headers: again.headers(),
      });
      expect(step1).toEqual({ ok: true, value: { status: "two_factor_required" } });
      expect(again.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(again.cookies.has(TWO_FACTOR_COOKIE)).toBe(true);
      expect(await service.getSession(again.headers())).toBeNull();
      expect(await service.verifyTwoFactor({ code: "12345", headers: again.headers() })).toEqual({
        ok: false,
        error: { code: "INVALID_CODE" },
      });
      const wrongCode = totp(enrolment.value.secret, Date.now() + 5 * 60_000);
      expect(await service.verifyTwoFactor({ code: wrongCode, headers: again.headers() })).toEqual({
        ok: false,
        error: { code: "INVALID_CODE" },
      });
      const step2 = await service.verifyTwoFactor({
        code: totp(enrolment.value.secret),
        headers: again.headers(),
      });
      expect(step2).toEqual({
        ok: true,
        value: {
          status: "signed_in",
          userId: admin.userId,
          role: "platform_admin",
          twoFactorEnrolmentRequired: false,
        },
      });
      const adminSession = await service.getSession(again.headers());
      expect(adminSession?.role).toBe("platform_admin");
      expect(adminSession?.twoFactorVerified).toBe(true);
      const lifetime =
        (adminSession?.expiresAt.getTime() ?? 0) - (adminSession?.createdAt.getTime() ?? 0);
      expect(lifetime).toBeLessThanOrEqual(cap);
      expect(lifetime).toBeGreaterThan(cap - 60_000);

      // After 8 hours the session is gone, even though Better Auth would slide it.
      clock = () => new Date(Date.now() + cap + 60_000);
      expect(await service.getSession(again.headers())).toBeNull();
      expect(await sessionRows(admin.userId)).toEqual([]);

      // Platform events: operator_id NULL, no PII.
      const actions = await auditRows(admin.userId);
      expect(actions.map((r) => r.action)).toEqual([
        "auth.signed_in",
        "auth.two_factor_enabled",
        "auth.signed_out",
        "auth.signed_in",
      ]);
      expect(new Set(actions.map((r) => r.operator_id))).toEqual(new Set([null]));
      expect(actions.at(-1)?.after).toEqual({ method: "password_totp" });
    });

    it("T-086b: enrolling ends the other sessions; only a session that passed TOTP is an admin's", async () => {
      const admin2 = await createUser(t.current, { operatorId: null });
      await setPassword(admin2.userId);
      const login = await loginOf(admin2.userId);
      const signIn = (browser: Browser) =>
        service.signIn({ login, password: PASSWORD, headers: browser.headers() });
      const adminContext = (sessionId: string) =>
        resolveAdminContext(
          { db: t.current.db },
          { userId: admin2.userId, sessionId, requestId: newRequestId() },
        );

      // Two browsers sign in with the password alone, before TOTP is on.
      const laptop = newBrowser();
      const phone = newBrowser();
      expect((await signIn(laptop)).ok).toBe(true);
      expect((await signIn(phone)).ok).toBe(true);
      const stale = await service.getSession(laptop.headers());
      expect(stale).toMatchObject({ twoFactorVerified: false, twoFactorEnrolmentRequired: true });
      if (!stale) return;
      expect(await adminContext(stale.sessionId)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", details: { reason: "two_factor_required" } },
      });

      // The phone enrols: its session is re-issued as TOTP-verified, the laptop's is ended.
      const enrolment = await service.startTwoFactorEnrolment({
        password: PASSWORD,
        headers: phone.headers(),
      });
      if (!enrolment.ok) throw new Error(enrolment.error.code);
      const confirmed = await service.confirmTwoFactorEnrolment({
        code: totp(enrolment.value.secret),
        headers: phone.headers(),
      });
      expect(confirmed).toEqual({
        ok: true,
        value: { userId: admin2.userId, role: "platform_admin", otherSessionsEnded: 1 },
      });
      const rows = await t.current.admin.query<{ id: string; verified: Date | null }>(
        "SELECT id, two_factor_verified_at AS verified FROM sessions WHERE user_id = $1",
        [admin2.userId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.verified).toBeInstanceOf(Date);

      // The laptop's password-only session is gone and refused, at both gates.
      expect(rows.rows.map((r) => r.id)).not.toContain(stale.sessionId);
      expect(await service.getSession(laptop.headers())).toBeNull();
      expect(await adminContext(stale.sessionId)).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED", details: { reason: "no_session" } },
      });
      // Enrolling again from it is refused too.
      expect(
        await service.confirmTwoFactorEnrolment({
          code: totp(enrolment.value.secret),
          headers: laptop.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "UNAUTHENTICATED" } });

      // The enrolled session gets in.
      const enrolled = await service.getSession(phone.headers());
      expect(enrolled).toMatchObject({ twoFactorEnabled: true, twoFactorVerified: true });
      expect((await adminContext(enrolled?.sessionId ?? "")).ok).toBe(true);

      // The laptop signs in again: password, then the code → that session gets in too.
      expect(await signIn(laptop)).toEqual({ ok: true, value: { status: "two_factor_required" } });
      expect(
        (
          await service.verifyTwoFactor({
            code: totp(enrolment.value.secret),
            headers: laptop.headers(),
          })
        ).ok,
      ).toBe(true);
      const fresh = await service.getSession(laptop.headers());
      expect(fresh).toMatchObject({ twoFactorVerified: true });
      expect((await adminContext(fresh?.sessionId ?? "")).ok).toBe(true);
      // ... and enrolling is not offered again (already on).
      expect(
        await service.confirmTwoFactorEnrolment({
          code: totp(enrolment.value.secret),
          headers: laptop.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_CODE" } });
      expect(await sessionRows(admin2.userId)).toHaveLength(2);

      // Audit: a platform event with the count (no PII).
      const audit = await auditRows(admin2.userId);
      expect(audit.map((r) => r.action)).toEqual([
        "auth.signed_in",
        "auth.signed_in",
        "auth.other_sessions_ended",
        "auth.two_factor_enabled",
        "auth.signed_in",
      ]);
      expect(audit[2]).toMatchObject({
        operator_id: null,
        actor_role: "platform_admin",
        after: { sessions: 1, reason: "two_factor_enabled" },
      });
    });

    it("T-086b: a password-only admin session that outlives enrolment is ended on its next request", async () => {
      // Belt and braces: if the enrolment step's revocation ever missed a session (a race, a
      // failure after Better Auth turned TOTP on), getSession still refuses it.
      const admin3 = await createUser(t.current, { operatorId: null });
      await setPassword(admin3.userId);
      const browser = newBrowser();
      await service.signIn({
        login: await loginOf(admin3.userId),
        password: PASSWORD,
        headers: browser.headers(),
      });
      expect(await service.getSession(browser.headers())).toMatchObject({
        twoFactorVerified: false,
      });
      await t.current.admin.query("UPDATE users SET two_factor_enabled = true WHERE id = $1", [
        admin3.userId,
      ]);
      expect(await service.getSession(browser.headers())).toBeNull();
      expect(await sessionRows(admin3.userId)).toEqual([]);
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          event: "auth.session_revoked",
          user_id: admin3.userId,
          reason: "two_factor_not_verified_in_session",
        }),
      );
    });

    it("T-086b: tenant users are unaffected (password sessions keep working)", async () => {
      const browser = newBrowser();
      await service.signIn({
        login: await loginOf(tenant.users.staff),
        password: PASSWORD,
        headers: browser.headers(),
      });
      expect(await service.getSession(browser.headers())).toMatchObject({
        role: "staff",
        twoFactorVerified: false,
      });
      const ctx = await service.tenantContext({ db: t.current.db }, browser.headers());
      expect(ctx.ok).toBe(true);
    });
  });

  describe("password reset", () => {
    it("emails a single-use, expiring link to owners/staff only; nobody else learns anything", async () => {
      emails.length = 0;
      const browser = newBrowser();
      // Unknown address, a lineman's and the admin's: same answer, no email.
      const linemanEmail = `lineman-${tenant.users.lineman.slice(-8)}@cable.test`;
      await t.current.admin.query("UPDATE users SET email = $1 WHERE id = $2", [
        linemanEmail,
        tenant.users.lineman,
      ]);
      const adminEmail = `${admin.login}@admin.test`;
      for (const email of ["nobody@nowhere.test", linemanEmail, adminEmail]) {
        expect(await service.requestPasswordReset({ email, headers: browser.headers() })).toEqual({
          ok: true,
          value: undefined,
        });
      }
      expect(emails).toEqual([]);

      // A signed-in session that the reset will end.
      const other = newBrowser();
      await service.signIn({ login: ownerEmail, password: PASSWORD, headers: other.headers() });
      expect(await service.getSession(other.headers())).not.toBeNull();

      expect(
        await service.requestPasswordReset({
          email: ` ${ownerEmail.toUpperCase()} `,
          headers: browser.headers(),
        }),
      ).toEqual({ ok: true, value: undefined });
      expect(emails).toHaveLength(1);
      const email = emails[0];
      expect(email).toMatchObject({ to: ownerEmail, language: "en", expiresInMinutes: 60 });
      const match = /^http:\/\/localhost:3000\/reset\/([A-Za-z0-9_-]+)$/.exec(
        email?.resetUrl ?? "",
      );
      expect(match).not.toBeNull();
      const token = match?.[1] ?? "";

      // The token is stored hashed.
      const stored = await t.current.admin.query<{ identifier: string }>(
        "SELECT identifier FROM verifications",
      );
      expect(stored.rows.some((r) => r.identifier.includes(token))).toBe(false);

      expect(
        await service.resetPassword({ token, newPassword: "short", headers: browser.headers() }),
      ).toEqual({ ok: false, error: { code: "INVALID_PASSWORD" } });
      const newPassword = "a brand new password";
      expect(
        await service.resetPassword({ token, newPassword, headers: browser.headers() }),
      ).toEqual({ ok: true, value: undefined });
      // Single use.
      expect(
        await service.resetPassword({
          token,
          newPassword: "another new password",
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
      // Every session ended; old password no longer works, the new one does.
      expect(await service.getSession(other.headers())).toBeNull();
      expect(
        await service.signIn({
          login: ownerEmail,
          password: PASSWORD,
          headers: newBrowser().headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      expect(
        (
          await service.signIn({
            login: ownerEmail,
            password: newPassword,
            headers: newBrowser().headers(),
          })
        ).ok,
      ).toBe(true);

      const actions = (await auditRows(tenant.users.owner)).map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining(["auth.password_reset_requested", "auth.password_reset_completed"]),
      );
      await setPassword(tenant.users.owner); // restore for other tests
    });

    it("refuses an expired link and a made-up one", async () => {
      emails.length = 0;
      const staffEmail = `staff-${tenant.users.staff.slice(-8)}@cable.test`;
      await t.current.admin.query("UPDATE users SET email = $1, language = 'hi' WHERE id = $2", [
        staffEmail,
        tenant.users.staff,
      ]);
      const browser = newBrowser();
      await service.requestPasswordReset({ email: staffEmail, headers: browser.headers() });
      expect(emails[0]).toMatchObject({ to: staffEmail, language: "hi" });
      const token = emails[0]?.resetUrl.split("/").at(-1) ?? "";
      await t.current.admin.query(
        "UPDATE verifications SET expires_at = now() - interval '1 minute'",
      );
      expect(
        await service.resetPassword({
          token,
          newPassword: "another password",
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
      expect(
        await service.resetPassword({
          token: "made-up-token-0123456789",
          newPassword: "another password",
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
      expect(
        await service.resetPassword({
          token: "../../etc",
          newPassword: "another password",
          headers: browser.headers(),
        }),
      ).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
    });

    it("rate-limits reset requests per address", async () => {
      const browser = newBrowser();
      const email = "someone-else@nowhere.test";
      const { limit } = AUTH_RATE_LIMITS.resetRequestPerEmail;
      for (let i = 0; i < limit; i += 1) {
        expect(
          (await service.requestPasswordReset({ email, headers: newBrowser().headers() })).ok,
        ).toBe(true);
      }
      const blocked = await service.requestPasswordReset({ email, headers: browser.headers() });
      expect(!blocked.ok && blocked.error.code).toBe("RATE_LIMITED");
    });
  });

  describe("audit trail and logs", () => {
    it("records ids, role, IP, user agent and request id; never a login, email or password", async () => {
      const rows = [
        ...(await auditRows(tenant.users.owner)),
        ...(await auditRows(tenant.users.lineman)),
        ...(await auditRows(admin.userId)),
      ];
      expect(rows.length).toBeGreaterThan(0);
      const logins = await Promise.all(
        [tenant.users.owner, tenant.users.lineman, admin.userId].map(loginOf),
      );
      const text = JSON.stringify(rows);
      for (const secret of [...logins, ownerEmail, PASSWORD]) expect(text).not.toContain(secret);
      for (const row of rows) {
        expect(row.ip).toMatch(/^198\.51\.100\.\d+$/);
        expect(row.user_agent).toBe("vitest-browser/1.0");
        expect(row.request_id).toBeTruthy();
      }
      // The strict logger would have thrown on PII; check nothing slipped through as text either.
      const logText = JSON.stringify(logs.records);
      for (const secret of [...logins, ownerEmail, PASSWORD]) expect(logText).not.toContain(secret);
    });

    it("writes tenant events into the tenant's own log (visible to it, not to others)", async () => {
      const own = await t.current.db.withTenant(tenant.operatorId, (tx) =>
        tx.select({ action: auditEvents.action }).from(auditEvents),
      );
      expect(own.map((r) => r.action)).toEqual(expect.arrayContaining(["auth.signed_in"]));
      const other = await createTenant(t.current);
      const seen = await t.current.db.withTenant(other.operatorId, async (tx) => ({
        audit: await tx.select({ id: auditEvents.id }).from(auditEvents),
        sessions: await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.userId, tenant.users.owner)),
      }));
      expect(seen).toEqual({ audit: [], sessions: [] });
    });
  });
});

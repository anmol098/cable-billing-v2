/**
 * Mobile auth against a real database (T-028): lineman-only sign-in with device registration,
 * the 15-minute access token (injected clock), refresh rotation, reuse detection and the one-time
 * grace for a lost refresh response, logout, "Sign out this phone", deactivation, the version gate,
 * rate limits, tenant context building, app config and the audit trail (no PII).
 */
import { auditEvents, uuidv7 } from "@cb/db";
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { AUTH_RATE_LIMITS, createMemoryRateLimiter } from "../auth/rate-limit";
import {
  captureLogs,
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing";
import {
  createMobileAuthService,
  type MobileAuthService,
  type MobileLoginInput,
  type MobileRequestMeta,
} from "./mobile-auth";
import { revokeDevice } from "./revoke";
import { createAccessTokenSigner, hashRefreshToken, REFRESH_REUSE_GRACE_SECONDS } from "./tokens";

const PASSWORD = "lineman pass 42";
const SECRET = "t028-test-secret-not-for-production-0123456789abcdef";
const MIN_VERSION = 3;
const START = new Date("2026-10-13T04:30:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;

describeDb("mobile auth (T-028)", () => {
  const t = useTestDatabase();
  const logs = captureLogs();
  let clock = START;
  let ipCounter = 0;
  let service: MobileAuthService;
  let tenant: SeededTenant;
  let other: SeededTenant;
  let logins: Record<string, string>;
  const runtime = () => testRuntime(t.current.db, { now: () => clock, logs });

  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  /** A request from its own IP (so per-IP limits don't interfere between tests). */
  const meta = (
    extra: Record<string, string> = {},
    version: string | null = "5",
  ): MobileRequestMeta => {
    ipCounter += 1;
    const headers = new Headers({
      "x-real-ip": `198.51.100.${ipCounter % 250}`,
      "user-agent": "okhttp/5.1.0",
      ...extra,
    });
    if (version !== null) headers.set("x-app-version-code", version);
    return { headers, requestId: uuidv7() };
  };
  const bearer = (accessToken: string, version: string | null = "5") =>
    meta({ authorization: `Bearer ${accessToken}` }, version);

  const loginInput = (login: string, installId = uuidv7(), password = PASSWORD) =>
    ({
      login,
      password,
      device: {
        installId,
        model: "Xiaomi Redmi 9A",
        os: "Android 13 (API 33)",
        appVersion: "1.0.3",
        appVersionCode: 5,
      },
    }) satisfies MobileLoginInput;

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
  const tokenRows = async (deviceId: string) =>
    (
      await t.current.admin.query<{
        id: string;
        user_id: string;
        family_id: string;
        parent_id: string | null;
        token_hash: string;
        expires_at: Date;
        rotated_at: Date | null;
        revoked_at: Date | null;
        revoked_reason: string | null;
      }>("SELECT * FROM mobile_refresh_tokens WHERE device_id = $1 ORDER BY created_at, id", [
        deviceId,
      ])
    ).rows;
  const deviceRow = async (deviceId: string) =>
    (
      await t.current.admin.query<{
        id: string;
        user_id: string;
        install_id: string;
        device_code: string;
        model: string;
        os_version: string;
        app_version: string;
        app_version_code: number;
        last_seen_at: Date | null;
        revoked_at: Date | null;
        revoked_by: string | null;
      }>("SELECT * FROM devices WHERE id = $1", [deviceId])
    ).rows[0];
  const auditFor = async (operatorId: string | null, action: string) =>
    (
      await t.current.admin.query<{
        actor_id: string;
        actor_role: string;
        entity_type: string;
        entity_id: string;
        after: Record<string, unknown>;
        ip: string | null;
        user_agent: string | null;
        request_id: string | null;
      }>(
        `SELECT actor_id, actor_role, entity_type, entity_id, after, host(ip) AS ip, user_agent, request_id
           FROM audit_events WHERE operator_id IS NOT DISTINCT FROM $1 AND action = $2 ORDER BY at, id`,
        [operatorId, action],
      )
    ).rows;

  /** Signs the tenant's lineman in on a new phone. */
  const signIn = async (who = tenant.users.lineman, installId = uuidv7()) => {
    const result = await service.login(loginInput(logins[who] ?? "", installId), meta());
    if (!result.ok) throw new Error(`login failed: ${result.error.code}`);
    return { ...result.value, installId };
  };

  beforeAll(async () => {
    tenant = await seedTenant(t.current);
    other = await seedTenant(t.current);
    logins = {};
    for (const userId of [...Object.values(tenant.users), ...Object.values(other.users)]) {
      await setPassword(userId);
      logins[userId] = await loginOf(userId);
    }
    await t.current.admin.query(
      `UPDATE operators SET settings = settings || '{"office_phone":"9800000001","receipt_footer":"Pay by the 10th."}'::jsonb
        WHERE id = $1`,
      [tenant.operatorId],
    );
  });

  beforeEach(() => {
    clock = START;
    service = createMobileAuthService({
      runtime: runtime(),
      secret: SECRET,
      rateLimiter: createMemoryRateLimiter({ now: () => clock.getTime() }),
      minAppVersionCode: MIN_VERSION,
    });
  });

  describe("login", () => {
    it("signs a lineman in, registers the phone and returns a 15-minute / 180-day token pair", async () => {
      const installId = uuidv7();
      const request = meta();
      const result = await service.login(
        loginInput(logins[tenant.users.lineman] ?? "", installId),
        request,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { tokens, user, operator, device } = result.value;

      expect(tokens.accessTokenExpiresAt.toISOString()).toBe("2026-10-13T04:45:00.000Z");
      expect(tokens.refreshTokenExpiresAt.getTime()).toBe(START.getTime() + 180 * DAY);
      expect(user).toEqual({
        id: tenant.users.lineman,
        name: expect.any(String),
        login: logins[tenant.users.lineman],
        language: expect.stringMatching(/^(hi|en)$/),
      });
      expect(operator).toEqual({
        id: tenant.operatorId,
        name: tenant.name,
        officePhone: "9800000001",
        receiptFooter: "Pay by the 10th.",
      });
      expect(device.deviceCode).toMatch(/^[A-HJ-NP-Z2-9]{3}$/);

      const row = await deviceRow(device.id);
      expect(row).toMatchObject({
        user_id: tenant.users.lineman,
        install_id: installId,
        device_code: device.deviceCode,
        model: "Xiaomi Redmi 9A",
        os_version: "Android 13 (API 33)",
        app_version: "1.0.3",
        app_version_code: 5,
        revoked_at: null,
      });
      expect(row?.last_seen_at?.toISOString()).toBe(START.toISOString());

      // Only the SHA-256 of the refresh token is stored; the raw token appears nowhere.
      const tokensStored = await tokenRows(device.id);
      expect(tokensStored).toHaveLength(1);
      expect(tokensStored[0]).toMatchObject({
        user_id: tenant.users.lineman,
        parent_id: null,
        token_hash: hashRefreshToken(tokens.refreshToken),
        rotated_at: null,
        revoked_at: null,
      });
      const dump = await t.current.admin.query(
        "SELECT count(*)::int AS n FROM mobile_refresh_tokens WHERE token_hash = $1 OR family_id::text = $1",
        [tokens.refreshToken],
      );
      expect(dump.rows[0]?.n).toBe(0);

      // The access token works at once and builds a mobile TenantContext bound to the device.
      const auth = await service.authenticate(bearer(tokens.accessToken), { appVersionGate: true });
      expect(auth.ok).toBe(true);
      if (auth.ok) {
        expect(auth.value.ctx).toMatchObject({
          operatorId: tenant.operatorId,
          userId: tenant.users.lineman,
          role: "lineman",
          channel: "mobile",
          deviceId: device.id,
        });
        expect(auth.value.claims).toMatchObject({ dev: device.id, op: tenant.operatorId });
      }

      // Audit: same action as the web, channel mobile, no login or password anywhere.
      const events = (await auditFor(tenant.operatorId, "auth.signed_in")).filter(
        (e) => e.request_id === request.requestId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_id: tenant.users.lineman,
        actor_role: "lineman",
        entity_type: "user",
        ip: request.headers.get("x-real-ip"),
        user_agent: "okhttp/5.1.0",
        after: {
          channel: "mobile",
          method: "password",
          device_id: device.id,
          device_code: device.deviceCode,
          new_device: true,
        },
      });
      const text = JSON.stringify(events);
      expect(text).not.toContain(logins[tenant.users.lineman]);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(tokens.refreshToken);
    });

    it("keeps one device row and code per installation and ends the phone's previous sign-in", async () => {
      const first = await signIn();
      const second = await signIn(tenant.users.lineman, first.installId);
      expect(second.device).toEqual(first.device);

      const rows = await tokenRows(first.device.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ revoked_reason: "logout" });
      expect(rows[1]).toMatchObject({ revoked_at: null });
      expect(rows[0]?.family_id).not.toBe(rows[1]?.family_id);

      // The first sign-in's tokens are dead.
      const refresh = await service.refresh(
        { refreshToken: first.tokens.refreshToken, installId: first.installId },
        meta(),
      );
      expect(refresh).toMatchObject({ ok: false, error: { code: "REFRESH_TOKEN_INVALID" } });
      const auth = await service.authenticate(bearer(first.tokens.accessToken), {
        appVersionGate: true,
      });
      expect(auth).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED", reason: "family_revoked" },
      });
    });

    it("moves a phone to another lineman who signs in on it, signing the first one out", async () => {
      const second = await createUser(t.current, {
        operatorId: tenant.operatorId,
        role: "lineman",
      });
      await setPassword(second.userId);
      logins[second.userId] = await loginOf(second.userId);

      const first = await signIn();
      const taken = await signIn(second.userId, first.installId);
      expect(taken.device.id).toBe(first.device.id);
      expect((await deviceRow(first.device.id))?.user_id).toBe(second.userId);
      const auth = await service.authenticate(bearer(first.tokens.accessToken), {
        appVersionGate: true,
      });
      expect(auth.ok).toBe(false);
      const ok = await service.authenticate(bearer(taken.tokens.accessToken), {
        appVersionGate: true,
      });
      expect(ok.ok && ok.value.ctx.userId).toBe(second.userId);
    });

    it("gives distinct codes to phones signing in at the same time", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => signIn()));
      const codes = new Set(results.map((r) => r.device.deviceCode));
      expect(codes.size).toBe(6);
      // The same installation signing in twice at once still ends up as one device row.
      const installId = uuidv7();
      const twice = await Promise.all([
        signIn(tenant.users.lineman, installId),
        signIn(tenant.users.lineman, installId),
      ]);
      expect(twice[0].device).toEqual(twice[1].device);
    });

    it("rejects owners and staff with the right password (ROLE_NOT_ALLOWED), registering nothing", async () => {
      const devicesBefore = await t.current.admin.query("SELECT count(*)::int AS n FROM devices");
      for (const role of ["owner", "staff"] as const) {
        const userId = tenant.users[role];
        const request = meta();
        const result = await service.login(loginInput(logins[userId] ?? ""), request);
        expect(result).toEqual({
          ok: false,
          error: { code: "ROLE_NOT_ALLOWED", reason: "role_not_allowed" },
        });
        const blocked = (await auditFor(tenant.operatorId, "auth.sign_in_blocked")).filter(
          (e) => e.request_id === request.requestId,
        );
        expect(blocked).toEqual([
          expect.objectContaining({
            actor_id: userId,
            actor_role: role,
            after: { reason: "role_not_allowed", channel: "mobile" },
          }),
        ]);
        // A wrong password reveals nothing about the role.
        const wrong = await service.login(
          loginInput(logins[userId] ?? "", uuidv7(), "nope nope"),
          meta(),
        );
        expect(wrong).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      }
      const devicesAfter = await t.current.admin.query("SELECT count(*)::int AS n FROM devices");
      expect(devicesAfter.rows[0]?.n).toBe(devicesBefore.rows[0]?.n);
    });

    it("rejects a platform admin (platform audit event)", async () => {
      const admin = await createUser(t.current, { operatorId: null });
      await setPassword(admin.userId);
      const result = await service.login(loginInput(await loginOf(admin.userId)), meta());
      expect(result).toMatchObject({ ok: false, error: { code: "ROLE_NOT_ALLOWED" } });
      const events = (await auditFor(null, "auth.sign_in_blocked")).filter(
        (e) => e.actor_id === admin.userId,
      );
      expect(events).toHaveLength(1);
    });

    it("answers an unknown login exactly like a wrong password", async () => {
      const unknown = await service.login(loginInput("nobody-here-9999"), meta());
      const wrong = await service.login(
        loginInput(logins[tenant.users.lineman] ?? "", uuidv7(), "wrong password"),
        meta(),
      );
      expect(unknown).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      expect(wrong).toEqual(unknown);
    });

    it("accepts the login in any case and with spaces around it", async () => {
      const login = logins[tenant.users.lineman] ?? "";
      const result = await service.login(loginInput(`  ${login.toUpperCase()} `), meta());
      expect(result.ok).toBe(true);
    });

    it("refuses a disabled lineman and a suspended operator after the password (ACCOUNT_DISABLED)", async () => {
      const disabled = await createUser(t.current, {
        operatorId: tenant.operatorId,
        role: "lineman",
      });
      await setPassword(disabled.userId);
      await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
        disabled.userId,
      ]);
      expect(await service.login(loginInput(await loginOf(disabled.userId)), meta())).toEqual({
        ok: false,
        error: { code: "ACCOUNT_DISABLED", reason: "user_disabled" },
      });

      const suspended = await seedTenant(t.current);
      await setPassword(suspended.users.lineman);
      await t.current.admin.query("UPDATE operators SET status = 'suspended' WHERE id = $1", [
        suspended.operatorId,
      ]);
      expect(
        await service.login(loginInput(await loginOf(suspended.users.lineman)), meta()),
      ).toEqual({ ok: false, error: { code: "ACCOUNT_DISABLED", reason: "operator_suspended" } });
    });

    it("rate-limits password guessing per account across IPs (shared with the web counters)", async () => {
      const victim = await createUser(t.current, {
        operatorId: tenant.operatorId,
        role: "lineman",
      });
      await setPassword(victim.userId);
      const login = await loginOf(victim.userId);
      for (let i = 0; i < AUTH_RATE_LIMITS.signInPerAccount.limit; i += 1) {
        const r = await service.login(loginInput(login, uuidv7(), `guess ${i}`), meta());
        expect(r).toMatchObject({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      }
      const limited = await service.login(loginInput(login), meta());
      expect(limited).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
      if (!limited.ok) expect(limited.error.retryAfterSeconds).toBeGreaterThan(0);
      // The window passes: the right password works again.
      advance(AUTH_RATE_LIMITS.signInPerAccount.windowSeconds * 1000);
      expect((await service.login(loginInput(login), meta())).ok).toBe(true);
    });

    it("answers APP_TOO_OLD below the minimum and VALIDATION without the version header", async () => {
      const login = logins[tenant.users.lineman] ?? "";
      expect(await service.login(loginInput(login), meta({}, "2"))).toEqual({
        ok: false,
        error: { code: "APP_TOO_OLD", minAppVersionCode: MIN_VERSION },
      });
      expect(await service.login(loginInput(login), meta({}, null))).toMatchObject({
        ok: false,
        error: { code: "VALIDATION", fields: [{ path: "header.x-app-version-code" }] },
      });
      expect((await service.login(loginInput(login), meta({}, String(MIN_VERSION)))).ok).toBe(true);
    });
  });

  describe("access token", () => {
    it("expires 15 minutes after issue (injected clock)", async () => {
      const { tokens } = await signIn();
      advance(15 * MINUTE - 1000);
      expect(
        (await service.authenticate(bearer(tokens.accessToken), { appVersionGate: true })).ok,
      ).toBe(true);
      advance(1000);
      expect(
        await service.authenticate(bearer(tokens.accessToken), { appVersionGate: true }),
      ).toEqual({
        ok: false,
        error: { code: "UNAUTHENTICATED", reason: "expired" },
      });
    });

    it("is refused when missing, tampered or signed with another key", async () => {
      const { tokens, user, device } = await signIn();
      expect(await service.authenticate(meta(), { appVersionGate: true })).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED", reason: "missing_token" },
      });
      const forged = createAccessTokenSigner(`${SECRET}-attacker`).issue(
        { sub: user.id, op: tenant.operatorId, dev: device.id, fam: uuidv7(), role: "lineman" },
        clock,
      );
      expect(
        await service.authenticate(bearer(forged.token), { appVersionGate: true }),
      ).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED", reason: "bad_signature" },
      });
      const tampered = `${tokens.accessToken.slice(0, 10)}x${tokens.accessToken.slice(11)}`;
      expect((await service.authenticate(bearer(tampered), { appVersionGate: true })).ok).toBe(
        false,
      );
      expect(
        await service.authenticate(meta({ authorization: `Basic ${tokens.accessToken}` }), {
          appVersionGate: true,
        }),
      ).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    });

    it("applies the version gate on gated endpoints only", async () => {
      const { tokens } = await signIn();
      expect(
        await service.authenticate(bearer(tokens.accessToken, "2"), { appVersionGate: true }),
      ).toEqual({
        ok: false,
        error: { code: "APP_TOO_OLD", minAppVersionCode: MIN_VERSION },
      });
      // GET /app/config answers old apps (and apps that send no header).
      for (const version of ["2", null]) {
        const r = await service.authenticate(bearer(tokens.accessToken, version), {
          appVersionGate: false,
        });
        expect(r.ok).toBe(true);
      }
    });

    it("stops working as soon as the lineman is deactivated (ACCOUNT_DISABLED)", async () => {
      const lineman = await createUser(t.current, {
        operatorId: tenant.operatorId,
        role: "lineman",
      });
      await setPassword(lineman.userId);
      logins[lineman.userId] = await loginOf(lineman.userId);
      const { tokens, installId, device } = await signIn(lineman.userId);
      await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
        lineman.userId,
      ]);
      expect(
        await service.authenticate(bearer(tokens.accessToken), { appVersionGate: true }),
      ).toMatchObject({
        ok: false,
        error: { code: "ACCOUNT_DISABLED" },
      });
      // Refresh fails too, and the family is revoked for good.
      expect(
        await service.refresh({ refreshToken: tokens.refreshToken, installId }, meta()),
      ).toEqual({
        ok: false,
        error: { code: "ACCOUNT_DISABLED", reason: "user_disabled" },
      });
      expect((await tokenRows(device.id)).every((r) => r.revoked_reason === "user_disabled")).toBe(
        true,
      );
    });
  });

  describe("refresh", () => {
    it("rotates on every use: new pair, old token single-use, 180 days sliding from the last use", async () => {
      const { tokens, installId, device } = await signIn();
      advance(20 * DAY);
      const next = await service.refresh({ refreshToken: tokens.refreshToken, installId }, meta());
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      const pair = next.value.tokens;
      expect(pair.refreshToken).not.toBe(tokens.refreshToken);
      expect(pair.accessToken).not.toBe(tokens.accessToken);
      expect(pair.refreshTokenExpiresAt.getTime()).toBe(clock.getTime() + 180 * DAY);
      expect(pair.accessTokenExpiresAt.getTime()).toBe(clock.getTime() + 15 * MINUTE);

      const rows = await tokenRows(device.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.rotated_at?.toISOString()).toBe(clock.toISOString());
      expect(rows[1]).toMatchObject({
        parent_id: rows[0]?.id,
        family_id: rows[0]?.family_id,
        token_hash: hashRefreshToken(pair.refreshToken),
        rotated_at: null,
      });
      expect((await deviceRow(device.id))?.last_seen_at?.toISOString()).toBe(clock.toISOString());

      // The new access token works; a chain of refreshes keeps working.
      expect(
        (await service.authenticate(bearer(pair.accessToken), { appVersionGate: true })).ok,
      ).toBe(true);
      advance(15 * MINUTE);
      const third = await service.refresh({ refreshToken: pair.refreshToken, installId }, meta());
      expect(third.ok).toBe(true);
    });

    it("detects reuse of a rotated token and revokes the whole family", async () => {
      const { tokens: a, installId, device } = await signIn();
      const b = await service.refresh({ refreshToken: a.refreshToken, installId }, meta());
      if (!b.ok) throw new Error("refresh b");
      advance(MINUTE);
      const c = await service.refresh(
        { refreshToken: b.value.tokens.refreshToken, installId },
        meta(),
      );
      if (!c.ok) throw new Error("refresh c");

      // `a` again: its successor `b` was already used → reuse (an attacker or a replay).
      const request = meta();
      expect(await service.refresh({ refreshToken: a.refreshToken, installId }, request)).toEqual({
        ok: false,
        error: { code: "REFRESH_TOKEN_INVALID", reason: "reuse_detected" },
      });
      const rows = await tokenRows(device.id);
      expect(rows.every((r) => r.revoked_reason === "reuse_detected")).toBe(true);
      // The legitimate latest pair is dead too.
      expect(
        await service.refresh({ refreshToken: c.value.tokens.refreshToken, installId }, meta()),
      ).toMatchObject({ ok: false, error: { code: "REFRESH_TOKEN_INVALID", reason: "revoked" } });
      expect(
        await service.authenticate(bearer(c.value.tokens.accessToken), { appVersionGate: true }),
      ).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED", reason: "family_revoked" } });

      const events = (
        await auditFor(tenant.operatorId, "mobile_auth.refresh_reuse_detected")
      ).filter((e) => e.request_id === request.requestId);
      expect(events).toEqual([
        expect.objectContaining({
          actor_id: tenant.users.lineman,
          entity_type: "device",
          entity_id: device.id,
          after: { family_id: rows[0]?.family_id, revoked_count: 3, within_grace: true },
        }),
      ]);
    });

    it("accepts the previous token once more within the grace window when its response was lost", async () => {
      const { tokens: a, installId, device } = await signIn();
      // The phone sends `a`, the server rotates to `b`, the response never arrives.
      const lost = await service.refresh({ refreshToken: a.refreshToken, installId }, meta());
      expect(lost.ok).toBe(true);
      advance(REFRESH_REUSE_GRACE_SECONDS * 1000 - 1000);
      // The phone retries with `a`: accepted, `b` is retired unused, a fresh pair `c` comes back.
      const retry = await service.refresh({ refreshToken: a.refreshToken, installId }, meta());
      expect(retry.ok).toBe(true);
      if (!retry.ok || !lost.ok) return;
      const rows = await tokenRows(device.id);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.revoked_at === null)).toBe(true);
      expect(rows[1]?.rotated_at?.toISOString()).toBe(clock.toISOString());
      expect(rows[2]?.parent_id).toBe(rows[1]?.id);

      // The new pair works and keeps rotating.
      const c = retry.value.tokens;
      expect((await service.authenticate(bearer(c.accessToken), { appVersionGate: true })).ok).toBe(
        true,
      );
      const d = await service.refresh({ refreshToken: c.refreshToken, installId }, meta());
      expect(d.ok).toBe(true);

      // But only once: `a` a third time is reuse (its successor is no longer unused).
      expect(
        await service.refresh({ refreshToken: a.refreshToken, installId }, meta()),
      ).toMatchObject({
        ok: false,
        error: { code: "REFRESH_TOKEN_INVALID", reason: "reuse_detected" },
      });
    });

    it("gives no grace after the window, nor to another installation", async () => {
      const first = await signIn();
      expect(
        (
          await service.refresh(
            { refreshToken: first.tokens.refreshToken, installId: first.installId },
            meta(),
          )
        ).ok,
      ).toBe(true);
      advance(REFRESH_REUSE_GRACE_SECONDS * 1000 + 1000);
      expect(
        await service.refresh(
          { refreshToken: first.tokens.refreshToken, installId: first.installId },
          meta(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "REFRESH_TOKEN_INVALID", reason: "reuse_detected" },
      });

      const second = await signIn();
      expect(
        (
          await service.refresh(
            { refreshToken: second.tokens.refreshToken, installId: second.installId },
            meta(),
          )
        ).ok,
      ).toBe(true);
      // Same token, another phone's install id: refused, and the family is not revoked (no DoS).
      expect(
        await service.refresh(
          { refreshToken: second.tokens.refreshToken, installId: uuidv7() },
          meta(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "REFRESH_TOKEN_INVALID", reason: "install_mismatch" },
      });
      expect((await tokenRows(second.device.id)).every((r) => r.revoked_at === null)).toBe(true);
    });

    it("refuses unknown and expired tokens", async () => {
      expect(
        await service.refresh({ refreshToken: "made-up-token-value", installId: uuidv7() }, meta()),
      ).toMatchObject({
        ok: false,
        error: { code: "REFRESH_TOKEN_INVALID", reason: "unknown_token" },
      });
      const { tokens, installId } = await signIn();
      advance(180 * DAY);
      expect(
        await service.refresh({ refreshToken: tokens.refreshToken, installId }, meta()),
      ).toMatchObject({
        ok: false,
        error: { code: "REFRESH_TOKEN_INVALID", reason: "expired" },
      });
    });

    it("applies the version gate and the per-installation rate limit", async () => {
      const { tokens, installId } = await signIn();
      expect(
        await service.refresh({ refreshToken: tokens.refreshToken, installId }, meta({}, "1")),
      ).toEqual({ ok: false, error: { code: "APP_TOO_OLD", minAppVersionCode: MIN_VERSION } });
      let refreshToken = tokens.refreshToken;
      for (let i = 0; i < 30; i += 1) {
        const r = await service.refresh({ refreshToken, installId }, meta());
        if (!r.ok) throw new Error(`refresh ${i}: ${r.error.code}`);
        refreshToken = r.value.tokens.refreshToken;
      }
      expect(await service.refresh({ refreshToken, installId }, meta())).toMatchObject({
        ok: false,
        error: { code: "RATE_LIMITED" },
      });
    });
  });

  describe("logout", () => {
    it("revokes the family: refresh and access tokens stop working; always answers ok", async () => {
      const { tokens, installId, device } = await signIn();
      const request = meta({}, null); // logout answers even without a version header
      expect(await service.logout({ refreshToken: tokens.refreshToken }, request)).toEqual({
        ok: true,
        value: { revoked: true },
      });
      expect((await tokenRows(device.id)).every((r) => r.revoked_reason === "logout")).toBe(true);
      expect(
        await service.refresh({ refreshToken: tokens.refreshToken, installId }, meta()),
      ).toMatchObject({
        ok: false,
        error: { code: "REFRESH_TOKEN_INVALID" },
      });
      expect(
        await service.authenticate(bearer(tokens.accessToken), { appVersionGate: true }),
      ).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED", reason: "family_revoked" } });
      // Again, and with a made-up token: still ok.
      expect(await service.logout({ refreshToken: tokens.refreshToken }, meta())).toEqual({
        ok: true,
        value: { revoked: false },
      });
      expect(await service.logout({ refreshToken: "nothing" }, meta())).toEqual({
        ok: true,
        value: { revoked: false },
      });
      const events = (await auditFor(tenant.operatorId, "auth.signed_out")).filter(
        (e) => e.request_id === request.requestId,
      );
      expect(events).toEqual([
        expect.objectContaining({
          actor_id: tenant.users.lineman,
          after: { channel: "mobile", device_id: device.id },
        }),
      ]);
    });
  });

  describe("sign out this phone (revokeDevice)", () => {
    it("revokes the device and its tokens: DEVICE_REVOKED on refresh and on the next request", async () => {
      const { tokens, installId, device } = await signIn();
      const owner = await contextFor(runtime(), tenant, "owner");
      advance(MINUTE);
      const revoked = await revokeDevice.call(runtime(), owner, { deviceId: device.id });
      expect(revoked).toEqual({
        ok: true,
        value: { deviceId: device.id, revokedAt: clock, alreadyRevoked: false, revokedTokens: 1 },
      });
      expect(await deviceRow(device.id)).toMatchObject({ revoked_by: tenant.users.owner });
      expect((await tokenRows(device.id)).every((r) => r.revoked_reason === "device_revoked")).toBe(
        true,
      );

      expect(
        await service.refresh({ refreshToken: tokens.refreshToken, installId }, meta()),
      ).toEqual({
        ok: false,
        error: { code: "DEVICE_REVOKED", reason: "device_revoked" },
      });
      expect(
        await service.authenticate(bearer(tokens.accessToken), { appVersionGate: true }),
      ).toMatchObject({ ok: false, error: { code: "DEVICE_REVOKED" } });

      const events = await auditFor(tenant.operatorId, "devices.revoke");
      expect(events.filter((e) => e.entity_id === device.id)).toEqual([
        expect.objectContaining({ actor_id: tenant.users.owner, actor_role: "owner" }),
      ]);

      // Idempotent.
      const again = await revokeDevice.call(runtime(), owner, { deviceId: device.id });
      expect(again).toMatchObject({ ok: true, value: { alreadyRevoked: true, revokedTokens: 0 } });

      // Signing in on the phone again re-registers it with the same code.
      const back = await signIn(tenant.users.lineman, installId);
      expect(back.device).toEqual(device);
      expect(await deviceRow(device.id)).toMatchObject({ revoked_at: null, revoked_by: null });
      const signedIn = (await auditFor(tenant.operatorId, "auth.signed_in")).at(-1);
      expect(signedIn?.after).toMatchObject({ was_revoked: true, new_device: false });
    });

    it("is for the owner only, and another tenant's device is NOT_FOUND", async () => {
      const { device } = await signIn();
      for (const role of ["staff", "lineman"] as const) {
        const ctx = await contextFor(runtime(), tenant, role);
        expect(await revokeDevice.call(runtime(), ctx, { deviceId: device.id })).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN" },
        });
      }
      const otherOwner = await contextFor(runtime(), other, "owner");
      expect(await revokeDevice.call(runtime(), otherOwner, { deviceId: device.id })).toMatchObject(
        {
          ok: false,
          error: { code: "NOT_FOUND" },
        },
      );
      expect((await deviceRow(device.id))?.revoked_at).toBeNull();
    });
  });

  describe("app config", () => {
    it("returns the minimum version, the operator and the tenant mode", async () => {
      const { tokens } = await signIn();
      const auth = await service.authenticate(bearer(tokens.accessToken, null), {
        appVersionGate: false,
      });
      if (!auth.ok) throw new Error(auth.error.code);
      expect(await service.appConfig(auth.value.ctx)).toEqual({
        minAppVersionCode: MIN_VERSION,
        operator: {
          id: tenant.operatorId,
          name: tenant.name,
          officePhone: "9800000001",
          receiptFooter: "Pay by the 10th.",
        },
        tenantMode: "normal",
        features: {},
      });

      await setSubscriptionStatus(t.current, tenant.operatorId, "read_only");
      try {
        expect((await service.appConfig(auth.value.ctx)).tenantMode).toBe("read_only");
        // Read-only tenants keep signing in and refreshing (D-13).
        expect((await signIn()).tokens.accessToken).toBeTruthy();
      } finally {
        await setSubscriptionStatus(t.current, tenant.operatorId, "active");
      }
    });

    it("falls back to the operator's business phone when no office phone is set", async () => {
      await t.current.admin.query("UPDATE operators SET phone = '98000 00002' WHERE id = $1", [
        other.operatorId,
      ]);
      const result = await service.login(loginInput(logins[other.users.lineman] ?? ""), meta());
      expect(result.ok && result.value.operator).toEqual({
        id: other.operatorId,
        name: other.name,
        officePhone: "9800000002",
        receiptFooter: null,
      });
    });
  });

  it("logged no personal data (the strict logger would have thrown)", () => {
    expect(logs.records.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs.records);
    expect(text).not.toContain(PASSWORD);
    for (const login of Object.values(logins)) expect(text).not.toContain(`"${login}"`);
  });

  it("wrote audit rows only through the tenant or platform paths", async () => {
    const rows = await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.select({ action: auditEvents.action }).from(auditEvents),
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["auth.signed_in", "auth.signed_out", "devices.revoke"]),
    );
  });
});

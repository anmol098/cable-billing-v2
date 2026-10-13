/**
 * Team management against a real database (T-032): adding linemen and staff (sign-in name
 * suggestion and uniqueness, password rules, invite by email), a new password (phones and
 * browsers signed out), switching off/on (refresh fails at once, nothing deleted), the team list
 * with phones, Owner-only access, read-only mode and the audit trail (never a password or hash).
 */
import { uuidv7 } from "@cb/db";
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuthService, type PasswordResetEmail } from "../auth/auth";
import { createMemoryRateLimiter } from "../auth/rate-limit";
import type { TenantContext } from "../context/tenant-context";
import { createMobileAuthService, type MobileRequestMeta } from "../mobile-auth/mobile-auth";
import { revokeDevice } from "../mobile-auth/revoke";
import {
  captureLogs,
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing";
import {
  addLineman,
  addStaff,
  deactivateMember,
  listTeam,
  reactivateMember,
  resetMemberPassword,
} from "./team";

const SECRET = "t032-test-secret-not-for-production-0123456789abcdef";
const LINEMAN_PASSWORD = "river 2468";
const STAFF_PASSWORD = "counter desk 77";
const TIMEOUT = 60_000;

/** Random start, then +1 per call: a fresh 10-digit mobile each time (logins are global). */
let mobileSequence = Math.floor(Math.random() * 80_000_000);
function newMobile(): string {
  mobileSequence += 1;
  return `98${String(mobileSequence).padStart(8, "0")}`;
}

describeDb("team management (T-032)", () => {
  const t = useTestDatabase();
  const logs = captureLogs();
  const emails: PasswordResetEmail[] = [];
  let ipCounter = 0;
  let tenant: SeededTenant;
  let other: SeededTenant;
  let owner: TenantContext;

  const runtime = () => testRuntime(t.current.db, { logs });
  const mobileAuth = () =>
    createMobileAuthService({
      runtime: runtime(),
      secret: SECRET,
      rateLimiter: createMemoryRateLimiter(),
    });
  const webAuth = () =>
    createAuthService({
      db: t.current.db,
      secret: SECRET,
      baseURL: "http://localhost:3000",
      rateLimiter: createMemoryRateLimiter(),
      sendPasswordResetEmail: async (email) => {
        emails.push(email);
      },
      logger: logs.logger,
    });
  const headers = () => {
    ipCounter += 1;
    return new Headers({ "x-real-ip": `198.51.100.${ipCounter % 250}`, "user-agent": "vitest" });
  };
  const meta = (extra: Record<string, string> = {}): MobileRequestMeta => ({
    headers: new Headers({ ...Object.fromEntries(headers()), "x-app-version-code": "5", ...extra }),
    requestId: uuidv7(),
  });
  const phoneLogin = (login: string, password: string, installId = uuidv7()) =>
    mobileAuth().login(
      {
        login,
        password,
        device: {
          installId,
          model: "Xiaomi Redmi 9A",
          os: "Android 13 (API 33)",
          appVersion: "1.0.3",
          appVersionCode: 5,
        },
      },
      meta(),
    );

  const query = async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await t.current.admin.query<R>(sql, params)).rows;
  const userRow = async (id: string) =>
    (
      await query<{ role: string; login: string; phone: string | null; status: string }>(
        "SELECT role, login, phone, status, language FROM users WHERE id = $1",
        [id],
      )
    )[0];
  const credential = async (id: string) =>
    (
      await query<{ password: string }>(
        "SELECT password FROM accounts WHERE user_id = $1 AND provider_id = 'credential'",
        [id],
      )
    )[0]?.password;
  const auditRows = async (operatorId: string, action: string) =>
    query<{ entity_id: string; before: unknown; after: Record<string, unknown> }>(
      "SELECT entity_id, before, after FROM audit_events WHERE operator_id = $1 AND action = $2 ORDER BY at, id",
      [operatorId, action],
    );
  const tableCounts = async () =>
    (
      await query<{ users: number; accounts: number; audit: number }>(
        `SELECT (SELECT count(*)::int FROM users) AS users,
                (SELECT count(*)::int FROM accounts) AS accounts,
                (SELECT count(*)::int FROM audit_events) AS audit`,
      )
    )[0];

  const addTestLineman = async (overrides: Record<string, string> = {}) => {
    const mobile = newMobile();
    const result = await addLineman.call(runtime(), owner, {
      name: "Ravi Kumar",
      mobile,
      password: LINEMAN_PASSWORD,
      ...overrides,
    });
    if (!result.ok) throw new Error(`addLineman: ${JSON.stringify(result.error)}`);
    return { ...result.value, mobile };
  };

  beforeAll(async () => {
    tenant = await seedTenant(t.current);
    other = await seedTenant(t.current);
    owner = await contextFor(runtime(), tenant, "owner");
  }, TIMEOUT);

  describe("add a lineman", () => {
    it(
      "creates the lineman with the mobile as sign-in name and an argon2id password; the phone signs in",
      async () => {
        const mobile = newMobile();
        const result = await addLineman.call(runtime(), owner, {
          name: "  Ravi   Kumar ",
          mobile: `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`,
          password: LINEMAN_PASSWORD,
        });
        expect(result).toMatchObject({
          ok: true,
          value: {
            role: "lineman",
            login: mobile,
            loginChanged: false,
            name: "Ravi Kumar",
            phone: mobile,
            language: "hi",
            invite: false,
          },
        });
        if (!result.ok) return;
        expect(await userRow(result.value.userId)).toMatchObject({
          role: "lineman",
          login: mobile,
          phone: mobile,
          status: "active",
        });
        const hash = await credential(result.value.userId);
        expect(hash).toMatch(/^\$argon2id\$/);
        expect(hash).not.toContain(LINEMAN_PASSWORD);

        const signedIn = await phoneLogin(mobile, LINEMAN_PASSWORD);
        expect(signedIn.ok).toBe(true);

        const [event] = await auditRows(tenant.operatorId, "team.add_lineman");
        expect(event?.entity_id).toBe(result.value.userId);
        expect(event?.after).toMatchObject({ role: "lineman", login: mobile, status: "active" });
      },
      TIMEOUT,
    );

    it(
      "uses <mobile>-2 when another business already has the mobile as a sign-in name, revealing nothing",
      async () => {
        const mobile = newMobile();
        const elsewhere = await createUser(t.current, {
          operatorId: other.operatorId,
          role: "lineman",
          login: mobile,
        });
        const result = await addLineman.call(runtime(), owner, {
          name: "Suresh Pal",
          mobile,
          password: LINEMAN_PASSWORD,
        });
        expect(result).toMatchObject({ ok: true, value: { login: `${mobile}-2`, loginChanged: true } });
        expect(JSON.stringify(result)).not.toContain(elsewhere.userId);
        expect(JSON.stringify(result)).not.toContain(other.operatorId);
        // The other business's user is untouched.
        expect(await userRow(elsewhere.userId)).toMatchObject({ login: mobile, status: "active" });
      },
      TIMEOUT,
    );

    it(
      "refuses a mobile already used as a sign-in name in this team (no duplicate person)",
      async () => {
        const first = await addTestLineman();
        const before = await tableCounts();
        const again = await addLineman.call(runtime(), owner, {
          name: "Ravi again",
          mobile: first.mobile,
          password: LINEMAN_PASSWORD,
        });
        expect(again).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "CONFLICT",
            details: { reason: "login_in_team", field: "login", userId: first.userId },
          }),
        });
        expect(await tableCounts()).toEqual(before);
      },
      TIMEOUT,
    );

    it(
      "refuses a typed sign-in name another business uses (login_taken) and a bad one",
      async () => {
        const taken = `ravi${Date.now() % 100_000}`;
        await createUser(t.current, { operatorId: other.operatorId, role: "staff", login: taken });
        const result = await addLineman.call(runtime(), owner, {
          name: "Ravi",
          mobile: newMobile(),
          login: taken.toUpperCase(),
          password: LINEMAN_PASSWORD,
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: "CONFLICT", details: { reason: "login_taken", field: "login" } },
        });
        const bad = await addLineman.call(runtime(), owner, {
          name: "Ravi",
          mobile: newMobile(),
          login: "ravi@cable",
          password: LINEMAN_PASSWORD,
        });
        expect(bad).toMatchObject({
          ok: false,
          error: { code: "VALIDATION", details: { fields: [{ path: "login", code: "bad_characters" }] } },
        });
      },
      TIMEOUT,
    );

    it(
      "applies the simple password rules and reports every field problem at once, writing nothing",
      async () => {
        const before = await tableCounts();
        const mobile = newMobile();
        const cases: Array<[string, string]> = [
          ["12345", "too_short"],
          ["123456", "too_simple"],
          ["111111", "too_simple"],
          ["abcdef", "too_simple"],
          [mobile, "same_as_login"],
        ];
        for (const [password, code] of cases) {
          const result = await addLineman.call(runtime(), owner, { name: "Ravi", mobile, password });
          expect(result).toMatchObject({
            ok: false,
            error: { code: "VALIDATION", details: { fields: [{ path: "password", code }] } },
          });
          expect(JSON.stringify(result)).not.toContain(password);
        }
        const all = await addLineman.call(runtime(), owner, {
          name: " ",
          mobile: "12345",
          password: "",
        });
        expect(all).toMatchObject({
          ok: false,
          error: {
            code: "VALIDATION",
            details: {
              fields: [
                { path: "name", code: "required" },
                { path: "mobile", code: "invalid" },
                { path: "password", code: "required" },
              ],
            },
          },
        });
        expect(await tableCounts()).toEqual(before);
        // A 6-digit number is fine.
        expect((await addTestLineman({ password: "583920" })).role).toBe("lineman");
      },
      TIMEOUT,
    );
  });

  describe("add staff", () => {
    it(
      "with a first password: they sign in on the web",
      async () => {
        const mobile = newMobile();
        const result = await addStaff.call(runtime(), owner, {
          name: "Meena",
          mobile,
          email: `Meena.${mobile}@Cable.test`,
          setup: "password",
          password: STAFF_PASSWORD,
        });
        expect(result).toMatchObject({
          ok: true,
          value: { role: "staff", login: mobile, email: `meena.${mobile}@cable.test`, invite: false },
        });
        const signIn = await webAuth().signIn({
          login: mobile,
          password: STAFF_PASSWORD,
          headers: headers(),
        });
        expect(signIn).toMatchObject({ ok: true, value: { status: "signed_in", role: "staff" } });
        // Staff use the web rule: 8 characters at least.
        const short = await addStaff.call(runtime(), owner, {
          name: "Short",
          email: `short.${mobile}@cable.test`,
          setup: "password",
          password: "583920",
        });
        expect(short).toMatchObject({
          ok: false,
          error: { details: { fields: [{ path: "password", code: "too_short" }] } },
        });
      },
      TIMEOUT,
    );

    it(
      "by invite: no password until they use the emailed link, then they sign in",
      async () => {
        const email = `invite.${newMobile()}@cable.test`;
        const result = await addStaff.call(runtime(), owner, {
          name: "Asha",
          email,
          setup: "invite",
          password: "ignored for an invite",
        });
        expect(result).toMatchObject({ ok: true, value: { invite: true, email } });
        if (!result.ok) return;
        expect(await credential(result.value.userId)).toBeUndefined();
        expect(result.value.login).toMatch(/^invite\.\d+$/);

        const listed = await listTeam.call(runtime(), owner, {});
        const member = listed.ok
          ? listed.value.members.find((m) => m.id === result.value.userId)
          : undefined;
        expect(member).toMatchObject({ role: "staff", passwordSet: false });

        const auth = webAuth();
        emails.length = 0;
        const sent = await auth.requestPasswordReset({
          email,
          headers: headers(),
          invite: { businessName: "Test Cable", login: result.value.login },
        });
        expect(sent.ok).toBe(true);
        expect(emails).toHaveLength(1);
        expect(emails[0]).toMatchObject({
          to: email,
          language: "en",
          invite: { businessName: "Test Cable", login: result.value.login },
        });
        const token = emails[0]?.resetUrl.split("/").at(-1) ?? "";
        expect(
          await auth.resetPassword({ token, newPassword: STAFF_PASSWORD, headers: headers() }),
        ).toEqual({ ok: true, value: undefined });
        expect(await credential(result.value.userId)).toMatch(/^\$argon2id\$/);
        expect(
          await auth.signIn({ login: email, password: STAFF_PASSWORD, headers: headers() }),
        ).toMatchObject({ ok: true });
      },
      TIMEOUT,
    );

    it(
      "needs an email for an invite and refuses an email another account has",
      async () => {
        const noEmail = await addStaff.call(runtime(), owner, { name: "Asha", setup: "invite" });
        expect(noEmail).toMatchObject({
          ok: false,
          error: { details: { fields: [{ path: "email", code: "required" }] } },
        });
        const email = `taken.${newMobile()}@cable.test`;
        await t.current.admin.query(
          "INSERT INTO users (id, operator_id, role, name, login, email, language) VALUES ($1, $2, 'staff', 'X', $3, $4, 'en')",
          [uuidv7(), other.operatorId, `taken${newMobile()}`, email],
        );
        const taken = await addStaff.call(runtime(), owner, {
          name: "Asha",
          email,
          setup: "invite",
        });
        expect(taken).toMatchObject({
          ok: false,
          error: { code: "CONFLICT", details: { reason: "email_taken", field: "email" } },
        });
        expect(JSON.stringify(taken)).not.toContain(other.operatorId);
      },
      TIMEOUT,
    );
  });

  describe("new password", () => {
    it(
      "signs every phone out (refresh fails) and only the new password works",
      async () => {
        const lineman = await addTestLineman();
        const first = await phoneLogin(lineman.login, LINEMAN_PASSWORD);
        if (!first.ok) throw new Error("phone sign-in failed");
        const installId = uuidv7();
        const second = await phoneLogin(lineman.login, LINEMAN_PASSWORD, installId);
        if (!second.ok) throw new Error("phone sign-in failed");

        const result = await resetMemberPassword.call(runtime(), owner, {
          userId: lineman.userId,
          password: "mango 1357",
        });
        expect(result).toMatchObject({
          ok: true,
          value: { role: "lineman", revokedTokens: 2, endedSessions: 0 },
        });
        const refreshed = await mobileAuth().refresh(
          { refreshToken: second.value.tokens.refreshToken, installId },
          meta(),
        );
        expect(refreshed).toMatchObject({ ok: false, error: { code: "REFRESH_TOKEN_INVALID" } });
        const access = await mobileAuth().authenticate(
          meta({ authorization: `Bearer ${first.value.tokens.accessToken}` }),
          { appVersionGate: true },
        );
        expect(access.ok).toBe(false);
        const reasons = await query<{ revoked_reason: string }>(
          "SELECT DISTINCT revoked_reason FROM mobile_refresh_tokens WHERE user_id = $1",
          [lineman.userId],
        );
        expect(reasons).toEqual([{ revoked_reason: "password_changed" }]);

        expect(await phoneLogin(lineman.login, LINEMAN_PASSWORD)).toMatchObject({
          ok: false,
          error: { code: "INVALID_CREDENTIALS" },
        });
        expect((await phoneLogin(lineman.login, "mango 1357")).ok).toBe(true);
      },
      TIMEOUT,
    );

    it(
      "ends a staff member's web sessions and checks the rules for their role",
      async () => {
        const mobile = newMobile();
        const staff = await addStaff.call(runtime(), owner, {
          name: "Meena",
          mobile,
          setup: "password",
          password: STAFF_PASSWORD,
        });
        if (!staff.ok) throw new Error("addStaff failed");
        const auth = webAuth();
        expect(
          (await auth.signIn({ login: mobile, password: STAFF_PASSWORD, headers: headers() })).ok,
        ).toBe(true);
        const short = await resetMemberPassword.call(runtime(), owner, {
          userId: staff.value.userId,
          password: "583920",
        });
        expect(short).toMatchObject({
          ok: false,
          error: { code: "VALIDATION", details: { fields: [{ path: "password", code: "too_short" }] } },
        });
        const result = await resetMemberPassword.call(runtime(), owner, {
          userId: staff.value.userId,
          password: "new counter 88",
        });
        expect(result).toMatchObject({ ok: true, value: { endedSessions: 1 } });
        expect(
          await query("SELECT id FROM sessions WHERE user_id = $1", [staff.value.userId]),
        ).toEqual([]);
        expect(
          await auth.signIn({ login: mobile, password: STAFF_PASSWORD, headers: headers() }),
        ).toMatchObject({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      },
      TIMEOUT,
    );

    it(
      "never touches the Owner's account and refuses another tenant's user (NOT_FOUND)",
      async () => {
        const before = await tableCounts();
        expect(
          await resetMemberPassword.call(runtime(), owner, {
            userId: tenant.users.owner,
            password: "mango 1357",
          }),
        ).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", details: { reason: "owner_account" } },
        });
        expect(
          await resetMemberPassword.call(runtime(), owner, {
            userId: other.users.lineman,
            password: "mango 1357",
          }),
        ).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
        expect(await tableCounts()).toEqual(before);
      },
      TIMEOUT,
    );
  });

  describe("switch off / on", () => {
    it(
      "a switched-off lineman's refresh fails at once, sign-in is refused, nothing is deleted",
      async () => {
        const lineman = await addTestLineman();
        const installId = uuidv7();
        const signedIn = await phoneLogin(lineman.login, LINEMAN_PASSWORD, installId);
        if (!signedIn.ok) throw new Error("phone sign-in failed");

        const off = await deactivateMember.call(runtime(), owner, { userId: lineman.userId });
        expect(off).toMatchObject({
          ok: true,
          value: { status: "disabled", unchanged: false, revokedTokens: 1 },
        });
        expect(
          await mobileAuth().refresh(
            { refreshToken: signedIn.value.tokens.refreshToken, installId },
            meta(),
          ),
        ).toMatchObject({ ok: false, error: { code: "REFRESH_TOKEN_INVALID" } });
        expect(
          await mobileAuth().authenticate(
            meta({ authorization: `Bearer ${signedIn.value.tokens.accessToken}` }),
            { appVersionGate: true },
          ),
        ).toMatchObject({ ok: false, error: { code: "ACCOUNT_DISABLED" } });
        expect(await phoneLogin(lineman.login, LINEMAN_PASSWORD)).toMatchObject({
          ok: false,
          error: { code: "ACCOUNT_DISABLED" },
        });
        // Never deleted: the user, the credential and the phone stay.
        expect(await userRow(lineman.userId)).toMatchObject({ status: "disabled" });
        expect(await credential(lineman.userId)).toMatch(/^\$argon2id\$/);
        expect(
          await query("SELECT id FROM devices WHERE id = $1", [signedIn.value.device.id]),
        ).toHaveLength(1);
        const [event] = await auditRows(tenant.operatorId, "team.deactivate");
        expect(event).toMatchObject({
          entity_id: lineman.userId,
          before: { status: "active" },
          after: { status: "disabled", role: "lineman", revoked_count: 1 },
        });

        // Again: nothing changes, no second audit row.
        const again = await deactivateMember.call(runtime(), owner, { userId: lineman.userId });
        expect(again).toMatchObject({ ok: true, value: { unchanged: true, revokedTokens: 0 } });
        expect(await auditRows(tenant.operatorId, "team.deactivate")).toHaveLength(1);

        // Switched on again: the phone signs in with the password (old sign-ins stay ended).
        const on = await reactivateMember.call(runtime(), owner, { userId: lineman.userId });
        expect(on).toMatchObject({ ok: true, value: { status: "active", unchanged: false } });
        expect(
          await mobileAuth().refresh(
            { refreshToken: signedIn.value.tokens.refreshToken, installId },
            meta(),
          ),
        ).toMatchObject({ ok: false });
        expect((await phoneLogin(lineman.login, LINEMAN_PASSWORD)).ok).toBe(true);
        expect(await reactivateMember.call(runtime(), owner, { userId: lineman.userId })).toMatchObject(
          { ok: true, value: { unchanged: true } },
        );
      },
      TIMEOUT,
    );

    it(
      "a switched-off staff member's web session ends and sign-in is refused",
      async () => {
        const mobile = newMobile();
        const staff = await addStaff.call(runtime(), owner, {
          name: "Meena",
          mobile,
          setup: "password",
          password: STAFF_PASSWORD,
        });
        if (!staff.ok) throw new Error("addStaff failed");
        const auth = webAuth();
        await auth.signIn({ login: mobile, password: STAFF_PASSWORD, headers: headers() });
        const off = await deactivateMember.call(runtime(), owner, { userId: staff.value.userId });
        expect(off).toMatchObject({ ok: true, value: { endedSessions: 1 } });
        expect(
          await auth.signIn({ login: mobile, password: STAFF_PASSWORD, headers: headers() }),
        ).toMatchObject({ ok: false, error: { code: "ACCOUNT_DISABLED" } });
      },
      TIMEOUT,
    );

    it(
      "the Owner can't switch themselves off",
      async () => {
        expect(
          await deactivateMember.call(runtime(), owner, { userId: tenant.users.owner }),
        ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(await userRow(tenant.users.owner)).toMatchObject({ status: "active" });
      },
      TIMEOUT,
    );
  });

  describe("team list and phones", () => {
    it(
      "lists the team with each lineman's phones, signed in or not, and 'Sign out this phone'",
      async () => {
        const lineman = await addTestLineman({ name: "Aaron Phone" });
        const signedIn = await phoneLogin(lineman.login, LINEMAN_PASSWORD);
        if (!signedIn.ok) throw new Error("phone sign-in failed");

        const listed = await listTeam.call(runtime(), owner, {});
        if (!listed.ok) throw new Error("listTeam failed");
        expect(listed.value).toMatchObject({
          selfUserId: tenant.users.owner,
          editable: true,
          readOnlyReason: null,
        });
        const roles = listed.value.members.map((m) => m.role);
        expect(roles[0]).toBe("owner");
        expect(roles.indexOf("staff")).toBeGreaterThan(roles.lastIndexOf("lineman"));
        const member = listed.value.members.find((m) => m.id === lineman.userId);
        expect(member).toMatchObject({ passwordSet: true, status: "active" });
        expect(member?.phones).toEqual([
          expect.objectContaining({
            id: signedIn.value.device.id,
            deviceCode: signedIn.value.device.deviceCode,
            model: "Xiaomi Redmi 9A",
            appVersion: "1.0.3",
            appVersionCode: 5,
            signedIn: true,
            signedOutAt: null,
          }),
        ]);
        expect(member?.phones[0]?.lastSeenAt).toBeInstanceOf(Date);
        // Never another tenant's people, never a password.
        const text = JSON.stringify(listed.value);
        expect(text).not.toContain(other.users.lineman);
        expect(text).not.toContain("argon2");

        const out = await revokeDevice.call(runtime(), owner, {
          deviceId: signedIn.value.device.id,
        });
        expect(out.ok).toBe(true);
        const after = await listTeam.call(runtime(), owner, {});
        const phone = after.ok
          ? after.value.members.find((m) => m.id === lineman.userId)?.phones[0]
          : undefined;
        expect(phone).toMatchObject({ signedIn: false });
        expect(phone?.signedOutAt).toBeInstanceOf(Date);
      },
      TIMEOUT,
    );

    it(
      "read-only mode: the Owner still sees the team, changes are refused",
      async () => {
        const readOnly = await seedTenant(t.current, { subscription: "read_only" });
        const ctx = await contextFor(runtime(), readOnly, "owner");
        const listed = await listTeam.call(runtime(), ctx, {});
        expect(listed).toMatchObject({
          ok: true,
          value: { editable: false, readOnlyReason: "tenant_read_only" },
        });
        expect(
          await addLineman.call(runtime(), ctx, {
            name: "Ravi",
            mobile: newMobile(),
            password: LINEMAN_PASSWORD,
          }),
        ).toMatchObject({ ok: false, error: { code: "TENANT_READ_ONLY" } });
        await setSubscriptionStatus(t.current, readOnly.operatorId, "active");
      },
      TIMEOUT,
    );

    it(
      "Owner only: Staff and linemen get FORBIDDEN from every team service, nothing changes",
      async () => {
        const before = await tableCounts();
        for (const role of ["staff", "lineman"] as const) {
          const ctx = await contextFor(runtime(), tenant, role);
          const calls = [
            listTeam.call(runtime(), ctx, {}),
            addLineman.call(runtime(), ctx, {
              name: "X",
              mobile: newMobile(),
              password: LINEMAN_PASSWORD,
            }),
            addStaff.call(runtime(), ctx, { name: "X", setup: "invite", email: "x@cable.test" }),
            resetMemberPassword.call(runtime(), ctx, {
              userId: tenant.users.lineman,
              password: LINEMAN_PASSWORD,
            }),
            deactivateMember.call(runtime(), ctx, { userId: tenant.users.lineman }),
            reactivateMember.call(runtime(), ctx, { userId: tenant.users.lineman }),
          ];
          for (const result of await Promise.all(calls)) {
            expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
          }
        }
        expect(await tableCounts()).toEqual(before);
      },
      TIMEOUT,
    );
  });

  it("never writes a password or a hash into the audit trail or the logs", async () => {
    const rows = await query<{ before: unknown; after: unknown }>(
      "SELECT before, after FROM audit_events WHERE action LIKE 'team.%'",
    );
    expect(rows.length).toBeGreaterThan(5);
    const audit = JSON.stringify(rows);
    const logText = JSON.stringify(logs.records);
    for (const secret of [
      LINEMAN_PASSWORD,
      STAFF_PASSWORD,
      "mango 1357",
      "new counter 88",
      "583920",
      "$argon2",
    ]) {
      expect(audit).not.toContain(secret);
      expect(logText).not.toContain(secret);
    }
    expect(audit).not.toMatch(/"password"/i);
    // The strict logger would have thrown on a name, phone, email or login in a log line.
    expect(logs.records.some((r) => r.event === "team.member_added")).toBe(true);
  });
});

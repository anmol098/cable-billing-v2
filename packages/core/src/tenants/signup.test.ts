/**
 * Self sign-up against a real database (T-027): the pending sign-up and its email, no account
 * (and no sign-in) before the link is used, the password check on the link, provisioning on
 * verify (once, also when two tabs verify at the same time), expiry, rate limits, Turnstile,
 * no account enumeration.
 */
import { randomBytes, randomInt } from "node:crypto";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeEach, expect, it } from "vitest";
import { createAuthService } from "../auth/auth";
import { createMemoryRateLimiter, type RateLimiter } from "../auth/rate-limit";
import { captureLogs, testRuntime } from "../testing";
import { type BotCheck, disabledBotCheck } from "./bot-check";
import {
  createSignupService,
  SIGNUP_LINK_TTL_SECONDS,
  SIGNUP_RATE_LIMITS,
  type SignupEmail,
  type SignupStartInput,
  signupIdentifier,
} from "./signup";

const PASSWORD = "signup pass 123";
const BASE_URL = "https://app.cable.test";
const START = new Date("2026-10-13T04:30:00Z");

const randomMobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

describeDb("self sign-up", () => {
  const t = useTestDatabase();
  let clock = START;
  let emails: SignupEmail[];
  let logs: ReturnType<typeof captureLogs>;
  let ip = 0;

  const service = (
    options: { botCheck?: BotCheck; rateLimiter?: RateLimiter; failEmail?: boolean } = {},
  ) =>
    createSignupService({
      runtime: testRuntime(t.current.db, { now: () => clock, logs }),
      baseURL: `${BASE_URL}/`,
      rateLimiter: options.rateLimiter ?? createMemoryRateLimiter({ now: () => clock.getTime() }),
      botCheck: options.botCheck ?? disabledBotCheck(),
      sendEmail: async (email) => {
        if (options.failEmail) throw new Error("smtp down");
        emails.push(email);
      },
    });

  const auth = () =>
    createAuthService({
      db: t.current.db,
      secret: "signup-test-secret-0123456789-abcdefghijk",
      baseURL: BASE_URL,
      rateLimiter: createMemoryRateLimiter(),
      sendPasswordResetEmail: async () => {},
      logger: logs.logger,
    });

  const headers = () => {
    ip += 1;
    return new Headers({ "x-real-ip": `198.51.100.${ip % 250}`, "user-agent": "vitest" });
  };

  const form = (overrides: Partial<SignupStartInput> = {}): SignupStartInput => {
    const mobile = randomMobile();
    return {
      businessName: "Anmol Cable Network",
      ownerName: "Anmol Singh",
      mobile: `+91 ${mobile}`,
      email: `Owner-${mobile}@Cable.Test`,
      password: PASSWORD,
      language: "hi",
      botToken: "token",
      headers: headers(),
      ...overrides,
    };
  };

  const tokenOf = (email: SignupEmail | undefined) => {
    if (email?.kind !== "verify") throw new Error(`expected a verify email, got ${email?.kind}`);
    expect(email.verifyUrl.startsWith(`${BASE_URL}/verify/`)).toBe(true);
    return email.verifyUrl.slice(`${BASE_URL}/verify/`.length);
  };

  const usersWithEmail = async (email: string) =>
    (await t.current.admin.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]))
      .rowCount;

  beforeEach(() => {
    clock = START;
    emails = [];
    logs = captureLogs();
  });

  it("start keeps a pending sign-up (hashed link, no password) and emails the link; no account yet", async () => {
    const signup = service();
    const input = form();
    expect(await signup.start(input)).toEqual({ ok: true, value: { status: "email_sent" } });
    expect(emails).toHaveLength(1);
    const email = emails[0];
    expect(email).toMatchObject({
      kind: "verify",
      to: input.email.toLowerCase(),
      language: "hi",
      expiresInHours: 24,
    });
    const token = tokenOf(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await t.current.admin.query<{
      identifier: string;
      value: string;
      expires_at: Date;
    }>("SELECT identifier, value, expires_at FROM verifications WHERE identifier = $1", [
      signupIdentifier(token),
    ]);
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(row?.value).not.toContain(PASSWORD);
    expect(row?.value).not.toContain(token);
    expect(JSON.parse(row?.value ?? "{}").passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.expires_at).toEqual(new Date(START.getTime() + SIGNUP_LINK_TTL_SECONDS * 1000));
    const anyWithToken = await t.current.admin.query(
      "SELECT 1 FROM verifications WHERE identifier LIKE $1 OR value LIKE $1",
      [`%${token}%`],
    );
    expect(anyWithToken.rowCount).toBe(0);

    // Unverified: no user, so no sign-in with the email or the mobile number.
    expect(await usersWithEmail(input.email)).toBe(0);
    for (const login of [input.email, input.mobile.replace("+91 ", "")]) {
      expect(await auth().signIn({ login, password: PASSWORD, headers: headers() })).toEqual({
        ok: false,
        error: { code: "INVALID_CREDENTIALS" },
      });
    }
    expect(await signup.pending(token)).toEqual({
      businessName: "Anmol Cable Network",
      email: input.email.toLowerCase(),
      expiresAt: row?.expires_at,
    });
    expect(JSON.stringify(logs.records)).not.toContain(input.email.toLowerCase());
  });

  it("verify: a wrong password changes nothing; the right one provisions, signs in, and uses the link up", async () => {
    const signup = service();
    const input = form();
    await signup.start(input);
    const token = tokenOf(emails[0]);

    expect(
      await signup.complete({ token, password: "not the password", headers: headers() }),
    ).toEqual({ ok: false, error: { code: "WRONG_PASSWORD" } });
    expect(await usersWithEmail(input.email)).toBe(0);

    const done = await signup.complete({ token, password: PASSWORD, headers: headers() });
    expect(done).toMatchObject({
      ok: true,
      value: {
        email: input.email.toLowerCase(),
        ownerLogin: input.mobile.replace("+91 ", ""),
        created: true,
        trialLastDay: "2026-11-12",
      },
    });
    if (!done.ok) return;
    const owner = await t.current.admin.query(
      "SELECT role, email_verified, language, operator_id FROM users WHERE id = $1",
      [done.value.ownerUserId],
    );
    expect(owner.rows).toEqual([
      { role: "owner", email_verified: true, language: "hi", operator_id: done.value.operatorId },
    ]);
    const subscription = await t.current.admin.query(
      "SELECT status FROM subscriptions WHERE operator_id = $1",
      [done.value.operatorId],
    );
    expect(subscription.rows).toEqual([{ status: "trialing" }]);
    expect(
      await auth().signIn({ login: input.email, password: PASSWORD, headers: headers() }),
    ).toMatchObject({ ok: true, value: { status: "signed_in", role: "owner" } });

    // The link is used up: the page and the button both say so.
    expect(await signup.pending(token)).toBeNull();
    expect(await signup.complete({ token, password: PASSWORD, headers: headers() })).toEqual({
      ok: false,
      error: { code: "INVALID_LINK" },
    });
  });

  it("two tabs verifying at the same time get one tenant", async () => {
    const signup = service();
    const input = form();
    await signup.start(input);
    const token = tokenOf(emails[0]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        signup.complete({ token, password: PASSWORD, headers: headers() }),
      ),
    );
    // Every click that read the pending sign-up before it was deleted succeeds with the same
    // tenant; a click that came after the delete sees a used link.
    const succeeded = results.flatMap((r) => (r.ok ? [r.value] : []));
    const failed = results.flatMap((r) => (r.ok ? [] : [r.error.code]));
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.filter((s) => s.created)).toHaveLength(1);
    expect(new Set(succeeded.map((s) => s.operatorId)).size).toBe(1);
    expect(new Set(failed)).toEqual(new Set(failed.length ? ["INVALID_LINK"] : []));
    expect(await usersWithEmail(input.email)).toBe(1);
    const operators = await t.current.admin.query(
      "SELECT count(*)::int AS n FROM operators o JOIN users u ON u.operator_id = o.id WHERE u.email = $1",
      [input.email.toLowerCase()],
    );
    expect(operators.rows).toEqual([{ n: 1 }]);
  }, 60_000);

  it("an email that already has an account gets a 'sign in' email; the page answer is the same", async () => {
    const signup = service();
    const first = form();
    await signup.start(first);
    await signup.complete({ token: tokenOf(emails[0]), password: PASSWORD, headers: headers() });
    emails = [];
    const before = await t.current.admin.query(
      "SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'signup:%'",
    );

    const again = await signup.start(form({ email: first.email.toUpperCase() }));
    expect(again).toEqual({ ok: true, value: { status: "email_sent" } });
    expect(emails).toEqual([
      {
        kind: "already_registered",
        to: first.email.toLowerCase(),
        language: "hi",
        signInUrl: `${BASE_URL}/login`,
        resetUrl: `${BASE_URL}/reset`,
      },
    ]);
    const after = await t.current.admin.query(
      "SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'signup:%'",
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("two pending sign-ups for one email: the second link says the account exists", async () => {
    const signup = service();
    const input = form();
    await signup.start(input);
    await signup.start({ ...input, businessName: "Second Try", headers: headers() });
    const [firstToken, secondToken] = emails.map(tokenOf);
    if (!firstToken || !secondToken) throw new Error("expected two links");
    expect(
      await signup.complete({ token: firstToken, password: PASSWORD, headers: headers() }),
    ).toMatchObject({ ok: true });
    expect(
      await signup.complete({ token: secondToken, password: PASSWORD, headers: headers() }),
    ).toEqual({ ok: false, error: { code: "ACCOUNT_EXISTS" } });
    expect(await signup.pending(secondToken)).toBeNull();
    expect(await usersWithEmail(input.email)).toBe(1);
  });

  it("links expire after 24 hours, and expired pending sign-ups are cleaned up", async () => {
    const signup = service();
    await signup.start(form());
    const token = tokenOf(emails[0]);
    clock = new Date(START.getTime() + SIGNUP_LINK_TTL_SECONDS * 1000 + 1);
    expect(await signup.pending(token)).toBeNull();
    expect(await signup.complete({ token, password: PASSWORD, headers: headers() })).toEqual({
      ok: false,
      error: { code: "INVALID_LINK" },
    });
    await signup.start(form());
    const stale = await t.current.admin.query("SELECT 1 FROM verifications WHERE identifier = $1", [
      signupIdentifier(token),
    ]);
    expect(stale.rowCount).toBe(0);
  });

  it("refuses malformed and made-up links", async () => {
    const signup = service();
    for (const token of [
      "",
      "short",
      `${"a".repeat(43)}/../x`,
      randomBytes(32).toString("base64url"),
    ]) {
      expect(await signup.pending(token)).toBeNull();
      expect(await signup.complete({ token, password: PASSWORD, headers: headers() })).toEqual({
        ok: false,
        error: { code: "INVALID_LINK" },
      });
    }
  });

  it("checks the fields first and never echoes them", async () => {
    const result = await service().start(
      form({ businessName: "", mobile: "12345", email: "nope", password: "short" }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "VALIDATION",
        fields: {
          business_name: "required",
          mobile: "invalid",
          email: "invalid",
          password: "too_short",
        },
      },
    });
    expect(emails).toEqual([]);
  });

  it("Turnstile: a failed or unreachable check stops the sign-up", async () => {
    const seen: { token: string; ip?: string | undefined }[] = [];
    const no: BotCheck = {
      kind: "turnstile",
      verify: async (input) => {
        seen.push(input);
        return false;
      },
    };
    const input = form({ botToken: "widget-token" });
    expect(await service({ botCheck: no }).start(input)).toEqual({
      ok: false,
      error: { code: "BOT_CHECK_FAILED" },
    });
    expect(seen).toEqual([{ token: "widget-token", ip: input.headers.get("x-real-ip") }]);
    const down: BotCheck = {
      kind: "turnstile",
      verify: async () => {
        throw new Error("cloudflare down");
      },
    };
    expect(await service({ botCheck: down }).start(form())).toEqual({
      ok: false,
      error: { code: "BOT_CHECK_FAILED" },
    });
    expect(emails).toEqual([]);
  });

  it("rate limits: per email, per IP, and guesses on one link", async () => {
    const limiter = createMemoryRateLimiter({ now: () => clock.getTime() });
    const signup = service({ rateLimiter: limiter });
    const input = form();
    for (let i = 0; i < SIGNUP_RATE_LIMITS.startPerEmail.limit; i += 1) {
      expect(await signup.start({ ...input, headers: headers() })).toMatchObject({ ok: true });
    }
    expect(await signup.start({ ...input, headers: headers() })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });

    const sameIp = new Headers({ "x-real-ip": "192.0.2.77" });
    for (let i = 0; i < SIGNUP_RATE_LIMITS.startPerIp.limit; i += 1) {
      expect(await signup.start(form({ headers: sameIp }))).toMatchObject({ ok: true });
    }
    expect(await signup.start(form({ headers: sameIp }))).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });

    const token = tokenOf(emails[0]);
    for (let i = 0; i < SIGNUP_RATE_LIMITS.completePerLink.limit; i += 1) {
      expect(await signup.complete({ token, password: "guess", headers: headers() })).toEqual({
        ok: false,
        error: { code: "WRONG_PASSWORD" },
      });
    }
    // Even the right password waits once the link has had too many guesses.
    expect(await signup.complete({ token, password: PASSWORD, headers: headers() })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
  }, 60_000);

  it("an email that can't be sent is reported (try again)", async () => {
    expect(await service({ failEmail: true }).start(form())).toEqual({
      ok: false,
      error: { code: "EMAIL_FAILED" },
    });
  });

  it("logs carry no names, emails, phones or tokens", async () => {
    const signup = service();
    const input = form();
    await signup.start(input);
    const token = tokenOf(emails[0]);
    await signup.complete({ token, password: PASSWORD, headers: headers() });
    const text = JSON.stringify(logs.records);
    for (const secret of [input.email.toLowerCase(), input.mobile, token, "Anmol", PASSWORD]) {
      expect(text).not.toContain(secret);
    }
    expect(logs.records.map((r) => r.event)).toEqual(
      expect.arrayContaining(["signup.email_sent", "tenant.provisioned"]),
    );
  });
});

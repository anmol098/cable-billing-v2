/**
 * Unit tests for the auth building blocks that need no database: argon2id hashing, the rate
 * limiters (memory and Upstash REST), the email transports, the sign-in policy, safe redirects
 * and header parsing.
 */
import { describe, expect, it } from "vitest";
import { createCaptureTransport, createResendTransport } from "./email";
import { hashPassword, verifyPassword } from "./password";
import {
  LOGIN_PATH,
  postSignInPath,
  ROLE_HOME,
  type SignInSubject,
  safeNextPath,
  webSignInBlock,
} from "./policy";
import {
  createMemoryRateLimiter,
  createUpstashRateLimiter,
  rateLimitKey,
  UPSTASH_FIXED_WINDOW_SCRIPT,
} from "./rate-limit";
import { clientInfo, clientIp, requestIdFromHeaders } from "./request-info";

describe("password hashing (argon2id)", () => {
  it("hashes with argon2id, OWASP parameters and a fresh salt; verifies", async () => {
    const a = await hashPassword("correct horse 42");
    const b = await hashPassword("correct horse 42");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
    expect(await verifyPassword({ hash: a, password: "correct horse 42" })).toBe(true);
    expect(await verifyPassword({ hash: a, password: "correct horse 43" })).toBe(false);
  });

  it("never trusts a non-argon2 (legacy) hash and never throws", async () => {
    for (const legacy of [
      "5f4dcc3b5aa765d61d8327deb882cf99", // md5("password")
      "$2b$10$abcdefghijklmnopqrstuuJ1gY6rJ9F1a1x0n0y6c5ZQ7f1Yz9V8q",
      "",
      "$argon2id$v=19$m=19456,t=2,p=1$broken",
    ]) {
      expect(await verifyPassword({ hash: legacy, password: "password" })).toBe(false);
    }
  });
});

describe("memory rate limiter", () => {
  it("allows `limit` hits per window, then refuses with a retry time, then resets", async () => {
    let now = 1_000_000;
    const limiter = createMemoryRateLimiter({ now: () => now });
    const rule = { limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i += 1) {
      expect(await limiter.hit("k", rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    expect(await limiter.hit("k", rule)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    now += 59_000;
    expect(await limiter.hit("k", rule)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect((await limiter.hit("other", rule)).allowed).toBe(true);
    now += 1_000;
    expect((await limiter.hit("k", rule)).allowed).toBe(true);
  });

  it("prunes expired windows when full", async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter({ now: () => now, maxKeys: 2 });
    const rule = { limit: 1, windowSeconds: 1 };
    await limiter.hit("a", rule);
    await limiter.hit("b", rule);
    now = 5_000;
    await limiter.hit("c", rule);
    expect((await limiter.hit("a", rule)).allowed).toBe(true);
  });

  it("hashes the identifying part of a key", () => {
    const key = rateLimitKey("signin:login", "ramesh@example.com");
    expect(key).toMatch(/^signin:login:[0-9a-f]{32}$/);
    expect(key).not.toContain("ramesh");
    expect(rateLimitKey("signin:login", "ramesh@example.com")).toBe(key);
  });
});

describe("Upstash rate limiter (REST)", () => {
  const fakeFetch = (result: unknown, status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(result), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  it("sends one atomic EVAL with the prefixed key and window, and reads count/ttl", async () => {
    const { calls, fetchFn } = fakeFetch({ result: [4, 42_500] });
    const limiter = createUpstashRateLimiter({
      url: "https://eu1-example.upstash.io/",
      token: "secret-token",
      fetch: fetchFn,
    });
    const result = await limiter.hit("signin:ip:abc", { limit: 3, windowSeconds: 900 });
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 43 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://eu1-example.upstash.io");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer secret-token");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual([
      "EVAL",
      UPSTASH_FIXED_WINDOW_SCRIPT,
      "1",
      "cb:rl:signin:ip:abc",
      "900000",
    ]);
    const ok = createUpstashRateLimiter({
      url: "https://x.upstash.io",
      token: "t",
      fetch: fakeFetch({ result: [1, 900_000] }).fetchFn,
    });
    expect(await ok.hit("k", { limit: 3, windowSeconds: 900 })).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it("rejects on HTTP errors and malformed results (the caller fails open and logs)", async () => {
    const http = createUpstashRateLimiter({
      url: "https://x.upstash.io",
      token: "t",
      fetch: fakeFetch({ error: "nope" }, 401).fetchFn,
    });
    await expect(http.hit("k", { limit: 1, windowSeconds: 1 })).rejects.toThrow(/HTTP 401/);
    const odd = createUpstashRateLimiter({
      url: "https://x.upstash.io",
      token: "t",
      fetch: fakeFetch({ result: "OK" }).fetchFn,
    });
    await expect(odd.hit("k", { limit: 1, windowSeconds: 1 })).rejects.toThrow(/unexpected/);
  });
});

describe("email transports", () => {
  it("Resend: posts the message as JSON with the API key; errors carry no address", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const transport = createResendTransport({
      apiKey: "re_test_123",
      from: "Cable Billing <noreply@example.com>",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}", { status });
      }) as unknown as typeof fetch,
    });
    await transport.send({ to: "owner@cable.test", subject: "Reset", text: "Link" });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer re_test_123");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: "Cable Billing <noreply@example.com>",
      to: ["owner@cable.test"],
      subject: "Reset",
      text: "Link",
    });
    status = 422;
    const failure = await transport
      .send({ to: "owner@cable.test", subject: "Reset", text: "Link" })
      .catch((e: Error) => e);
    expect(String(failure)).toMatch(/HTTP 422/);
    expect(String(failure)).not.toContain("owner@cable.test");
  });

  it("capture: keeps messages for tests and local development", async () => {
    const seen: string[] = [];
    const capture = createCaptureTransport({ onSend: (m) => seen.push(m.subject) });
    await capture.send({ to: "A@x.test", subject: "one", text: "1" });
    await capture.send({ to: "a@x.test", subject: "two", text: "2" });
    expect(capture.messages).toHaveLength(2);
    expect(capture.lastTo("a@X.test")?.subject).toBe("two");
    expect(seen).toEqual(["one", "two"]);
    capture.clear();
    expect(capture.messages).toHaveLength(0);
  });
});

describe("web sign-in policy", () => {
  const subject = (overrides: Partial<SignInSubject>): SignInSubject => ({
    role: "owner",
    status: "active",
    operatorId: "0190a5c4-0000-7000-8000-000000000001",
    operatorStatus: "active",
    ...overrides,
  });

  it("allows owners, staff and platform admins; never linemen; never disabled users", () => {
    expect(webSignInBlock(subject({}))).toBeNull();
    expect(webSignInBlock(subject({ role: "staff" }))).toBeNull();
    expect(
      webSignInBlock(subject({ role: "platform_admin", operatorId: null, operatorStatus: null })),
    ).toBeNull();
    expect(webSignInBlock(subject({ role: "lineman" }))).toBe("role_not_allowed");
    expect(webSignInBlock(subject({ role: "lineman", status: "disabled" }))).toBe("user_disabled");
    expect(webSignInBlock(subject({ status: "disabled" }))).toBe("user_disabled");
    expect(
      webSignInBlock(subject({ role: "platform_admin", operatorId: null, status: "disabled" })),
    ).toBe("user_disabled");
    expect(webSignInBlock(subject({ operatorStatus: "suspended" }))).toBe("operator_suspended");
    expect(webSignInBlock(subject({ operatorId: null, operatorStatus: null }))).toBe(
      "role_not_allowed",
    );
    expect(webSignInBlock(subject({ role: "platform_admin" }))).toBe("role_not_allowed");
  });

  it("only follows same-site paths after sign-in, and keeps each role on its side", () => {
    for (const bad of [
      "https://evil.test/x",
      "//evil.test",
      "/\\evil.test",
      "javascript:alert(1)",
      "customers",
      "",
      "/login",
      "/login/2fa",
      "/reset/abc",
      "/x\ny",
      42,
      undefined,
      `/${"a".repeat(600)}`,
    ]) {
      expect(safeNextPath(bad)).toBeNull();
    }
    expect(safeNextPath("/customers?q=ram#top")).toBe("/customers?q=ram#top");
    expect(postSignInPath("owner", "/customers/123")).toBe("/customers/123");
    expect(postSignInPath("staff", "/admin/tenants")).toBe(ROLE_HOME.staff);
    expect(postSignInPath("owner", "//evil.test")).toBe(ROLE_HOME.owner);
    expect(postSignInPath("platform_admin", "/customers")).toBe(ROLE_HOME.platform_admin);
    expect(postSignInPath("platform_admin", "/admin/jobs")).toBe("/admin/jobs");
    expect(postSignInPath("owner", undefined)).toBe("/home");
    expect(LOGIN_PATH).toBe("/login");
  });
});

describe("request info", () => {
  it("reads the client IP from x-real-ip, else the first x-forwarded-for entry", () => {
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.6, 10.0.0.1" }))).toBe(
      "203.0.113.6",
    );
    expect(clientIp(new Headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(new Headers({ "x-real-ip": "not an ip" }))).toBeUndefined();
    expect(clientIp(new Headers())).toBeUndefined();
    expect(
      clientInfo(new Headers({ "x-real-ip": "203.0.113.5", "user-agent": "x".repeat(600) })),
    ).toEqual({ ip: "203.0.113.5", userAgent: "x".repeat(512) });
  });

  it("uses Vercel's request id only, never a client-chosen header", () => {
    expect(requestIdFromHeaders(new Headers({ "x-vercel-id": "bom1::abc-123" }))).toBe(
      "bom1::abc-123",
    );
    const fresh = requestIdFromHeaders(new Headers({ "x-request-id": "client-chosen" }));
    expect(fresh).not.toBe("client-chosen");
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
    // An invalid id is replaced by a fresh UUID. (Not `.not.toContain("bad")`: a random hex UUID
    // contains "bad" about 1% of the time.)
    const replaced = requestIdFromHeaders(new Headers({ "x-vercel-id": "bad id\n" }));
    expect(replaced).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(replaced).not.toBe("bad id\n");
  });
});

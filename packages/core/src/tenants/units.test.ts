/**
 * Pure parts of sign-up and provisioning (T-027): the trial end rule (IST), mobile numbers,
 * owner logins, field validation, link identifiers and the Turnstile verifier's request.
 */
import { describe, expect, it } from "vitest";
import { createTurnstileVerifier, disabledBotCheck, TURNSTILE_VERIFY_URL } from "./bot-check";
import {
  MAX_LOGIN_CANDIDATES,
  normalizeIndianMobile,
  ownerLoginCandidates,
  trialEndsAt,
  trialLastDay,
} from "./rules";
import { SIGNUP_IDENTIFIER_PREFIX, signupIdentifier, validateSignupFields } from "./signup";

describe("trial end (D-20, IST)", () => {
  it("ends at 00:00 IST after the 30th IST day following the sign-up day", () => {
    // 13 Oct 2026, 10:00 IST.
    const now = new Date("2026-10-13T04:30:00Z");
    expect(trialLastDay(now)).toBe("2026-11-12");
    expect(trialEndsAt(now).toISOString()).toBe("2026-11-12T18:30:00.000Z");
  });

  it("uses the IST date, not the UTC date, around midnight", () => {
    // 13 Oct 23:59 IST (still 13 Oct in IST, 18:29 UTC).
    expect(trialLastDay(new Date("2026-10-13T18:29:59Z"))).toBe("2026-11-12");
    // 14 Oct 00:00 IST (13 Oct 18:30 UTC): already the next IST day.
    expect(trialLastDay(new Date("2026-10-13T18:30:00Z"))).toBe("2026-11-13");
  });

  it("is never shorter than 30 × 24 hours and at most one day longer", () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    for (let minutes = 0; minutes < 2 * 24 * 60; minutes += 37) {
      const now = new Date(start + minutes * 60_000);
      const length = trialEndsAt(now).getTime() - now.getTime();
      expect(length).toBeGreaterThanOrEqual(30 * 86_400_000);
      expect(length).toBeLessThanOrEqual(31 * 86_400_000);
    }
  });

  it("crosses months and leap days; takes other lengths; refuses nonsense", () => {
    expect(trialLastDay(new Date("2028-02-10T06:00:00Z"))).toBe("2028-03-11");
    expect(trialLastDay(new Date("2026-10-13T06:00:00Z"), 0)).toBe("2026-10-13");
    expect(trialEndsAt(new Date("2026-10-13T06:00:00Z"), 0).toISOString()).toBe(
      "2026-10-13T18:30:00.000Z",
    );
    expect(() => trialEndsAt(new Date(), -1)).toThrow(RangeError);
    expect(() => trialEndsAt(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe("normalizeIndianMobile", () => {
  it("accepts what people type", () => {
    for (const typed of [
      "9876543210",
      "98765 43210",
      "+91 98765-43210",
      "+919876543210",
      "919876543210",
      "09876543210",
      "(98765) 43210",
    ]) {
      expect(normalizeIndianMobile(typed), typed).toBe("9876543210");
    }
  });

  it("refuses landlines, short and long numbers, letters", () => {
    for (const typed of [
      "5876543210",
      "987654321",
      "98765432100",
      "98765abcde",
      "",
      "+1 9876543210",
    ]) {
      expect(normalizeIndianMobile(typed), typed).toBeNull();
    }
  });
});

describe("ownerLoginCandidates", () => {
  it("is the mobile number first, then numbered variants that fit the login rule", () => {
    const candidates = ownerLoginCandidates("9876543210");
    expect(candidates).toHaveLength(MAX_LOGIN_CANDIDATES);
    expect(candidates.slice(0, 3)).toEqual(["9876543210", "9876543210-2", "9876543210-3"]);
    for (const login of candidates) expect(login).toMatch(/^[^\s@A-Z]{3,100}$/);
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("validateSignupFields", () => {
  const good = {
    businessName: "  Anmol   Cable  Network ",
    ownerName: "Anmol  Singh",
    mobile: "+91 98765 43210",
    email: "  Owner@Example.IN ",
    password: "long enough",
  };

  it("normalises a good form", () => {
    expect(validateSignupFields(good)).toEqual({
      ok: true,
      value: {
        businessName: "Anmol Cable Network",
        ownerName: "Anmol Singh",
        mobile: "9876543210",
        email: "owner@example.in",
        password: "long enough",
      },
    });
  });

  it("names every problem field, never the values", () => {
    expect(
      validateSignupFields({
        businessName: " ",
        ownerName: "x".repeat(121),
        mobile: "12345",
        email: "not-an-email",
        password: "short",
      }),
    ).toEqual({
      ok: false,
      error: {
        business_name: "required",
        owner_name: "too_long",
        mobile: "invalid",
        email: "invalid",
        password: "too_short",
      },
    });
    expect(
      validateSignupFields({ ...good, mobile: "", email: "", password: "p".repeat(129) }),
    ).toEqual({
      ok: false,
      error: { mobile: "required", email: "required", password: "too_long" },
    });
  });
});

describe("signupIdentifier", () => {
  it("stores only a hash of the link token", () => {
    const token = "a".repeat(43);
    const identifier = signupIdentifier(token);
    expect(identifier.startsWith(SIGNUP_IDENTIFIER_PREFIX)).toBe(true);
    expect(identifier).toMatch(/^signup:[0-9a-f]{64}$/);
    expect(identifier).not.toContain(token);
    expect(signupIdentifier(token)).toBe(identifier);
    expect(signupIdentifier("b".repeat(43))).not.toBe(identifier);
  });
});

describe("Turnstile verifier", () => {
  it("posts the secret, token and IP to siteverify and reads `success`", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const verifier = createTurnstileVerifier({
      secret: "test-secret",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch,
    });
    expect(verifier.kind).toBe("turnstile");
    await expect(verifier.verify({ token: "tok", ip: "203.0.113.9" })).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(calls[0]?.init.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(Object.fromEntries(body)).toEqual({
      secret: "test-secret",
      response: "tok",
      remoteip: "203.0.113.9",
    });
  });

  it("says no for a failed check or an empty token; throws on an outage", async () => {
    const answer = (status: number, body: unknown) =>
      createTurnstileVerifier({
        secret: "s",
        fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
      });
    await expect(
      answer(200, { success: false, "error-codes": ["invalid-input-response"] }).verify({
        token: "tok",
      }),
    ).resolves.toBe(false);
    await expect(answer(200, { success: true }).verify({ token: "" })).resolves.toBe(false);
    await expect(answer(500, {}).verify({ token: "tok" })).rejects.toThrow(/HTTP 500/);
  });

  it("the disabled check passes everything (local and tests only)", async () => {
    const check = disabledBotCheck();
    expect(check.kind).toBe("disabled");
    await expect(check.verify({ token: "" })).resolves.toBe(true);
  });
});

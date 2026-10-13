/**
 * Pure parts of mobile auth (T-028): the access-token format, refresh-token hashing, the version
 * gate and device codes. The database flows are in ./mobile-auth.test.ts.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { uuidv7 } from "@cb/db";
import { describe, expect, it } from "vitest";
import {
  DEVICE_CODE_ALPHABET,
  DEVICE_CODE_LENGTH,
  pickFreeDeviceCode,
  randomDeviceCode,
} from "./device-code";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createAccessTokenSigner,
  hashRefreshToken,
  newRefreshToken,
} from "./tokens";
import { checkAppVersion, parseAppVersionCode } from "./version-gate";

const SECRET = "t028-unit-secret-not-for-production-0123456789";
const NOW = new Date("2026-10-13T04:30:00.000Z");

const claims = () => ({
  sub: uuidv7(),
  op: uuidv7(),
  dev: uuidv7(),
  fam: uuidv7(),
  role: "lineman" as const,
});

const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe("access tokens", () => {
  const signer = createAccessTokenSigner(SECRET);

  it("round-trips the claims and expires exactly 15 minutes after issue", () => {
    const c = claims();
    const { token, expiresAt } = signer.issue(c, NOW);
    expect(token).toMatch(/^cbm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.toISOString()).toBe("2026-10-13T04:45:00.000Z");
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);

    const ok = signer.verify(token, at(ACCESS_TOKEN_TTL_SECONDS - 1));
    expect(ok).toEqual({
      ok: true,
      claims: { ...c, iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 900 },
    });
    expect(signer.verify(token, at(ACCESS_TOKEN_TTL_SECONDS))).toEqual({
      ok: false,
      problem: "expired",
    });
    expect(signer.verify(token, at(86_400))).toEqual({ ok: false, problem: "expired" });
  });

  it("refuses any change to the payload or the signature", () => {
    const { token } = signer.issue(claims(), NOW);
    const [prefix, payload = "", signature = ""] = token.split(".");
    // Swap the user id for another one, keeping the signature.
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...decoded, sub: uuidv7() })).toString("base64url");
    expect(signer.verify(`${prefix}.${forged}.${signature}`, NOW)).toEqual({
      ok: false,
      problem: "bad_signature",
    });
    // Extend the expiry.
    const later = Buffer.from(JSON.stringify({ ...decoded, exp: decoded.exp + 3600 })).toString(
      "base64url",
    );
    expect(signer.verify(`${prefix}.${later}.${signature}`, NOW).ok).toBe(false);
    // Flip one signature character.
    const flipped = `${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.at(-1)}`;
    expect(signer.verify(`${prefix}.${payload}.${flipped}`, NOW)).toEqual({
      ok: false,
      problem: "bad_signature",
    });
  });

  it("refuses tokens signed with another secret", () => {
    const other = createAccessTokenSigner(`${SECRET}-other`);
    const { token } = other.issue(claims(), NOW);
    expect(signer.verify(token, NOW)).toEqual({ ok: false, problem: "bad_signature" });
  });

  it("refuses malformed tokens without throwing", () => {
    const { token } = signer.issue(claims(), NOW);
    const [, payload, signature] = token.split(".");
    for (const bad of [
      "",
      "abc",
      "a.b.c",
      `cbm2.${payload}.${signature}`,
      `cbm1.${payload}`,
      `cbm1.${payload}.${signature}.x`,
      `cbm1..${signature}`,
      `cbm1.${payload}.short`,
      `eyJhbGciOiJub25lIn0.${payload}.`,
      "x".repeat(5000),
    ]) {
      expect(signer.verify(bad, NOW).ok, bad.slice(0, 40)).toBe(false);
    }
  });

  it("refuses a correctly signed payload whose claims are wrong", () => {
    // Sign like the server does (HKDF-derived key, HMAC-SHA256 over "cbm1.<payload>").
    const key = Buffer.from(
      hkdfSync("sha256", SECRET, "cable-billing", "cb.mobile.access-token.v1", 32),
    );
    const sign = (payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const mac = createHmac("sha256", key).update(`cbm1.${body}`).digest("base64url");
      return `cbm1.${body}.${mac}`;
    };
    const iat = NOW.getTime() / 1000;
    const good = { ...claims(), iat, exp: iat + 900 };
    // The hand-made signer is right: a good payload verifies (so the refusals below are real).
    expect(signer.verify(sign(good), NOW)).toEqual({ ok: true, claims: good });
    for (const bad of [
      { ...good, role: "owner" },
      { ...good, sub: "not-a-uuid" },
      { ...good, fam: undefined },
      { ...good, exp: iat + 901 },
      { ...good, exp: iat },
      { ...good, iat: "x" },
      [good],
      "token",
    ]) {
      expect(signer.verify(sign(bad), NOW), JSON.stringify(bad)).toEqual({
        ok: false,
        problem: "malformed",
      });
    }
  });

  it("needs a secret of at least 32 characters", () => {
    expect(() => createAccessTokenSigner("short")).toThrow(/at least 32/);
    expect(() => createAccessTokenSigner("x".repeat(32))).not.toThrow();
  });
});

describe("refresh tokens", () => {
  it("are 256-bit random base64url values, stored as hex SHA-256", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newRefreshToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const hash = hashRefreshToken(token);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    }
  });
});

describe("version gate", () => {
  it("parses only plain positive decimal versionCodes", () => {
    expect(parseAppVersionCode("12")).toBe(12);
    expect(parseAppVersionCode(" 7 ")).toBe(7);
    for (const bad of [null, undefined, "", "0", "-1", "1.2", "012", "1e3", "abc", "99999999999"]) {
      expect(parseAppVersionCode(bad), String(bad)).toBeNull();
    }
  });

  it("answers APP_TOO_OLD below the minimum, VALIDATION without a header, and never on ungated endpoints", () => {
    const headers = (value?: string) =>
      new Headers(value === undefined ? {} : { "x-app-version-code": value });
    const gated = { gated: true, minAppVersionCode: 5 };
    expect(checkAppVersion(headers("5"), gated)).toEqual({ ok: true, appVersionCode: 5 });
    expect(checkAppVersion(headers("4"), gated)).toEqual({
      ok: false,
      code: "APP_TOO_OLD",
      minAppVersionCode: 5,
    });
    expect(checkAppVersion(headers(), gated)).toEqual({ ok: false, code: "VALIDATION" });
    expect(checkAppVersion(headers("x"), gated)).toEqual({ ok: false, code: "VALIDATION" });

    const open = { gated: false, minAppVersionCode: 5 };
    expect(checkAppVersion(headers("1"), open)).toEqual({ ok: true, appVersionCode: 1 });
    expect(checkAppVersion(headers(), open)).toEqual({ ok: true, appVersionCode: null });
  });
});

describe("device codes", () => {
  it("uses three unambiguous characters that match the DB rule", () => {
    expect(DEVICE_CODE_ALPHABET).not.toMatch(/[01IO]/);
    for (let i = 0; i < 500; i += 1) {
      const code = randomDeviceCode();
      expect(code).toMatch(/^[A-Z0-9]{3}$/);
      expect([...code].every((c) => DEVICE_CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it("picks a free code even when almost every code is taken, and null when none is left", () => {
    const n = DEVICE_CODE_ALPHABET.length;
    const all: string[] = [];
    for (let i = 0; i < n ** DEVICE_CODE_LENGTH; i += 1) {
      let value = i;
      let code = "";
      for (let d = 0; d < DEVICE_CODE_LENGTH; d += 1) {
        code = DEVICE_CODE_ALPHABET[value % n] + code;
        value = Math.floor(value / n);
      }
      all.push(code);
    }
    const free = all[12_345] ?? "";
    const taken = new Set(all.filter((code) => code !== free));
    expect(pickFreeDeviceCode(taken)).toBe(free);
    expect(pickFreeDeviceCode(new Set(all))).toBeNull();
  });
});

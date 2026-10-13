/**
 * Mobile tokens (PLAN §9.2, D-07): a 15-minute **access token** and a 180-day sliding, single-use
 * **refresh token** per signed-in phone.
 *
 * **Access token: a stateless, HMAC-SHA256-signed token** (`cbm1.<payload>.<mac>`, both parts
 * base64url). The payload carries the user, operator, device, token family and role, plus issue
 * and expiry times. Why this format:
 * - Stateless verification (no table, no write per request) for a token that lives 15 minutes;
 *   every request still re-reads the user, operator, device and token family from the database
 *   (`authenticate`), so a deactivation, a revoked phone or a logout takes effect at once.
 * - One fixed algorithm and no header: unlike a JWT there is no `alg` to negotiate (no `none` /
 *   algorithm-confusion class of bugs) and no library. We are the only issuer and verifier; the
 *   app treats the token as opaque (contract `TokenPair.access_token`).
 * - The key is derived with HKDF from `BETTER_AUTH_SECRET` with its own label, so it differs from
 *   every key Better Auth derives and no new secret has to be provisioned. Rotating the secret
 *   invalidates outstanding access tokens; phones just refresh (refresh tokens are random values
 *   in the database, unaffected).
 *
 * **Refresh token:** 32 random bytes (base64url). Only `hex(SHA-256(token))` is stored (the DB
 * CHECK refuses anything else). High-entropy random values need no salt or slow hash.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { isUuid } from "@cb/db";

/** Access tokens live 15 minutes (PLAN §9.2). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Refresh tokens expire 180 days after their last use (sliding, PLAN §9.2). */
export const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
/**
 * How long after a rotation the **immediately previous** refresh token is still accepted once,
 * provided its successor was never used and the same installation presents it (T-063 follow-up:
 * a refresh whose response was lost must not sign the phone out). See `refresh` in
 * ./mobile-auth.ts for the exact rule.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 5 * 60;

/** Shortest secret accepted (BETTER_AUTH_SECRET's minimum in the env schema). */
export const MIN_TOKEN_SECRET_LENGTH = 32;

const PREFIX = "cbm1";
const MAX_TOKEN_LENGTH = 1024;
const HKDF_SALT = "cable-billing";
const HKDF_INFO = "cb.mobile.access-token.v1";

/** What an access token says. Short keys keep the token small. */
export interface AccessTokenClaims {
  /** User id. */
  readonly sub: string;
  /** Operator (tenant) id. */
  readonly op: string;
  /** Device id (`devices.id`). */
  readonly dev: string;
  /** Refresh-token family the token was issued from (one per sign-in on a phone). */
  readonly fam: string;
  /** Always `lineman` today; the role is re-read from the database on every request anyway. */
  readonly role: "lineman";
  /** Issued at, Unix seconds. */
  readonly iat: number;
  /** Expires at, Unix seconds. */
  readonly exp: number;
}

export type AccessTokenProblem = "malformed" | "bad_signature" | "expired";

export interface AccessTokenSigner {
  /** Signs a token for `claims` (without `iat`/`exp`), valid {@link ACCESS_TOKEN_TTL_SECONDS}. */
  issue(
    claims: Omit<AccessTokenClaims, "iat" | "exp">,
    now: Date,
  ): {
    token: string;
    expiresAt: Date;
  };
  /** Verifies the signature and the expiry. Never throws. */
  verify(
    token: string,
    now: Date,
  ): { ok: true; claims: AccessTokenClaims } | { ok: false; problem: AccessTokenProblem };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/** Builds the signer for `secret` (`BETTER_AUTH_SECRET`). */
export function createAccessTokenSigner(secret: string): AccessTokenSigner {
  if (typeof secret !== "string" || secret.length < MIN_TOKEN_SECRET_LENGTH) {
    throw new TypeError(
      `mobile access token secret must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`,
    );
  }
  const key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32));
  const mac = (signingInput: string) => createHmac("sha256", key).update(signingInput).digest();

  return {
    issue(claims, now) {
      const iat = Math.floor(now.getTime() / 1000);
      const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
      const payload = base64url(
        JSON.stringify({
          sub: claims.sub,
          op: claims.op,
          dev: claims.dev,
          fam: claims.fam,
          role: claims.role,
          iat,
          exp,
        }),
      );
      const signingInput = `${PREFIX}.${payload}`;
      return {
        token: `${signingInput}.${base64url(mac(signingInput))}`,
        expiresAt: new Date(exp * 1000),
      };
    },

    verify(token, now) {
      if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, problem: "malformed" };
      }
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, problem: "malformed" };
      const [, payload = "", signature = ""] = parts;
      if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
        return { ok: false, problem: "malformed" };
      }
      const expected = mac(`${PREFIX}.${payload}`);
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, problem: "bad_signature" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return { ok: false, problem: "malformed" };
      }
      const claims = asClaims(parsed);
      if (!claims) return { ok: false, problem: "malformed" };
      if (Math.floor(now.getTime() / 1000) >= claims.exp) return { ok: false, problem: "expired" };
      return { ok: true, claims };
    },
  };
}

function asClaims(value: unknown): AccessTokenClaims | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const ids = [v.sub, v.op, v.dev, v.fam];
  if (!ids.every((id) => typeof id === "string" && isUuid(id))) return null;
  if (v.role !== "lineman") return null;
  if (!Number.isSafeInteger(v.iat) || !Number.isSafeInteger(v.exp)) return null;
  const iat = v.iat as number;
  const exp = v.exp as number;
  if (exp <= iat || exp - iat > ACCESS_TOKEN_TTL_SECONDS) return null;
  return {
    sub: v.sub as string,
    op: v.op as string,
    dev: v.dev as string,
    fam: v.fam as string,
    role: "lineman",
    iat,
    exp,
  };
}

/** A new refresh token: 256 random bits, base64url (43 characters). */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `hex(SHA-256(token))`: what `mobile_refresh_tokens.token_hash` stores. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `now + seconds`. */
export function addSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

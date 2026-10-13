/**
 * Redaction of audit `before`/`after` values (PLAN §7.2 "Sensitive fields redacted", T-021).
 *
 * The audit trail is tenant data that the Owner reads (T-035), so it may hold business values the
 * Owner already sees (a customer's old and new phone, FR-004). It must never hold credentials or
 * secrets, nor full identity documents: passwords and their hashes, tokens (session, refresh,
 * receipt-link), OTP/TOTP secrets, API keys, cookies, and KYC documents (Aadhaar/PAN numbers).
 * Those keys are replaced by {@link REDACTED}, at any depth.
 */

export const REDACTED = "[redacted]";

const SENSITIVE_KEY_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "hash",
  "secret",
  "token",
  "tokens",
  "otp",
  "totp",
  "cookie",
  "cookies",
  "authorization",
  "apikey",
  "api_key",
  "kyc",
  "aadhaar",
  "aadhar",
  "pan",
]);

function snake(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

/** True when a key in an audit diff must be redacted. */
export function isSensitiveAuditKey(key: string): boolean {
  const s = snake(key);
  if (SENSITIVE_KEY_WORDS.has(s)) return true;
  return s.split("_").some((part) => SENSITIVE_KEY_WORDS.has(part));
}

/**
 * A JSON-safe deep copy of `value` with sensitive keys redacted. Dates become ISO strings, bigints
 * strings; functions and undefined are dropped (as JSON does). Depth is bounded.
 */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (Array.isArray(value)) return value.map((item) => redactForAudit(item, depth + 1) ?? null);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveAuditKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      const copy = redactForAudit(nested, depth + 1);
      if (copy !== undefined) out[key] = copy;
    }
    return out;
  }
  return value;
}

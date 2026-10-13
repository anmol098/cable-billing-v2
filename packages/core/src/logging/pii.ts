/**
 * PII detection for logs (PLAN §17: structured JSON logs with operator_id/request_id, no PII).
 *
 * Logs may carry ids (operator_id, user_id, customer_id …), codes, counts, amounts and durations.
 * They must never carry names, phone numbers, emails, addresses, logins, passwords, tokens,
 * cookies, IPs, user agents, UPI references or free-text notes. Two independent checks:
 *
 * 1. **Key names.** A field whose name (camelCase or snake_case) contains a PII word is refused,
 *    whatever its value.
 * 2. **String values.** Values that look like an email, an Indian mobile number, a JWT/bearer
 *    token or a long secret are refused, whatever the key.
 *
 * Numbers are never inspected (amounts in paise can look like phone numbers).
 */

/** Words that make a key PII. Matched against the key's snake_case parts. */
const PII_KEY_WORDS = new Set([
  "name",
  "names",
  "phone",
  "phones",
  "mobile",
  "msisdn",
  "email",
  "emails",
  "mail",
  "address",
  "addresses",
  "login",
  "username",
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "tokens",
  "otp",
  "totp",
  "pin",
  "cookie",
  "cookies",
  "authorization",
  "auth",
  "session",
  "ip",
  "agent",
  "upi",
  "note",
  "notes",
  "kyc",
  "aadhaar",
  "aadhar",
  "pan",
  "gstin",
  "dob",
  "birth",
]);

/** Keys that contain a PII word but are not PII. Keep this list short and reviewed. */
const SAFE_KEYS = new Set([
  "error_name",
  "constraint_name",
  "table_name",
  "column_name",
  "job_name",
  "service_name",
  "session_id", // an opaque id (collection session), not a sign-in session token
]);

/** `customerPhone` → `customer_phone`; `X-Auth-Token` → `x_auth_token`. */
export function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** True when a field with this key would log personal data or a secret. */
export function isPiiKey(key: string): boolean {
  const snake = toSnakeCase(key);
  if (SAFE_KEYS.has(snake)) return false;
  return snake.split("_").some((part) => PII_KEY_WORDS.has(part));
}

const VALUE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // Indian mobile: 10 digits starting 6–9, optionally +91/91/0 and a separator.
  {
    kind: "phone",
    pattern: /(?<![0-9])(?:(?:\+|00)?91[ -]?|0)?[6-9][0-9]{4}[ -]?[0-9]{5}(?![0-9])/,
  },
  { kind: "jwt", pattern: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/ },
  { kind: "bearer", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i },
  // Long unbroken base64/hex runs with letters and digits: raw tokens, token hashes, API keys.
  // (Long snake_case words have no digits, so they don't match.)
  {
    kind: "secret",
    pattern: /(?=[A-Za-z0-9_+/]*[0-9])(?=[A-Za-z0-9_+/]*[A-Za-z])[A-Za-z0-9_+/]{32,}/,
  },
];

/** UUIDs are ids, never PII; they are removed before the value patterns run. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The kind of PII a string looks like, or undefined. */
export function piiKindOfValue(value: string): string | undefined {
  const withoutIds = value.replace(UUID, "-");
  for (const { kind, pattern } of VALUE_PATTERNS) {
    if (pattern.test(withoutIds)) return kind;
  }
  return undefined;
}

/** Replaces PII-looking parts of free text (e.g. an exception message) with `[redacted:<kind>]`. */
export function scrubText(text: string): string {
  // Split around UUIDs (kept as they are) and scrub only the text between them.
  const parts = text.split(new RegExp(`(${UUID.source})`, "i"));
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // a UUID
      let result = part;
      for (const { kind, pattern } of VALUE_PATTERNS) {
        const global = new RegExp(pattern.source, `${pattern.flags}g`);
        result = result.replace(global, `[redacted:${kind}]`);
      }
      return result;
    })
    .join("");
}

/** One PII finding: where it is (dotted path) and why. Never the value. */
export interface PiiFinding {
  readonly path: string;
  readonly reason: string;
}

/**
 * Walks a log payload and returns every PII finding. `maxDepth` bounds nested objects; deeper
 * content is reported as a finding too (log flat fields, not object dumps).
 */
export function findPii(fields: Readonly<Record<string, unknown>>, maxDepth = 4): PiiFinding[] {
  const findings: PiiFinding[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (typeof value === "string") {
      const kind = piiKindOfValue(value);
      if (kind) findings.push({ path, reason: `value looks like ${kind}` });
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (depth >= maxDepth) {
      findings.push({ path, reason: "nested too deep" });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, `${path}[${index}]`, depth + 1);
      });
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = path ? `${path}.${key}` : key;
      if (isPiiKey(key)) {
        findings.push({ path: nestedPath, reason: "key names personal data or a secret" });
        continue;
      }
      visit(nested, nestedPath, depth + 1);
    }
  };
  visit(fields, "", 0);
  return findings;
}

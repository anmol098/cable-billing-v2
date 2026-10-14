/**
 * The before/after change list the audit viewer shows (T-035), made safe on the server so the page
 * never receives a secret or a full phone number.
 *
 * The writer (`redactForAudit`, T-025) already replaced credentials, hashes, tokens, OTP, cookies,
 * API keys and KYC with `[redacted]`. The viewer applies its own, stricter rules on top (old rows,
 * imported rows and future writers are not trusted to have done it):
 *
 * 1. **Hidden** (shown as "Hidden", the value never leaves the server): every key the writer
 *    redacts ({@link isSensitiveAuditKey}), the {@link AUDIT_VIEW_HIDDEN_KEYS} (network and
 *    session identifiers), and any value equal to `[redacted]`.
 * 2. **Phones masked** to the last four digits (`XXXXXX3210`, the receipt page's rule, PLAN §9.4):
 *    keys that name a phone or mobile, and phone-like digit runs inside any other text (a lineman's
 *    user name is often their mobile number).
 * 3. **Emails masked** (`r•••@example.com`): keys that name an email, and emails inside any text.
 * 4. **Ids dropped**: UUID values and `*_id` fields are internal; the sentence names the thing.
 * 5. Long text is cut, nested lists are counted, and at most {@link MAX_CHANGES} rows are shown.
 *
 * Amounts (`*_paise`) stay integer paise; the web shows whole rupees.
 */
import { isSensitiveAuditKey, REDACTED } from "../audit/redact";
import { maskPhone } from "../receipts/links/privacy";
import { snakeKey } from "./actions";

/** Keys the viewer never shows, beyond the writer's sensitive keys (snake_case). */
export const AUDIT_VIEW_HIDDEN_KEYS: readonly string[] = [
  "ip",
  "ip_address",
  "user_agent",
  "request_id",
  "install_id",
  "family_id",
  "session_id",
  "device_fingerprint",
  "push_id",
  "fcm",
];

/** At most this many change rows per event. */
export const MAX_CHANGES = 30;
/** Text longer than this is cut (with `…`). */
export const MAX_TEXT_LENGTH = 200;

/** One shown value of a change row. */
export type AuditShownValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "paise"; readonly value: number }
  | { readonly kind: "flag"; readonly value: boolean }
  /** A list or object: how many entries it has. */
  | { readonly kind: "items"; readonly value: number }
  /** `null` / missing. */
  | { readonly kind: "empty" }
  /** A secret or identifier the viewer never shows. */
  | { readonly kind: "hidden" };

export interface AuditChange {
  /** snake_case field name (`alt_phone`); nested fields are dotted (`kyc.type`). */
  readonly field: string;
  readonly before: AuditShownValue | null;
  readonly after: AuditShownValue | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_TEXT = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
/**
 * An Indian mobile number inside text: 10 digits starting 6–9 (single spaces or dashes allowed
 * between digits), optionally after `+91`, `91` or `0`, not part of a longer digit run. Dates
 * (`2026-10-01`) and receipt or bill numbers (`R-2610-00045`) don't match.
 */
const PHONE_IN_TEXT = /(?<![\d-])(?:\+?91[ -]?|0)?[6-9](?:[ -]?\d){9}(?![ -]?\d)/g;
/**
 * Business identifiers the Owner needs to read as they are, even when they look like a phone
 * (a VC number or a customer code can be 10 digits). Matched on the snake_case key.
 */
const IDENTIFIER_KEY =
  /^(vc_number|customer_code|receipt_number|invoice_number|provisional_ref|device_code|period|[a-z_]*_date|[a-z_]*_at)$/;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const HIDDEN = { kind: "hidden" } as const;
const EMPTY = { kind: "empty" } as const;

function isHiddenKey(snake: string): boolean {
  return isSensitiveAuditKey(snake) || AUDIT_VIEW_HIDDEN_KEYS.includes(snake);
}

function isPhoneKey(snake: string): boolean {
  return /(^|_)(phone|mobile|whatsapp|msisdn)(_|$)/.test(snake);
}

function isEmailKey(snake: string): boolean {
  return /(^|_)e?mail(_|$)/.test(snake);
}

/** `ramesh@example.com` → `r•••@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

/** Masks phones (last four digits kept) and emails inside free text; UUIDs are left alone. */
export function maskContactsInText(value: string): string {
  return value
    .split(UUID_IN_TEXT)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(EMAIL_IN_TEXT, (email) => maskEmail(email))
            .replace(PHONE_IN_TEXT, (run) => maskPhone(run) ?? "XXXXXX"),
    )
    .join("");
}

function cut(value: string): string {
  const chars = Array.from(value);
  return chars.length > MAX_TEXT_LENGTH ? `${chars.slice(0, MAX_TEXT_LENGTH).join("")}…` : value;
}

/**
 * The shown form of one value under `snake` (its snake_case key), or `undefined` when the row
 * should be left out (an id).
 */
export function presentAuditValue(snake: string, value: unknown): AuditShownValue | undefined {
  if (isHiddenKey(snake) || value === REDACTED) return HIDDEN;
  // Internal references (`plan_id`, `razorpay_subscription_id`): the sentence names the thing.
  if (/(^|_)id$/.test(snake) && (value === null || typeof value === "string")) return undefined;
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === "string") {
    if (UUID.test(value)) return undefined;
    if (isPhoneKey(snake)) {
      const masked = maskPhone(value);
      return masked === null
        ? value.trim() === ""
          ? EMPTY
          : HIDDEN
        : { kind: "text", value: masked };
    }
    if (isEmailKey(snake))
      return value.trim() === "" ? EMPTY : { kind: "text", value: maskEmail(value) };
    if (IDENTIFIER_KEY.test(snake)) return { kind: "text", value: cut(value) };
    return { kind: "text", value: cut(maskContactsInText(value)) };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return HIDDEN;
    if (snake.endsWith("_paise") && Number.isSafeInteger(value)) return { kind: "paise", value };
    // A number under a phone key is a phone number.
    if (isPhoneKey(snake)) {
      const masked = maskPhone(String(value));
      return masked === null ? HIDDEN : { kind: "text", value: masked };
    }
    return { kind: "number", value };
  }
  if (typeof value === "boolean") return { kind: "flag", value };
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => typeof v === "string" && UUID.test(v))) {
      return { kind: "items", value: value.length };
    }
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      if (isPhoneKey(snake)) return { kind: "items", value: value.length };
      return { kind: "text", value: cut(maskContactsInText(value.join(", "))) };
    }
    return { kind: "items", value: value.length };
  }
  if (typeof value === "object") return { kind: "items", value: Object.keys(value).length };
  return HIDDEN;
}

/** Flattens one level of nested objects (`kyc.type`) and normalises keys to snake_case. */
function flatten(obj: Readonly<Record<string, unknown>> | null): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!obj) return out;
  for (const [key, value] of Object.entries(obj)) {
    const snake = snakeKey(key);
    if (snake === "") continue;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !isHiddenKey(snake) &&
      Object.keys(value).length > 0 &&
      Object.keys(value).length <= 10
    ) {
      for (const [inner, innerValue] of Object.entries(value)) {
        const innerSnake = snakeKey(inner);
        if (innerSnake === "") continue;
        // A secret under a nested key is still a secret.
        out.set(`${snake}.${innerSnake}`, isHiddenKey(innerSnake) ? REDACTED : innerValue);
      }
    } else {
      out.set(snake, value);
    }
  }
  return out;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function same(a: AuditShownValue | null, b: AuditShownValue | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The change rows of an event: every field of `before` or `after`, with its shown values
 * (`null` on the side that does not have the field). A field whose shown values are equal on both
 * sides is left out; ids are left out.
 */
export function auditChanges(before: unknown, after: unknown): AuditChange[] {
  const b = flatten(asRecord(before));
  const a = flatten(asRecord(after));
  const fields = [...new Set([...b.keys(), ...a.keys()])];
  const rows: AuditChange[] = [];
  for (const name of fields) {
    const leaf = name.includes(".") ? (name.split(".").pop() ?? name) : name;
    const hiddenParent = name.includes(".") && isHiddenKey(name.split(".")[0] ?? "");
    const show = (side: Map<string, unknown>): AuditShownValue | null | undefined => {
      if (!side.has(name)) return null;
      if (hiddenParent) return HIDDEN;
      return presentAuditValue(leaf, side.get(name));
    };
    const shownBefore = show(b);
    const shownAfter = show(a);
    if (shownBefore === undefined || shownAfter === undefined) continue;
    if (shownBefore !== null && shownAfter !== null && same(shownBefore, shownAfter)) {
      // Unchanged and not a secret: leave it out. A hidden field that is on both sides still
      // says something changed (e.g. a new password), so keep that row.
      if (shownAfter.kind !== "hidden") continue;
    }
    rows.push({ field: name, before: shownBefore, after: shownAfter });
    if (rows.length >= MAX_CHANGES) break;
  }
  return rows;
}

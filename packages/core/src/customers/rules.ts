/**
 * Pure customer rules (T-033): field limits, phone clean-up, and how a search box query is read.
 * No database, no clock. The services in this folder use them; the web forms use the limits.
 */
import { MAX_CODE_LENGTH, normalizeCustomerCode, normalizeVcNumber, PHONE_PATTERN } from "@cb/db";

/** Longest values the forms and services accept (characters, after trimming). */
export const CUSTOMER_FIELD_LIMITS = Object.freeze({
  /** The normalised code (the database CHECK allows 64). */
  customerCode: MAX_CODE_LENGTH,
  name: 120,
  /** What people may type for a phone before it is cleaned up. */
  phoneInput: 30,
  address: 300,
  /** Search box text. */
  query: 100,
});

const PHONE_RE = new RegExp(PHONE_PATTERN);

/** Drops what people put between digits: spaces, dashes, dots, brackets. */
function stripPhone(input: string): string {
  return input.replace(/[\s\-().]/g, "");
}

/** An Indian mobile typed with the country code (`+91…` / `91…`) → its 10 digits. */
function withoutCountryCode(stripped: string): string {
  return /^(?:\+91|91)([6-9][0-9]{9})$/.exec(stripped)?.[1] ?? stripped;
}

/**
 * A phone number as the database stores it (digits with an optional leading `+`, 6–19 digits),
 * from what people type. Spaces, dashes, dots and brackets are dropped, and an Indian mobile number
 * typed with `+91` / `91` in front is stored as its 10 digits, so search finds it by the digits
 * people know. A leading `0` is kept (it can be a landline's STD code: `0712…`). `null` when what
 * is left is not a phone number.
 */
export function normalizePhone(input: string): string | null {
  const stripped = stripPhone(input);
  if (stripped === "") return null;
  const phone = withoutCountryCode(stripped);
  return PHONE_RE.test(phone) ? phone : null;
}

/** Escapes `\`, `%` and `_` for a `LIKE … ESCAPE '\'` pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** How the search box text is matched (see `searchCustomers`). */
export interface SearchTerms {
  /** The trimmed text, inner spaces collapsed ("" = no search: list everything). */
  readonly text: string;
  /** `normalizeCustomerCode(text)`: exact and prefix code matches. */
  readonly code: string;
  /**
   * The digits when the text is a phone-like number (digits with spaces, dashes, brackets or a
   * leading `+`), cleaned like a stored phone (`+91 98765 43210` → `9876543210`); else `null`.
   */
  readonly digits: string | null;
  /** `normalizeVcNumber(text)` when it could be a VC number (≥ 3 characters), else `null`. */
  readonly vc: string | null;
  /** Name matching is used for this text: ≥ 2 characters (one letter matches too much). */
  readonly nameContains: boolean;
  /** Typo-tolerant name matching (pg_trgm word similarity): ≥ 4 characters. */
  readonly nameFuzzy: boolean;
}

/**
 * pg_trgm word similarity a name needs to count as "similar" (the `<%` operator, set per search
 * transaction). pg_trgm's default 0.6 misses one-letter slips in short names ("ramsh" → "Ramesh
 * Kumar" scores 0.5); 0.45 finds them without matching unrelated names.
 */
export const NAME_SIMILARITY_THRESHOLD = 0.45;

/** Shortest phone digits that are matched as a prefix ("987…"). */
export const MIN_PHONE_PREFIX = 3;
/** Shortest phone digits that are matched anywhere in the number ("…3210"). */
export const MIN_PHONE_CONTAINS = 4;

/** Reads the search box text. Pure; see {@link SearchTerms}. */
export function searchTerms(query: string | undefined | null): SearchTerms {
  const text = (query ?? "").replace(/\s+/g, " ").trim().slice(0, CUSTOMER_FIELD_LIMITS.query);
  const phoneLike = /^\+?[0-9][0-9\s\-().]*$/.test(text);
  let digits: string | null = null;
  if (phoneLike) {
    digits = withoutCountryCode(stripPhone(text)).replace(/[^0-9]/g, "");
    if (digits === "") digits = null;
  }
  const vc = text.length >= 3 ? normalizeVcNumber(text) : null;
  return {
    text,
    code: normalizeCustomerCode(text),
    digits,
    vc: vc === "" ? null : vc,
    nameContains: text.length >= 2,
    nameFuzzy: text.length >= 4,
  };
}

/** Why a search row matched: shown next to the name ("VC 1234…") and used by tests. */
export const SEARCH_MATCH_KINDS = ["all", "code", "phone", "vc", "name"] as const;
export type SearchMatchKind = (typeof SEARCH_MATCH_KINDS)[number];

/**
 * Ranking tiers (lower = better). Within a tier: name similarity, then the code in natural order.
 * Exported for tests and for anyone who needs to explain the order.
 */
export const SEARCH_TIERS = Object.freeze({
  /** Exact customer code. */
  codeExact: 0,
  /** Exact phone/alt phone, or the exact VC number of a connection that is not disconnected. */
  phoneOrVcExact: 1,
  /** Code starting with the text. */
  codePrefix: 2,
  /** Phone or open connection's VC number starting with the text. */
  phoneOrVcPrefix: 3,
  /** Name starting with the text. */
  namePrefix: 4,
  /** A word of the name starting with the text. */
  nameWord: 5,
  /** Phone containing the digits; name containing the text. */
  contains: 6,
  /** VC number of a disconnected (past) connection. */
  pastVc: 7,
  /** Name similar to the text (typos). */
  nameSimilar: 8,
});

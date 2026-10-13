/**
 * The automated "no personal data in the profile" check (T-090 acceptance criterion).
 *
 * Two layers, both run before a profile is written (and again by `check-profile` on any file):
 *
 * 1. **Shapes** (no database needed): Indian mobile numbers, e-mail addresses, password-hash and
 *    token shapes (long hex, bcrypt/argon2/crypt prefixes), and digit runs of 9+ (Aadhaar, account
 *    and phone numbers). A profile holds counts far below 9 digits, so these never occur legitimately.
 * 2. **Values** (from the copied data): every distinct value of every identifying column (names,
 *    phones, addresses, logins, passwords, tokens …, see `IDENTIFYING_WORDS`) and every word of
 *    person-name columns. Text is compared normalised (lower case, punctuation → space) as whole
 *    word sequences, so "Sunita Devi" is found in "| sunita-devi |" but "Ram" is not found in
 *    "parameter". Values equal to a table or column name are ignored: identifiers are not data.
 *
 * Findings name the line and the column the value came from, never the value itself, so the check's
 * own output can't leak what it found.
 */

export type PiiKind = "phone" | "email" | "secret" | "digits" | "value";

export interface PiiFinding {
  readonly line: number;
  readonly kind: PiiKind;
  /** For value findings: `table.column` the value came from. */
  readonly source?: string;
}

/** Normalises text for value matching: lower case, every run of non-letters/digits → one space. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Longest word sequence compared as a whole; longer values are matched by their first words. */
export const MAX_NGRAM = 12;
/** Shorter values are ignored (too likely to be a coincidence). */
export const MIN_VALUE_LENGTH = 4;
/** Values made only of digits must be at least this long (phones, ids; not counts or PIN codes). */
export const MIN_DIGIT_VALUE_LENGTH = 8;

export class ForbiddenValues {
  readonly #values = new Map<string, string>();
  readonly #words = new Map<string, string>();
  readonly #ignore = new Set<string>();

  /** A whole value from an identifying column. */
  addValue(raw: string, source: string): void {
    const value = normalizeForMatch(raw);
    if (!isMatchable(value)) return;
    const words = value.split(" ");
    const key = words.length > MAX_NGRAM ? words.slice(0, MAX_NGRAM).join(" ") : value;
    if (!this.#values.has(key)) this.#values.set(key, source);
  }

  /** Every word of a person-name value ("Sunita", "Devi"), forbidden on its own. */
  addNameWords(raw: string, source: string): void {
    for (const word of normalizeForMatch(raw).split(" ")) {
      if (word.length >= MIN_VALUE_LENGTH && !/^\p{N}+$/u.test(word) && !this.#words.has(word)) {
        this.#words.set(word, source);
      }
    }
  }

  /** Identifiers (table/column names, types) that the profile contains by design. */
  addIgnored(identifier: string): void {
    const normalized = normalizeForMatch(identifier);
    if (normalized) this.#ignore.add(normalized);
    for (const word of normalized.split(" ")) if (word) this.#ignore.add(word);
  }

  get size(): number {
    return this.#values.size + this.#words.size;
  }

  /** The column a normalised word sequence comes from, or undefined when it is allowed. */
  lookup(sequence: string): string | undefined {
    if (this.#ignore.has(sequence)) return undefined;
    return this.#values.get(sequence) ?? this.#words.get(sequence);
  }

  /** True when `value` (raw) is, or contains as a whole word sequence, a forbidden value. */
  contains(raw: string): boolean {
    return matchSequences(normalizeForMatch(raw), this) !== undefined;
  }
}

function isMatchable(value: string): boolean {
  if (value.length < MIN_VALUE_LENGTH) return false;
  if (/^[\p{N} ]+$/u.test(value)) return value.replace(/ /g, "").length >= MIN_DIGIT_VALUE_LENGTH;
  return true;
}

function matchSequences(normalized: string, forbidden: ForbiddenValues): string | undefined {
  if (!normalized) return undefined;
  const words = normalized.split(" ");
  for (let start = 0; start < words.length; start++) {
    let sequence = "";
    for (let n = 0; n < MAX_NGRAM && start + n < words.length; n++) {
      sequence = n === 0 ? (words[start] ?? "") : `${sequence} ${words[start + n]}`;
      const source = forbidden.lookup(sequence);
      if (source !== undefined) return source;
    }
  }
  return undefined;
}

const SHAPES: readonly { readonly kind: PiiKind; readonly pattern: RegExp }[] = [
  // Indian mobile numbers, with or without +91 / 0 and a separator in the middle.
  { kind: "phone", pattern: /(?<![\p{N}])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\p{N}])/u },
  { kind: "email", pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/iu },
  // Password hashes and tokens: long hex/base64-ish strings, crypt-style prefixes.
  { kind: "secret", pattern: /\b[a-f0-9]{24,}\b|\$(?:2[abxy]?|argon2(?:id|i|d)?|[156])\$/i },
  // Long runs of numbers, and Aadhaar-style 4-4-4 groups.
  { kind: "digits", pattern: /\p{N}{9,}|(?<![\p{N},])\d{4}[\s-]\d{4}[\s-]\d{4}(?![\p{N}])/u },
];

/** Shape findings in one line of text (no data needed). */
export function shapeFindings(text: string): PiiKind[] {
  return SHAPES.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
}

/** Runs both layers over a document. An empty result means the document passed. */
export function scanForPii(text: string, forbidden?: ForbiddenValues): PiiFinding[] {
  const findings: PiiFinding[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const kind of shapeFindings(line)) findings.push({ line: index + 1, kind });
    if (forbidden) {
      const source = matchSequences(normalizeForMatch(line), forbidden);
      if (source !== undefined) findings.push({ line: index + 1, kind: "value", source });
    }
  }
  return findings;
}

/** A one-line-per-finding summary that never repeats the matched text. */
export function describeFindings(findings: readonly PiiFinding[]): string {
  return findings
    .map((f) => `line ${f.line}: ${f.kind}${f.source ? ` (matches a value of ${f.source})` : ""}`)
    .join("\n");
}

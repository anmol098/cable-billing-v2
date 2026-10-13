/**
 * Paise → text, the same on the web (`@cb/ui` Amount), Android (`Rupees.format`) and the server:
 *
 * - Indian grouping: the last three digits, then pairs: `12345600` paise → `"₹1,23,456"`.
 * - Paise appear only when the amount is not whole rupees: `1250` → `"₹12.50"` (D-17: the UI only
 *   creates whole rupees, but migrated or adjusted amounts may carry paise).
 * - Digits stay Latin (0–9) in Hindi too (PLAN §11.4, glossary), so `en` and `hi` give the same text
 *   today. `numerals: "devanagari"` exists for the field test in Q-09; nothing uses it yet.
 * - Pure string and `bigint` maths. No `Intl` (identical output on every runtime and ICU build) and no
 *   floating point.
 */

import type { DisplayLocale } from "../time/locale";
import { isPaise, type Paise } from "./paise";

export type Numerals = "latin" | "devanagari";

const ASCII_DIGITS = /^\d+$/;
const DEVANAGARI_ZERO = 0x0966;

/** `"1234567"` → `"12,34,567"`. `digits` must be ASCII digits only (no sign, no separators). */
export function groupIndian(digits: string): string {
  if (!ASCII_DIGITS.test(digits)) throw new RangeError(`not digits: "${digits}"`);
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+$)/g, ",")},${tail}`;
}

/** ASCII digits → Devanagari digits (०–९); everything else is left alone. */
export function toDevanagariDigits(text: string): string {
  return text.replace(/\d/g, (digit) => String.fromCodePoint(DEVANAGARI_ZERO + Number(digit)));
}

/** Devanagari digits (०–९) → ASCII, so a Hindi keyboard works in number fields and search. */
export function toAsciiDigits(text: string): string {
  return text.replace(/[०-९]/g, (digit) =>
    String((digit.codePointAt(0) ?? DEVANAGARI_ZERO) - DEVANAGARI_ZERO),
  );
}

function toBigIntPaise(amount: Paise | number | bigint): bigint {
  if (typeof amount === "bigint") return amount;
  if (!isPaise(amount)) throw new RangeError(`paise must be a safe integer, got ${amount}`);
  return BigInt(amount);
}

function absoluteText(abs: bigint): string {
  const rupees = abs / 100n;
  const rest = abs % 100n;
  const fraction = rest === 0n ? "" : `.${rest.toString().padStart(2, "0")}`;
  return `₹${groupIndian(rupees.toString())}${fraction}`;
}

export type FormattedRupees = {
  /** `"₹1,23,456"` for the **absolute** value; paise appear only when not whole (`"₹12.50"`). */
  text: string;
  negative: boolean;
};

/**
 * Paise → the absolute amount as text, plus its sign, for UIs that show the sign as a colour and a
 * word instead of a minus (a negative balance is credit: PLAN §2.2, `@cb/ui` Amount). Same contract
 * as `@cb/ui` `formatRupees`, which can re-export this one.
 */
export function formatRupees(amount: Paise | number | bigint): FormattedRupees {
  const value = toBigIntPaise(amount);
  const negative = value < 0n;
  return { text: absoluteText(negative ? -value : value), negative };
}

export type FormatINROptions = {
  /** `en` (default) or `hi`. Same text today; kept so callers already pass it (Q-09). */
  locale?: DisplayLocale;
  /** Default `latin` (PLAN §11.4). */
  numerals?: Numerals;
  /**
   * `minus` (default): negatives get a leading `-` (`"-₹500"`), for statements and exports.
   * `absolute`: never a sign, for UIs that show credit with colour + word instead.
   */
  sign?: "minus" | "absolute";
};

/**
 * Paise → `"₹1,23,456"` (or `"₹12.50"` when not whole rupees). Accepts `Paise`, a safe-integer
 * `number` or a `bigint` (e.g. a report total straight from SQL). Throws `RangeError` for fractions.
 */
export function formatINR(amount: Paise | number | bigint, options: FormatINROptions = {}): string {
  const { numerals = "latin", sign = "minus" } = options;
  const { text, negative } = formatRupees(amount);
  const signed = negative && sign === "minus" ? `-${text}` : text;
  return numerals === "devanagari" ? toDevanagariDigits(signed) : signed;
}

/**
 * Paise → the digits an amount field shows: `12300` → `"123"`, `null` → `""`. Not whole rupees keep
 * their paise (`1250` → `"12.50"`) so nothing is silently rounded; the whole-rupee field will refuse
 * that text, which is the honest outcome.
 */
export function paiseToRupeeDigits(amount: Paise | number | null): string {
  if (amount === null) return "";
  const value = toBigIntPaise(amount);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rest = abs % 100n;
  const whole = (abs / 100n).toString();
  return `${negative ? "-" : ""}${whole}${rest === 0n ? "" : `.${rest.toString().padStart(2, "0")}`}`;
}

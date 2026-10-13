/*
 * Money helpers for the UI: whole-rupee input → integer paise, and paise → "₹1,23,456".
 *
 * TODO(T-024): swap these for the @cb/domain money helpers once T-024 lands (keep the UI-facing
 * names, or re-export the domain ones from here so the primitives don't change).
 *
 * Rules (CLAUDE.md): money is integer paise; the UI accepts whole rupees only; no floats. The only
 * arithmetic on a JS number is the integer rupees × 100, guarded to stay a safe integer; formatting
 * works on bigint.
 */

/** Paise in one rupee. */
export const PAISE_PER_RUPEE = 100;

/**
 * At most 13 rupee digits (₹99,99,99,99,99,999), so `rupees × 100` stays below
 * Number.MAX_SAFE_INTEGER and paise stay exact as a JS number.
 */
export const MAX_RUPEE_DIGITS = 13;

export type RupeesInputRejectReason = "decimal" | "negative" | "invalid" | "too-large";

export type RupeesInputResult =
  | {
      ok: true;
      /** Integer paise, or `null` for an empty field. */
      paise: number | null;
      /** The canonical text to show: digits only, no leading zeros (`""` when empty). */
      digits: string;
    }
  | { ok: false; reason: RupeesInputRejectReason };

const DEVANAGARI_ZERO = 0x0966;

/** Devanagari digits (०–९) → ASCII, so a Hindi keyboard works too. */
function toAsciiDigits(text: string): string {
  return text.replace(/[०-९]/g, (digit) =>
    String((digit.codePointAt(0) ?? DEVANAGARI_ZERO) - DEVANAGARI_ZERO),
  );
}

/**
 * Parses what a person typed or pasted into a whole-rupee field. Accepts digits with optional
 * grouping commas, spaces and a leading ₹ (`"₹1,23,456"`), and Devanagari digits. Rejects
 * decimals (`"12.50"`, even `"12.00"`), negatives, anything else, and more than
 * {@link MAX_RUPEE_DIGITS} digits.
 */
export function parseRupeesInput(text: string): RupeesInputResult {
  const compact = toAsciiDigits(text).replace(/[\s,]/g, "").replace(/^₹/, "");
  if (compact === "") return { ok: true, paise: null, digits: "" };
  if (/^[-−]/.test(compact)) return { ok: false, reason: "negative" };
  if (/[.٫]/.test(compact)) return { ok: false, reason: "decimal" };
  if (!/^\d+$/.test(compact)) return { ok: false, reason: "invalid" };
  const digits = compact.replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_RUPEE_DIGITS) return { ok: false, reason: "too-large" };
  return { ok: true, paise: rupeesToPaise(Number(digits)), digits };
}

/** Whole rupees → integer paise. Throws on fractions, negatives or unsafe integers. */
export function rupeesToPaise(rupees: number): number {
  if (!Number.isSafeInteger(rupees) || rupees < 0) {
    throw new RangeError(`rupees must be a non-negative whole number, got ${rupees}`);
  }
  const paise = rupees * PAISE_PER_RUPEE;
  if (!Number.isSafeInteger(paise)) throw new RangeError(`rupees too large: ${rupees}`);
  return paise;
}

function toBigIntPaise(paise: number | bigint): bigint {
  if (typeof paise === "bigint") return paise;
  if (!Number.isSafeInteger(paise)) {
    throw new RangeError(`paise must be a safe integer, got ${paise}`);
  }
  return BigInt(paise);
}

/** `"1234567"` → `"12,34,567"` (Indian grouping: last three digits, then pairs). */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+$)/g, ",")},${tail}`;
}

export type FormattedRupees = {
  /** `"₹1,23,456"` for the absolute value; paise appear only when not whole (`"₹12.50"`). */
  text: string;
  negative: boolean;
};

/** Paise (number or bigint) → the absolute amount as Indian-grouped rupees, plus its sign. */
export function formatRupees(paise: number | bigint): FormattedRupees {
  const value = toBigIntPaise(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = abs / 100n;
  const rest = abs % 100n;
  const fraction = rest === 0n ? "" : `.${rest.toString().padStart(2, "0")}`;
  return { text: `₹${groupIndian(rupees.toString())}${fraction}`, negative };
}

/** Paise → the digits an AmountInput shows (`12300` → `"123"`, `null` → `""`). */
export function paiseToRupeeDigits(paise: number | null): string {
  if (paise === null) return "";
  const value = toBigIntPaise(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rest = abs % 100n;
  const whole = (abs / 100n).toString();
  return `${negative ? "-" : ""}${whole}${rest === 0n ? "" : `.${rest.toString().padStart(2, "0")}`}`;
}

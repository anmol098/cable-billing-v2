/**
 * Money is an integer number of **paise** (CLAUDE.md, PLAN §7.1, PRD §12). No floats, ever.
 *
 * Representation (decision, T-024): a **branded JS `number` that is always a safe integer**.
 *
 * - Why not `bigint`: amounts cross JSON (the mobile API, server actions, React props), where
 *   `bigint` doesn't serialise; Drizzle, Zod and the UI all speak `number` natively. The largest
 *   safe integer, 9,007,199,254,740,991 paise (about ₹90 lakh crore), is far beyond any cable bill,
 *   ledger total or tenant report.
 * - Why branded: `Paise` can't be confused with a rupee count or any other number by accident.
 *   Values enter through {@link paise}, {@link toPaise} or {@link rupeesToPaise}, which check them.
 *   A `Paise` is still a `number`, so it passes straight to `@cb/ui` `<Amount paise>` and to Zod.
 * - Why the helpers below instead of `+`/`-`: every result is re-checked to be a safe integer, so
 *   an overflow throws instead of silently losing precision. Comparisons (`<`, `===`) are fine as is.
 * - The database column is `bigint` (`*_paise`). Read it with {@link toPaise} (accepts the driver's
 *   `string`/`bigint`/`number`) and write it with {@link paiseToBigInt} or the number itself.
 *
 * The UI works in whole rupees (D-17), but paise are kept everywhere else so paise can be enabled
 * later without a schema change.
 */

declare const paiseBrand: unique symbol;

/** An integer amount of paise (may be negative: ledger entries and balances are signed). */
export type Paise = number & { readonly [paiseBrand]: true };

/** Paise in one rupee. */
export const PAISE_PER_RUPEE = 100;

/** ₹0. */
export const ZERO_PAISE = 0 as Paise;

/**
 * At most 13 rupee digits (₹99,99,99,99,99,999) in user input, so `rupees × 100` always stays a
 * safe integer. Same limit as the Android `Rupees.MAX_RUPEE_DIGITS`.
 */
export const MAX_RUPEE_DIGITS = 13;

/** The largest whole-rupee amount a person can enter (13 nines). */
export const MAX_INPUT_RUPEES = 9_999_999_999_999;

/** True when `value` is a usable paise amount (a safe integer, sign allowed). */
export function isPaise(value: unknown): value is Paise {
  return Number.isSafeInteger(value);
}

/** Checks and brands a number of paise. Throws `RangeError` for fractions, NaN or unsafe integers. */
export function paise(value: number): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`paise must be a safe integer, got ${value}`);
  }
  // `-0` would print as "0" anyway; normalise so Object.is and sorting behave.
  return (value === 0 ? 0 : value) as Paise;
}

const INTEGER_TEXT = /^-?\d+$/;

/**
 * Paise from a database `bigint` column or any other integer source: a `number`, a `bigint`, or an
 * integer string (`"-12500"`, how `pg` returns `bigint`). Throws `RangeError` for anything that is
 * not an integer or does not fit in a safe integer.
 */
export function toPaise(value: number | bigint | string): Paise {
  if (typeof value === "number") return paise(value);
  if (typeof value === "string") {
    if (!INTEGER_TEXT.test(value)) {
      throw new RangeError(`paise must be an integer string, got "${value}"`);
    }
    return toPaise(BigInt(value));
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`paise out of safe range: ${value}`);
  }
  return paise(Number(value));
}

/** Paise as a `bigint`, for code that writes `bigint` explicitly. */
export function paiseToBigInt(amount: Paise): bigint {
  return BigInt(amount);
}

/**
 * Whole rupees → paise (D-17: the UI takes whole rupees only). Throws `RangeError` for fractions,
 * negatives, NaN, or more than {@link MAX_INPUT_RUPEES}.
 */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isSafeInteger(rupees) || rupees < 0) {
    throw new RangeError(`rupees must be a non-negative whole number, got ${rupees}`);
  }
  if (rupees > MAX_INPUT_RUPEES) throw new RangeError(`rupees too large: ${rupees}`);
  return paise(rupees * PAISE_PER_RUPEE);
}

/** True when the amount is a whole number of rupees (what the UI can show and take back). */
export function isWholeRupees(amount: Paise): boolean {
  return amount % PAISE_PER_RUPEE === 0;
}

/**
 * Splits paise into whole rupees and the remaining paise, both carrying the sign of `amount`.
 * Integer maths only: `12345` → `{ rupees: 123, paise: 45 }`, `-12345` → `{ rupees: -123, paise: -45 }`.
 */
export function splitRupees(amount: Paise): { rupees: number; paise: number } {
  // bigint division truncates toward zero and the remainder takes the dividend's sign.
  const value = BigInt(amount);
  return { rupees: Number(value / 100n), paise: Number(value % 100n) };
}

// ── Arithmetic. Every result is re-checked, so overflow throws instead of rounding. ──────────────

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subtractPaise(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

/** Σ amounts (0 for an empty list). */
export function sumPaise(amounts: Iterable<Paise>): Paise {
  let total = 0;
  for (const amount of amounts) total = paise(total + amount);
  return total as Paise;
}

/** `amount × count`, for "128 customers × ₹450". `count` must be a safe integer. */
export function multiplyPaise(amount: Paise, count: number): Paise {
  if (!Number.isSafeInteger(count)) {
    throw new RangeError(`count must be a safe integer, got ${count}`);
  }
  return paise(amount * count);
}

export function negatePaise(amount: Paise): Paise {
  return paise(-amount);
}

export function absPaise(amount: Paise): Paise {
  return amount < 0 ? negatePaise(amount) : amount;
}

export function minPaise(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

export function maxPaise(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

/** For `Array.prototype.sort`: ascending. */
export function comparePaise(a: Paise, b: Paise): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

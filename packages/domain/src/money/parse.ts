/**
 * What a person typed into a whole-rupee field → paise (D-17). Shared by the web `AmountInput`, the
 * server actions that receive amounts, CSV import and the Android number pad's rules.
 */

import { err, ok, type Result } from "../result";
import { toAsciiDigits } from "./format";
import { MAX_RUPEE_DIGITS, type Paise, rupeesToPaise } from "./paise";

/** Why an input was refused. Map each to an i18n message ("Whole rupees only", …). */
export type RupeesInputRejectReason = "decimal" | "negative" | "invalid" | "too-large";

export type RupeesInput = {
  /** Integer paise, or `null` for an empty field. */
  paise: Paise | null;
  /** The canonical text to show: ASCII digits only, no leading zeros (`""` when empty). */
  digits: string;
};

/**
 * Accepts digits with optional grouping commas, spaces and a leading `₹` (`"₹1,23,456"`), and
 * Devanagari digits (`"४५०"`). Refuses decimals (`"12.50"`, even `"12.00"`), negatives, anything
 * else, and more than {@link MAX_RUPEE_DIGITS} digits. An empty field is `ok` with `paise: null`.
 */
export function parseRupeesInput(text: string): Result<RupeesInput, RupeesInputRejectReason> {
  const compact = toAsciiDigits(text).replace(/[\s,]/g, "").replace(/^₹/, "");
  if (compact === "") return ok({ paise: null, digits: "" });
  if (/^[-−]/.test(compact)) return err("negative");
  if (/[.٫]/.test(compact)) return err("decimal");
  if (!/^\d+$/.test(compact)) return err("invalid");
  const digits = compact.replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_RUPEE_DIGITS) return err("too-large");
  return ok({ paise: rupeesToPaise(Number(digits)), digits });
}

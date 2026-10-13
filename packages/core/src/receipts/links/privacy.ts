/**
 * What the public receipt page may show about the customer (PLAN §9.4, FR-021 "minimise exposed
 * personal data"): the **first name** and the **last four digits** of the phone. Nothing else (no
 * surname, customer code, address, VC number, full phone or KYC).
 */

/** Titles that are not a name ("Shri Ram Kumar" → "Ram"). Compared lower-case, dots removed. */
const HONORIFICS = new Set([
  "shri",
  "sri",
  "shree",
  "smt",
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "kumari",
  "श्री",
  "श्रीमती",
  "सुश्री",
  "कुमारी",
  "डॉ",
  "डॉक्टर",
]);

/** A first name is cut to this many characters (a very long single word could be a full name). */
export const FIRST_NAME_MAX_LENGTH = 24;

/**
 * The customer's first name: the first word that is not a title, at most
 * {@link FIRST_NAME_MAX_LENGTH} characters. `null` when the name is blank.
 */
export function customerFirstName(fullName: string | null | undefined): string | null {
  const words = (fullName ?? "")
    .normalize("NFC")
    .split(/[\s,]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  const first = words.find((word) => !HONORIFICS.has(word.toLowerCase().replace(/\.+$/u, "")));
  if (!first) return null;
  const chars = Array.from(first);
  return chars.length > FIRST_NAME_MAX_LENGTH
    ? chars.slice(0, FIRST_NAME_MAX_LENGTH).join("")
    : first;
}

/** Digits shown at the end of a masked phone. */
export const PHONE_VISIBLE_DIGITS = 4;

/**
 * `9876543210` (or `+91 98765 43210`) → `XXXXXX3210`: always six `X` and the last four digits, so
 * the length gives nothing away. `null` when there is no phone or fewer than eight digits (too
 * short to be a real mobile number, so showing four would reveal half of it).
 */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/gu, "");
  if (digits.length < 8) return null;
  return `XXXXXX${digits.slice(-PHONE_VISIBLE_DIGITS)}`;
}

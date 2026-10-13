/**
 * Team rules (T-032, D-07, D-16, PLAN §2.2, §11.6). Pure: no I/O, no clock.
 *
 * **Sign-in names** (`users.login`) are unique across every operator and stored lower-case
 * (T-021 CHECK: 3–100 chars, no spaces). We also refuse `@` (the web form treats a login with `@`
 * as an email, T-026) and keep to letters, digits, `.`, `-` and `_`, so a lineman can type it.
 * For a lineman the suggestion is their 10-digit mobile number, then `<mobile>-2`, `<mobile>-3`…
 * when another business already uses that number as a sign-in name.
 *
 * **Passwords:**
 * - Linemen (low literacy, sign in once per phone, show-password on by default): at least
 *   {@link LINEMAN_PASSWORD_MIN_LENGTH} letters or numbers, so a 6-digit number works. We refuse
 *   only the passwords anyone would guess first: one character repeated (`111111`), a straight run
 *   (`123456`, `987654`, `abcdef`), a few well-known ones, and the sign-in name or mobile number
 *   itself. Sign-in is rate limited per account (10 tries / 15 min, T-026/T-028).
 * - Staff use the web like the Owner: T-026's 8–128 characters (Better Auth checks the same
 *   length on reset).
 * - Never longer than {@link PASSWORD_MAX_LENGTH} (bounds the argon2 work).
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../auth/password";
import { MAX_LOGIN_CANDIDATES } from "../tenants/rules";

/** Shortest lineman password. A 6-digit number is easy to type on a phone keypad. */
export const LINEMAN_PASSWORD_MIN_LENGTH = 6;
/** Staff sign in on the web: the web's rule (T-026). */
export const STAFF_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH;
export { PASSWORD_MAX_LENGTH };

/** Shortest / longest sign-in name (T-021 CHECK). */
export const LOGIN_MIN_LENGTH = 3;
export const LOGIN_MAX_LENGTH = 100;

/** What we allow in a sign-in name, after lower-casing. */
const LOGIN_PATTERN = /^[a-z0-9._-]+$/;

/** Why a password was refused. Each maps to one plain sentence in the `team` namespace. */
export type PasswordProblem = "too_short" | "too_long" | "too_simple" | "same_as_login";

/** Why a sign-in name was refused. */
export type LoginProblem = "too_short" | "too_long" | "bad_characters";

/** Passwords everyone tries first (lower-cased). Runs and repeats are caught by rule, not list. */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "passw0rd",
  "qwerty",
  "qwerty123",
  "abc123",
  "abcd1234",
  "iloveyou",
  "admin123",
  "welcome",
  "lineman",
  "cable123",
]);

const RUN_ALPHABETS = ["0123456789", "abcdefghijklmnopqrstuvwxyz"];

/** `111111`, `aaaaaa`, `121212`: one or two characters repeated. */
function isRepetitive(value: string): boolean {
  return new Set(value).size <= 2;
}

/** `123456`, `987654`, `abcdef`, `fedcba`: a straight run in either direction. */
function isStraightRun(value: string): boolean {
  return RUN_ALPHABETS.some((alphabet) => {
    const reversed = [...alphabet].reverse().join("");
    return alphabet.includes(value) || reversed.includes(value);
  });
}

/**
 * Checks a lineman's password. `login` and `mobile` are the sign-in name and mobile number the
 * password must not equal. Returns null when the password is fine.
 */
export function linemanPasswordProblem(
  password: string,
  identity: { readonly login?: string | null; readonly mobile?: string | null } = {},
): PasswordProblem | null {
  if (password.length < LINEMAN_PASSWORD_MIN_LENGTH) return "too_short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  const lower = password.toLowerCase();
  const same = [identity.login, identity.mobile]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase() === lower);
  if (same) return "same_as_login";
  if (isRepetitive(lower) || isStraightRun(lower) || COMMON_PASSWORDS.has(lower)) {
    return "too_simple";
  }
  return null;
}

/** Checks a staff member's password (web rules). Returns null when it is fine. */
export function staffPasswordProblem(
  password: string,
  identity: { readonly login?: string | null; readonly mobile?: string | null } = {},
): PasswordProblem | null {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH) return "too_short";
  return linemanPasswordProblem(password, identity);
}

/** The password rule for a role. Owners are not managed here. */
export function passwordProblemFor(
  role: "staff" | "lineman",
  password: string,
  identity: { readonly login?: string | null; readonly mobile?: string | null } = {},
): PasswordProblem | null {
  return role === "staff"
    ? staffPasswordProblem(password, identity)
    : linemanPasswordProblem(password, identity);
}

/** A sign-in name as stored: trimmed and lower-cased. */
export function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

/** Checks a (normalised) sign-in name. Returns null when it is fine. */
export function loginProblem(login: string): LoginProblem | null {
  if (login.length < LOGIN_MIN_LENGTH) return "too_short";
  if (login.length > LOGIN_MAX_LENGTH) return "too_long";
  if (!LOGIN_PATTERN.test(login)) return "bad_characters";
  return null;
}

/**
 * Sign-in names to try for a suggested login (the mobile number), best first: the value itself,
 * then `<value>-2` … `<value>-10`. A login the Owner typed by hand is tried as is, only.
 */
export function suggestedLoginCandidates(base: string): string[] {
  return Array.from({ length: MAX_LOGIN_CANDIDATES }, (_, index) =>
    index === 0 ? base : `${base}-${index + 1}`,
  ).filter((login) => login.length <= LOGIN_MAX_LENGTH);
}

/** Digits a "Make a password" button may use (no 0/1 look-alikes problem for digits; all fine). */
const DIGITS = "0123456789";

/**
 * A random 6-digit password that passes {@link linemanPasswordProblem}, for the "Make one for me"
 * button. `randomInt(n)` must return a uniform integer in [0, n) from a secure source
 * (`crypto.getRandomValues` in the browser).
 */
export function suggestLinemanPassword(
  randomInt: (n: number) => number,
  identity: { readonly login?: string | null; readonly mobile?: string | null } = {},
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let value = "";
    for (let i = 0; i < LINEMAN_PASSWORD_MIN_LENGTH; i += 1) {
      value += DIGITS[randomInt(DIGITS.length)];
    }
    if (linemanPasswordProblem(value, identity) === null) return value;
  }
  throw new Error("suggestLinemanPassword: the random source looks broken");
}

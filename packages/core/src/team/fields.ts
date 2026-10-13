/**
 * Field checks for the "Add lineman" and "Add staff" forms (T-032). Pure. Every problem is
 * reported at once (field path + a code the page turns into one plain sentence), never the value.
 */
import type { FieldIssue } from "../errors/errors";
import { normalizeIndianMobile } from "../tenants/rules";
import {
  LOGIN_MAX_LENGTH,
  LOGIN_MIN_LENGTH,
  loginProblem,
  normalizeLogin,
  passwordProblemFor,
  suggestedLoginCandidates,
} from "./rules";

/** Longest name we keep (same as the owner's name at sign-up, T-027). */
export const MEMBER_NAME_MAX_LENGTH = 120;
/** Longest email address (RFC 5321). */
export const EMAIL_MAX_LENGTH = 254;

/** Field codes beyond the password/login problems in ./rules.ts. */
export type MemberFieldCode =
  | "required"
  | "too_long"
  | "invalid"
  | "too_short"
  | "bad_characters"
  | "too_simple"
  | "same_as_login";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A person's name with runs of spaces collapsed. */
export function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function nameIssue(name: string): FieldIssue | null {
  if (name.length === 0) return { path: "name", code: "required" };
  if (name.length > MEMBER_NAME_MAX_LENGTH) return { path: "name", code: "too_long" };
  return null;
}

/** Sanitises an email's local part into a sign-in name base (`ravi.k@x.in` → `ravi.k`). */
export function loginBaseFromEmail(email: string): string | null {
  const local = email.split("@")[0] ?? "";
  const base = normalizeLogin(local)
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, LOGIN_MAX_LENGTH - 3);
  return base.length >= LOGIN_MIN_LENGTH ? base : null;
}

export interface CheckedLineman {
  readonly name: string;
  readonly mobile: string;
  /** Sign-in names to try in order (one when the Owner typed it, else the mobile and -2…). */
  readonly loginCandidates: readonly string[];
  readonly loginSuggested: boolean;
  readonly password: string;
}

export interface CheckedStaff {
  readonly name: string;
  readonly mobile: string | null;
  readonly email: string | null;
  readonly loginCandidates: readonly string[];
  readonly loginSuggested: boolean;
  /** Null for an invite (they set it from the emailed link). */
  readonly password: string | null;
}

export type FieldCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly fields: FieldIssue[] };

/**
 * The login the Owner typed, or the suggestion from `base` (mobile / email). With no login and no
 * base, asks for a user name, unless the mobile or email already has a problem to fix (that
 * message is enough).
 */
function loginChoice(
  typed: string | undefined,
  base: string | null,
  issues: FieldIssue[],
): { candidates: string[]; suggested: boolean } {
  const login = normalizeLogin(typed ?? "");
  if (login.length > 0) {
    const problem = loginProblem(login);
    if (problem) issues.push({ path: "login", code: problem });
    return { candidates: [login], suggested: false };
  }
  if (!base) {
    const contactProblem = issues.some((i) => i.path === "mobile" || i.path === "email");
    if (!contactProblem) issues.push({ path: "login", code: "required" });
    return { candidates: [], suggested: true };
  }
  return { candidates: suggestedLoginCandidates(base), suggested: true };
}

/** Checks the "Add lineman" fields. */
export function checkLinemanFields(input: {
  readonly name: string;
  readonly mobile: string;
  readonly login?: string | undefined;
  readonly password: string;
}): FieldCheck<CheckedLineman> {
  const issues: FieldIssue[] = [];
  const name = cleanName(input.name);
  const nameProblem = nameIssue(name);
  if (nameProblem) issues.push(nameProblem);

  const mobileTyped = input.mobile.trim();
  const mobile = mobileTyped ? normalizeIndianMobile(mobileTyped) : null;
  if (!mobileTyped) issues.push({ path: "mobile", code: "required" });
  else if (!mobile) issues.push({ path: "mobile", code: "invalid" });

  const login = loginChoice(input.login, mobile, issues);
  if (!input.password) issues.push({ path: "password", code: "required" });
  else {
    const problem = passwordProblemFor("lineman", input.password, {
      login: login.candidates[0] ?? null,
      mobile,
    });
    if (problem) issues.push({ path: "password", code: problem });
  }

  if (issues.length > 0 || !mobile) return { ok: false, fields: issues };
  return {
    ok: true,
    value: {
      name,
      mobile,
      loginCandidates: login.candidates,
      loginSuggested: login.suggested,
      password: input.password,
    },
  };
}

/** Checks the "Add staff" fields. `setup` is how the password gets set. */
export function checkStaffFields(input: {
  readonly name: string;
  readonly mobile?: string | undefined;
  readonly email?: string | undefined;
  readonly login?: string | undefined;
  readonly setup: "password" | "invite";
  readonly password?: string | undefined;
}): FieldCheck<CheckedStaff> {
  const issues: FieldIssue[] = [];
  const name = cleanName(input.name);
  const nameProblem = nameIssue(name);
  if (nameProblem) issues.push(nameProblem);

  const mobileTyped = (input.mobile ?? "").trim();
  const mobile = mobileTyped ? normalizeIndianMobile(mobileTyped) : null;
  if (mobileTyped && !mobile) issues.push({ path: "mobile", code: "invalid" });

  const emailTyped = (input.email ?? "").trim().toLowerCase();
  let email: string | null = null;
  if (emailTyped.length > EMAIL_MAX_LENGTH) issues.push({ path: "email", code: "too_long" });
  else if (emailTyped && !EMAIL.test(emailTyped)) issues.push({ path: "email", code: "invalid" });
  else if (emailTyped) email = emailTyped;
  if (input.setup === "invite" && !emailTyped) issues.push({ path: "email", code: "required" });

  const base = mobile ?? (email ? loginBaseFromEmail(email) : null);
  const login = loginChoice(input.login, base, issues);

  let password: string | null = null;
  if (input.setup === "password") {
    const typed = input.password ?? "";
    if (!typed) issues.push({ path: "password", code: "required" });
    else {
      const problem = passwordProblemFor("staff", typed, {
        login: login.candidates[0] ?? null,
        mobile,
      });
      if (problem) issues.push({ path: "password", code: problem });
      else password = typed;
    }
  }

  if (issues.length > 0 || login.candidates.length === 0) return { ok: false, fields: issues };
  return {
    ok: true,
    value: {
      name,
      mobile,
      email,
      loginCandidates: login.candidates,
      loginSuggested: login.suggested,
      password,
    },
  };
}

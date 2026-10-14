/**
 * What the team Server Actions return (T-032), and the mapping from a service error to the words
 * the page shows (`team.error.*`). Pure: used by the actions, the client and the tests. Never
 * carries a password.
 */

/** The form fields that can carry an error. */
export const TEAM_FIELDS = ["name", "mobile", "email", "login", "password"] as const;
export type TeamField = (typeof TEAM_FIELDS)[number];

/** The codes each field has words for (`team.error.<field>.<code>`). */
const FIELD_CODES: Readonly<Record<TeamField, readonly string[]>> = {
  name: ["required", "too_long"],
  mobile: ["required", "invalid"],
  email: ["required", "invalid", "too_long", "taken"],
  login: ["required", "too_short", "too_long", "bad_characters", "taken", "in_team"],
  password: ["required", "too_short", "too_long", "too_simple", "same_as_login"],
};

/** `team.error.*` keys for errors that are not about one field. */
export type TeamErrorKey =
  | "not_owner"
  | "tenant_read_only"
  | "not_found"
  | "owner_account"
  | "unexpected";

/** Field → `<field>.<code>` (a key under `team.error`). */
export type FieldErrors = Partial<Record<TeamField, string>>;

export type TeamFailure = {
  readonly ok: false;
  readonly error?: TeamErrorKey;
  readonly fields?: FieldErrors;
};

/** A service error, as the Server Action sees it. */
export interface TeamServiceError {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Zod's own codes for our inputs (only `max` is set on them) → our words. */
const ZOD_CODES: Readonly<Record<string, string>> = { too_big: "too_long" };

function isTeamField(value: unknown): value is TeamField {
  return typeof value === "string" && (TEAM_FIELDS as readonly string[]).includes(value);
}

/** A failed team service call → what the page shows. */
export function teamFailure(error: TeamServiceError): TeamFailure {
  switch (error.code) {
    case "VALIDATION": {
      const issues = Array.isArray(error.details?.fields) ? error.details.fields : [];
      const fields: FieldErrors = {};
      for (const issue of issues as { path?: unknown; code?: unknown }[]) {
        const code = typeof issue.code === "string" ? (ZOD_CODES[issue.code] ?? issue.code) : "";
        if (!isTeamField(issue.path) || !FIELD_CODES[issue.path].includes(code)) {
          return { ok: false, error: "unexpected" };
        }
        fields[issue.path] ??= `${issue.path}.${code}`;
      }
      return Object.keys(fields).length > 0
        ? { ok: false, fields }
        : { ok: false, error: "unexpected" };
    }
    case "CONFLICT": {
      const reason = error.details?.reason;
      if (reason === "login_taken") return { ok: false, fields: { login: "login.taken" } };
      if (reason === "login_in_team") return { ok: false, fields: { login: "login.in_team" } };
      if (reason === "email_taken") return { ok: false, fields: { email: "email.taken" } };
      return { ok: false, error: "unexpected" };
    }
    case "FORBIDDEN":
      return {
        ok: false,
        error: error.details?.reason === "owner_account" ? "owner_account" : "not_owner",
      };
    case "NOT_FOUND":
      return { ok: false, error: "not_found" };
    case "TENANT_READ_ONLY":
      return { ok: false, error: "tenant_read_only" };
    default:
      return { ok: false, error: "unexpected" };
  }
}

/** What "Add lineman" / "Add staff" show after saving. */
export interface AddedView {
  readonly role: "staff" | "lineman";
  readonly name: string;
  readonly login: string;
  /** The suggested user name (the mobile) when it was taken and `login` is `<mobile>-2`… */
  readonly suggestedLogin: string | null;
  /** Linemen: the WhatsApp link (app link + user name, never the password). */
  readonly shareUrl: string | null;
  /** Staff invited by email: where the link goes and whether we could hand it to the mailer. */
  readonly invite: {
    readonly email: string;
    readonly queued: boolean;
    readonly minutes: number;
  } | null;
}

export type AddResult = { readonly ok: true; readonly added: AddedView } | TeamFailure;

export type DoneResult = { readonly ok: true } | TeamFailure;

/** Password rules per role, for the field notes and the "too short" words. */
export interface PasswordRules {
  readonly linemanMin: number;
  readonly staffMin: number;
}

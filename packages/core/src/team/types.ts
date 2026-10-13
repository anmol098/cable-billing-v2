/** What the team services return (T-032). camelCase, dates as `Date`. */
import type { Language, UserStatus } from "@cb/db";

/** The roles the Owner manages. The Owner is listed but never changed here. */
export type TeamRole = "owner" | "staff" | "lineman";

/** A lineman's phone (PLAN §11.6): model, app version, last seen, signed in or not. */
export interface TeamPhoneView {
  readonly id: string;
  /** 3 characters, printed on provisional receipts (`P-ABC-…`). */
  readonly deviceCode: string;
  readonly model: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly appVersionCode: number | null;
  /** Last sign-in or token refresh (about every 15 minutes while the app is used). */
  readonly lastSeenAt: Date | null;
  /** Set when the Owner signed this phone out. */
  readonly signedOutAt: Date | null;
  /** True when the phone holds a live sign-in for this lineman (not signed out, not expired). */
  readonly signedIn: boolean;
}

export interface TeamMemberView {
  readonly id: string;
  readonly role: TeamRole;
  readonly name: string;
  /** Sign-in name ("user name"). */
  readonly login: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly language: Language;
  readonly status: UserStatus;
  readonly createdAt: Date;
  /** False for staff invited by email who have not set a password yet. */
  readonly passwordSet: boolean;
  /** The lineman's phones, most recently seen first. Empty for Owner and Staff. */
  readonly phones: readonly TeamPhoneView[];
}

export interface TeamView {
  /** Owner first, then linemen, then staff; active before switched off; by name. */
  readonly members: readonly TeamMemberView[];
  /** The signed-in Owner (shown as "You", never changeable here). */
  readonly selfUserId: string;
  /** False while the tenant is read-only (D-13): the list shows, the buttons don't. */
  readonly editable: boolean;
  readonly readOnlyReason: "tenant_read_only" | null;
}

export interface AddedMember {
  readonly userId: string;
  readonly role: "staff" | "lineman";
  /** The sign-in name actually given (may be `<mobile>-2` when the mobile was taken elsewhere). */
  readonly login: string;
  /** True when the suggested sign-in name was taken and a `-2`… version was used. */
  readonly loginChanged: boolean;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly language: Language;
  /** Staff only: the password is set from an emailed link (the caller sends the email). */
  readonly invite: boolean;
}

export interface PasswordResetDone {
  readonly userId: string;
  readonly role: "staff" | "lineman";
  /** Mobile sign-ins ended (the lineman's phones must sign in again with the new password). */
  readonly revokedTokens: number;
  /** Web sessions ended (staff). */
  readonly endedSessions: number;
}

export interface StatusChange {
  readonly userId: string;
  readonly role: "staff" | "lineman";
  readonly status: UserStatus;
  /** True when the user already had this status (nothing changed). */
  readonly unchanged: boolean;
  readonly revokedTokens: number;
  readonly endedSessions: number;
}

/** CONFLICT reasons (`details.reason`). */
export type TeamConflictReason =
  /** The sign-in name is used by another business (sign-in names are unique everywhere). */
  | "login_taken"
  /** The sign-in name belongs to someone already in this team (`details.userId`). */
  | "login_in_team"
  /** The email belongs to another account. */
  | "email_taken";

/** FORBIDDEN reasons (`details.reason`). */
export type TeamForbiddenReason =
  /** The Owner's own account is not managed on this page. */
  "owner_account";

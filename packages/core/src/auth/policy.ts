/**
 * Who may sign in to the web and for how long (PLAN §9.2, D-16).
 *
 * | Role | Web sign-in | Session |
 * |---|---|---|
 * | owner, staff | yes (their operator must be active) | 30 days, sliding (refreshed at most daily) |
 * | platform_admin | yes, TOTP 2FA enrolment required | 8 hours from sign-in, absolute |
 * | lineman | **never** (Android only) | — |
 *
 * Disabled users never get a session. The check runs when a session is about to be created (the
 * only way into the web), so it covers password sign-in, the 2FA step and anything added later.
 */
import type { UserRole } from "@cb/db";

/** Roles that may hold a web session. */
export const WEB_SIGN_IN_ROLES = [
  "owner",
  "staff",
  "platform_admin",
] as const satisfies readonly UserRole[];
export type WebRole = (typeof WEB_SIGN_IN_ROLES)[number];

export function isWebRole(role: unknown): role is WebRole {
  return typeof role === "string" && (WEB_SIGN_IN_ROLES as readonly string[]).includes(role);
}

const DAY_SECONDS = 24 * 60 * 60;

export const SESSION_POLICY = Object.freeze({
  /** Owner/staff session length; every refresh pushes it out again (sliding). */
  tenantExpiresInSeconds: 30 * DAY_SECONDS,
  /** A session is refreshed (expiry pushed out) at most this often. */
  updateAgeSeconds: DAY_SECONDS,
  /** Platform admins: absolute lifetime from sign-in, never extended. */
  platformAdminMaxAgeSeconds: 8 * 60 * 60,
  /** How long the "enter your 2FA code" step stays open after the password was right. */
  twoFactorChallengeSeconds: 10 * 60,
  /** Password-reset links work this long, once. */
  resetTokenExpiresInSeconds: 60 * 60,
});

/** Where each role lands after signing in (role routing). */
export const ROLE_HOME = Object.freeze({
  owner: "/home",
  staff: "/home",
  platform_admin: "/admin",
} satisfies Record<WebRole, string>);

/** The platform admin's 2FA enrolment page (required before /admin). */
export const TWO_FACTOR_SETUP_PATH = "/login/2fa/setup";
/** The "enter your code" step after a platform admin's password. */
export const TWO_FACTOR_VERIFY_PATH = "/login/2fa";
export const LOGIN_PATH = "/login";

/**
 * Why a sign-in or a session was refused. Shown to the user only after the password was proven
 * right (so it reveals nothing to someone guessing logins).
 */
export type SignInBlockReason = "role_not_allowed" | "user_disabled" | "operator_suspended";

/** The facts the policy needs about a user (read fresh from the database). */
export interface SignInSubject {
  readonly role: UserRole;
  readonly status: "active" | "disabled";
  readonly operatorId: string | null;
  /** `null` when the user has no operator (platform admin). */
  readonly operatorStatus: "active" | "suspended" | null;
}

/** `null` when the user may hold a web session, else the reason they may not. */
export function webSignInBlock(subject: SignInSubject): SignInBlockReason | null {
  if (subject.status !== "active") return "user_disabled";
  if (!isWebRole(subject.role)) return "role_not_allowed";
  if (subject.role === "platform_admin")
    return subject.operatorId === null ? null : "role_not_allowed";
  if (subject.operatorId === null) return "role_not_allowed";
  if (subject.operatorStatus !== "active") return "operator_suspended";
  return null;
}

/** The 8-hour cap for a platform admin session that started at `createdAt`. */
export function platformAdminSessionExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_POLICY.platformAdminMaxAgeSeconds * 1000);
}

/**
 * A safe place to go after signing in: a same-site absolute path (`/customers?x=1`), never a
 * protocol-relative (`//evil`) or absolute URL, never back into the auth pages.
 */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (next.includes("\\") || [...next].some((c) => c.charCodeAt(0) < 0x20)) return null;
  const path = next.split(/[?#]/)[0] ?? "";
  if (path === LOGIN_PATH || path.startsWith(`${LOGIN_PATH}/`) || path.startsWith("/reset")) {
    return null;
  }
  return next;
}

/**
 * Where a user goes after signing in: `next` when it is safe and belongs to their side of the app
 * (`/admin…` only for platform admins, never `/admin…` for owners/staff), else their role's home.
 */
export function postSignInPath(role: WebRole, next: unknown): string {
  const safe = safeNextPath(next);
  const home = ROLE_HOME[role];
  if (!safe) return home;
  const isAdminPath = safe === "/admin" || safe.startsWith("/admin/") || safe.startsWith("/admin?");
  if (role === "platform_admin") return isAdminPath ? safe : home;
  return isAdminPath ? home : safe;
}

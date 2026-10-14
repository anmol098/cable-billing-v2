/**
 * Team management (T-032, PLAN §9.3 "Team management, reset lineman password, sign out a phone",
 * §11.6, D-07, D-16): the Owner adds staff and linemen, sets a new password, switches people off
 * and on, and sees each lineman's phones. "Sign out this phone" is T-028's `revokeDevice`.
 *
 * Owner only: every service declares `team.manage` (or `team.view` for the list), so Staff and
 * linemen get FORBIDDEN before anything is read; another tenant's user id is NOT_FOUND (RLS).
 *
 * Security rules:
 * - Passwords are hashed with argon2id (`hashPassword`, T-026) inside the call; the password and
 *   its hash never reach the audit trail, the logs or a return value.
 * - **Switching someone off** sets `users.status = 'disabled'` (never deleted: their payments,
 *   handovers and audit rows stay), deletes their web sessions and revokes every mobile refresh
 *   token (`user_disabled`), all in one transaction. T-026/T-028 re-read the user on every
 *   request, so the next web page or API call is refused (ACCOUNT_DISABLED) and a refresh fails.
 * - **A new password** replaces the credential, revokes the user's mobile refresh tokens
 *   (`password_changed`) and deletes their web sessions: every phone and browser signs in again.
 * - The Owner's own account is never changed here (FORBIDDEN `owner_account`).
 */
import { accounts, devices, LANGUAGES, sessions, sqlStateOf, type Tx, users, uuidv7 } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as z from "zod";
import { hashPassword } from "../auth/password";
import { readTenantMode } from "../authz/writable";
import { defineService } from "../context/service";
import type { TenantContext } from "../context/tenant-context";
import { type FieldIssue, notFound, type ServiceError, serviceError } from "../errors/errors";
import { revokeMobileRefreshTokens } from "../mobile-auth/revoke";
import { checkLinemanFields, checkStaffFields } from "./fields";
import { passwordProblemFor } from "./rules";
import type {
  AddedMember,
  PasswordResetDone,
  StatusChange,
  TeamConflictReason,
  TeamMemberView,
  TeamPhoneView,
  TeamRole,
  TeamView,
} from "./types";

/** Longest text taken from a form field before checking (stops huge posts early). */
const FIELD_MAX = 1_000;

const text = (max = FIELD_MAX) => z.string().max(max);
const optionalText = () => text().optional();

function fieldsError(fields: FieldIssue[]): ServiceError<"VALIDATION"> {
  return serviceError("VALIDATION", "Input failed validation", { fields });
}

function conflict(
  reason: TeamConflictReason,
  field: "login" | "email",
  extra: Record<string, unknown> = {},
): ServiceError<"CONFLICT"> {
  return serviceError("CONFLICT", "Sign-in name or email already used", {
    reason,
    field,
    ...extra,
  });
}

function ownerAccount(): ServiceError<"FORBIDDEN"> {
  return serviceError("FORBIDDEN", "The owner's account is not managed here", {
    reason: "owner_account",
  });
}

function constraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = (current as { constraint?: unknown }).constraint;
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

const ROLE_ORDER = sql`CASE ${users.role} WHEN 'owner' THEN 0 WHEN 'lineman' THEN 1 ELSE 2 END`;
const STATUS_ORDER = sql`CASE ${users.status} WHEN 'active' THEN 0 ELSE 1 END`;

/**
 * The team page (Owner only, works in read-only mode): every user of the tenant with their
 * phones. Passwords and tokens are never read; `passwordSet` only says whether a credential
 * exists (an invited staff member who hasn't used the link yet has none).
 */
export const listTeam = defineService({
  name: "team.list",
  capability: "team.view",
  input: z.object({}).strict(),
  async run({ ctx, tx, now }): Promise<Result<TeamView, ServiceError>> {
    const rows = await tx
      .select({
        id: users.id,
        role: users.role,
        name: users.name,
        login: users.login,
        email: users.email,
        phone: users.phone,
        language: users.language,
        status: users.status,
        createdAt: users.createdAt,
        // Qualified by hand: inside a subquery an unqualified "id" would bind to the inner table.
        passwordSet: sql<boolean>`EXISTS (
          SELECT 1 FROM public.accounts a
           WHERE a.user_id = "users"."id"
             AND a.provider_id = 'credential'
             AND a.password IS NOT NULL)`,
      })
      .from(users)
      .where(eq(users.operatorId, ctx.operatorId))
      .orderBy(ROLE_ORDER, STATUS_ORDER, asc(sql`lower(${users.name})`), asc(users.id));

    const linemanIds = rows.filter((row) => row.role === "lineman").map((row) => row.id);
    const phoneRows =
      linemanIds.length === 0
        ? []
        : await tx
            .select({
              id: devices.id,
              userId: devices.userId,
              deviceCode: devices.deviceCode,
              model: devices.model,
              osVersion: devices.osVersion,
              appVersion: devices.appVersion,
              appVersionCode: devices.appVersionCode,
              lastSeenAt: devices.lastSeenAt,
              signedOutAt: devices.revokedAt,
              liveTokens: sql<number>`(
                SELECT count(*)::int FROM public.mobile_refresh_tokens t
                 WHERE t.device_id = "devices"."id"
                   AND t.user_id = "devices"."user_id"
                   AND t.revoked_at IS NULL
                   AND t.rotated_at IS NULL
                   AND t.expires_at > ${now.toISOString()}::timestamptz)`,
            })
            .from(devices)
            .where(and(eq(devices.operatorId, ctx.operatorId), inArray(devices.userId, linemanIds)))
            .orderBy(sql`${devices.lastSeenAt} DESC NULLS LAST`, desc(devices.createdAt));

    const phonesByUser = new Map<string, TeamPhoneView[]>();
    for (const phone of phoneRows) {
      const list = phonesByUser.get(phone.userId) ?? [];
      list.push({
        id: phone.id,
        deviceCode: phone.deviceCode,
        model: phone.model,
        osVersion: phone.osVersion,
        appVersion: phone.appVersion,
        appVersionCode: phone.appVersionCode,
        lastSeenAt: phone.lastSeenAt,
        signedOutAt: phone.signedOutAt,
        signedIn: phone.signedOutAt === null && Number(phone.liveTokens) > 0,
      });
      phonesByUser.set(phone.userId, list);
    }

    const members: TeamMemberView[] = rows
      .filter((row): row is typeof row & { role: TeamRole } => row.role !== "platform_admin")
      .map((row) => ({
        id: row.id,
        role: row.role,
        name: row.name,
        login: row.login,
        email: row.email,
        phone: row.phone,
        language: row.language,
        status: row.status,
        createdAt: row.createdAt,
        passwordSet: Boolean(row.passwordSet),
        phones: phonesByUser.get(row.id) ?? [],
      }));

    const readOnly = (await readTenantMode(tx)) === "read_only";
    return ok({
      members,
      selfUserId: ctx.userId,
      editable: !readOnly,
      readOnlyReason: readOnly ? "tenant_read_only" : null,
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------------------------

interface NewMember {
  readonly id: string;
  readonly role: "staff" | "lineman";
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly language: (typeof LANGUAGES)[number];
}

/**
 * Inserts the user with the first free sign-in name (each try in a savepoint). A name taken by
 * someone in this team stops at once (`login_in_team`: the Owner is probably adding the same
 * person twice); a name taken by another business moves on to the next candidate.
 */
async function insertMember(
  tx: Tx,
  ctx: TenantContext,
  member: NewMember,
  candidates: readonly string[],
): Promise<Result<string, ServiceError<"CONFLICT">>> {
  for (const login of candidates) {
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint.insert(users).values({
          id: member.id,
          operatorId: ctx.operatorId,
          role: member.role,
          name: member.name,
          login,
          displayLogin: login,
          email: member.email,
          phone: member.phone,
          language: member.language,
        });
      });
      return ok(login);
    } catch (error) {
      if (sqlStateOf(error) !== "23505") throw error;
      const constraint = constraintOf(error);
      if (constraint === "users_email_unique") return err(conflict("email_taken", "email"));
      if (constraint !== "users_login_unique") throw error;
      const [mine] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.operatorId, ctx.operatorId), eq(users.login, login)));
      if (mine) return err(conflict("login_in_team", "login", { userId: mine.id }));
      // Another business uses it: try the next candidate.
    }
  }
  return err(conflict("login_taken", "login"));
}

async function setCredential(tx: Tx, userId: string, password: string, now: Date): Promise<void> {
  const hash = await hashPassword(password);
  const updated = await tx
    .update(accounts)
    .set({ password: hash, updatedAt: now })
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .returning({ id: accounts.id });
  if (updated.length > 0) return;
  await tx.insert(accounts).values({
    id: uuidv7(),
    userId,
    accountId: userId,
    providerId: "credential",
    password: hash,
    createdAt: now,
    updatedAt: now,
  });
}

/** Deletes every web session of the user (Better Auth `sessions`). Returns how many. */
async function endWebSessions(tx: Tx, userId: string): Promise<number> {
  const deleted = await tx
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return deleted.length;
}

export const AddLinemanInput = z.object({
  name: text(),
  /** Indian mobile number (`+91`, spaces and dashes accepted). Also the suggested sign-in name. */
  mobile: text(),
  /** Leave empty to use the mobile number (then `-2`, `-3`… if another business has it). */
  login: optionalText(),
  password: text(),
  /** The lineman app's language. Linemen default to Hindi (D-06). */
  language: z.enum(LANGUAGES).default("hi"),
});
export type AddLinemanCommand = z.input<typeof AddLinemanInput>;

/**
 * "Add lineman": a lineman user with a password the Owner chose (lineman rules, ./rules.ts).
 * They sign in once on their phone (D-07). Returns the sign-in name to share.
 */
export const addLineman = defineService({
  name: "team.add_lineman",
  capability: "team.manage",
  input: AddLinemanInput,
  async run({ ctx, input, tx, audit, log, now }): Promise<Result<AddedMember, ServiceError>> {
    const checked = checkLinemanFields(input);
    if (!checked.ok) return err(fieldsError(checked.fields));
    const { value } = checked;
    const member: NewMember = {
      id: uuidv7(),
      role: "lineman",
      name: value.name,
      phone: value.mobile,
      email: null,
      language: input.language,
    };
    const inserted = await insertMember(tx, ctx, member, value.loginCandidates);
    if (!inserted.ok) return inserted;
    const login = inserted.value;
    await setCredential(tx, member.id, value.password, now);
    await audit.record({
      entityType: "user",
      entityId: member.id,
      after: {
        role: "lineman",
        name: member.name,
        login,
        phone: member.phone,
        language: member.language,
        status: "active",
        sign_in_setup: "set_by_owner",
      },
    });
    log.info("team.member_added", { member_id: member.id, role: "lineman" });
    return ok({
      userId: member.id,
      role: "lineman",
      login,
      loginChanged: value.loginSuggested && login !== value.loginCandidates[0],
      name: member.name,
      phone: member.phone,
      email: null,
      language: member.language,
      invite: false,
    });
  },
});

export const AddStaffInput = z.object({
  name: text(),
  mobile: optionalText(),
  email: optionalText(),
  /** Leave empty to use the mobile number, else the email's first part. */
  login: optionalText(),
  /** `password`: the Owner types a first password now; `invite`: email a link to set one. */
  setup: z.enum(["password", "invite"]),
  password: optionalText(),
  /** The web language of their emails. Default English (the web default, D-06). */
  language: z.enum(LANGUAGES).default("en"),
});
export type AddStaffCommand = z.input<typeof AddStaffInput>;

/**
 * "Add staff": a staff user who signs in on the web. Either the Owner types a first password
 * (web rules: 8+ characters) or the staff member gets an email with a link to set one: this
 * service creates the user **without** a password (`invite: true`) and the caller then asks the
 * auth service to email the link (`AuthService.requestPasswordReset({ invite })`), after commit.
 */
export const addStaff = defineService({
  name: "team.add_staff",
  capability: "team.manage",
  input: AddStaffInput,
  async run({ ctx, input, tx, audit, log, now }): Promise<Result<AddedMember, ServiceError>> {
    const checked = checkStaffFields(input);
    if (!checked.ok) return err(fieldsError(checked.fields));
    const { value } = checked;
    const member: NewMember = {
      id: uuidv7(),
      role: "staff",
      name: value.name,
      phone: value.mobile,
      email: value.email,
      language: input.language,
    };
    const inserted = await insertMember(tx, ctx, member, value.loginCandidates);
    if (!inserted.ok) return inserted;
    const login = inserted.value;
    if (value.password !== null) await setCredential(tx, member.id, value.password, now);
    await audit.record({
      entityType: "user",
      entityId: member.id,
      after: {
        role: "staff",
        name: member.name,
        login,
        phone: member.phone,
        email: member.email,
        language: member.language,
        status: "active",
        sign_in_setup: input.setup === "invite" ? "email_link" : "set_by_owner",
      },
    });
    log.info("team.member_added", { member_id: member.id, role: "staff" });
    return ok({
      userId: member.id,
      role: "staff",
      login,
      loginChanged: value.loginSuggested && login !== value.loginCandidates[0],
      name: member.name,
      phone: member.phone,
      email: member.email,
      language: member.language,
      invite: input.setup === "invite",
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Change an existing member
// ---------------------------------------------------------------------------------------------

const MemberId = z.uuid().transform((id) => id.toLowerCase());

interface LockedMember {
  readonly id: string;
  readonly role: "staff" | "lineman";
  readonly login: string;
  readonly phone: string | null;
  readonly status: "active" | "disabled";
}

/** Locks the member's row. Another tenant's id → NOT_FOUND; the Owner → FORBIDDEN. */
async function lockMember(
  tx: Tx,
  ctx: TenantContext,
  userId: string,
): Promise<Result<LockedMember, ServiceError<"NOT_FOUND" | "FORBIDDEN">>> {
  const [row] = await tx
    .select({
      id: users.id,
      role: users.role,
      login: users.login,
      phone: users.phone,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.operatorId, ctx.operatorId)))
    .for("update");
  if (!row) return err(notFound());
  if (row.role !== "staff" && row.role !== "lineman") return err(ownerAccount());
  return ok({ ...row, role: row.role });
}

export const ResetMemberPasswordInput = z.object({ userId: MemberId, password: text() });
export type ResetMemberPasswordCommand = z.input<typeof ResetMemberPasswordInput>;

/**
 * "New password" (the lineman's "Forgot password" is "Call office", PLAN §11.6; staff without an
 * email too): the Owner sets a new password. Every phone and browser of that person is signed
 * out (mobile refresh tokens revoked `password_changed`, web sessions deleted). Works for a
 * switched-off person too (they stay switched off).
 */
export const resetMemberPassword = defineService({
  name: "team.reset_password",
  capability: "team.manage",
  input: ResetMemberPasswordInput,
  async run({ ctx, input, tx, audit, log, now }): Promise<Result<PasswordResetDone, ServiceError>> {
    const locked = await lockMember(tx, ctx, input.userId);
    if (!locked.ok) return locked;
    const member = locked.value;
    const problem = passwordProblemFor(member.role, input.password, {
      login: member.login,
      mobile: member.phone,
    });
    if (problem) return err(fieldsError([{ path: "password", code: problem }]));

    await setCredential(tx, member.id, input.password, now);
    const revokedTokens = await revokeMobileRefreshTokens(tx, {
      userId: member.id,
      reason: "password_changed",
      now,
    });
    const endedSessions = await endWebSessions(tx, member.id);
    await tx.update(users).set({ updatedAt: now }).where(eq(users.id, member.id));
    await audit.record({
      entityType: "user",
      entityId: member.id,
      after: {
        role: member.role,
        revoked_count: revokedTokens,
        ended_sessions: endedSessions,
      },
    });
    log.info("team.password_set", {
      member_id: member.id,
      revoked_count: revokedTokens,
      ended_sessions: endedSessions,
    });
    return ok({ userId: member.id, role: member.role, revokedTokens, endedSessions });
  },
});

export const MemberStatusInput = z.object({ userId: MemberId });
export type MemberStatusCommand = z.input<typeof MemberStatusInput>;

/**
 * "Switch off": the person can no longer sign in anywhere, at once. Never deletes anything:
 * their payments, handovers and history stay. Payments still saved on a switched-off lineman's
 * phone are not lost (see the T-032 completion notes and T-061). Idempotent.
 */
export const deactivateMember = defineService({
  name: "team.deactivate",
  capability: "team.manage",
  input: MemberStatusInput,
  async run({ ctx, input, tx, audit, log, now }): Promise<Result<StatusChange, ServiceError>> {
    const locked = await lockMember(tx, ctx, input.userId);
    if (!locked.ok) return locked;
    const member = locked.value;
    // Belt and braces even when already off: no sign-in may survive.
    const revokedTokens = await revokeMobileRefreshTokens(tx, {
      userId: member.id,
      reason: "user_disabled",
      now,
    });
    const endedSessions = await endWebSessions(tx, member.id);
    const unchanged = member.status === "disabled";
    if (!unchanged) {
      await tx
        .update(users)
        .set({ status: "disabled", updatedAt: now })
        .where(eq(users.id, member.id));
    }
    if (unchanged && revokedTokens === 0 && endedSessions === 0) {
      audit.skip("no_change");
    } else {
      await audit.record({
        entityType: "user",
        entityId: member.id,
        before: { status: member.status },
        after: {
          status: "disabled",
          role: member.role,
          revoked_count: revokedTokens,
          ended_sessions: endedSessions,
        },
      });
    }
    log.info("team.member_switched_off", {
      member_id: member.id,
      unchanged,
      revoked_count: revokedTokens,
      ended_sessions: endedSessions,
    });
    return ok({
      userId: member.id,
      role: member.role,
      status: "disabled",
      unchanged,
      revokedTokens,
      endedSessions,
    });
  },
});

/**
 * "Switch on again": the person may sign in again (their earlier sign-ins stay ended: phones and
 * browsers sign in with the password). Idempotent.
 */
export const reactivateMember = defineService({
  name: "team.reactivate",
  capability: "team.manage",
  input: MemberStatusInput,
  async run({ ctx, input, tx, audit, log, now }): Promise<Result<StatusChange, ServiceError>> {
    const locked = await lockMember(tx, ctx, input.userId);
    if (!locked.ok) return locked;
    const member = locked.value;
    const unchanged = member.status === "active";
    if (unchanged) {
      audit.skip("no_change");
    } else {
      await tx
        .update(users)
        .set({ status: "active", updatedAt: now })
        .where(eq(users.id, member.id));
      await audit.record({
        entityType: "user",
        entityId: member.id,
        before: { status: "disabled" },
        after: { status: "active", role: member.role },
      });
    }
    log.info("team.member_switched_on", { member_id: member.id, unchanged });
    return ok({
      userId: member.id,
      role: member.role,
      status: "active",
      unchanged,
      revokedTokens: 0,
      endedSessions: 0,
    });
  },
});

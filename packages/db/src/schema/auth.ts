/**
 * Identity (T-021, PLAN §7.2, §9.2, D-07, D-16): users and the Better Auth tables, lineman devices
 * and mobile refresh tokens.
 *
 * Better Auth (T-026) uses `users`, `sessions`, `accounts`, `verifications` and `two_factors`
 * through its Drizzle adapter: pass {@link authSchema} as the adapter's `schema`, map the username
 * plugin's `username` field to `login` and `displayUsername` to `displayLogin`, declare `operatorId`,
 * `role`, `phone`, `language`, `status`, `legacySource`, `legacyId` as additional user fields
 * (`input: false`), and generate ids with `uuidv7()` (the id columns are `uuid`). Property names
 * match Better Auth's field names, so no other mapping is needed. `src/schema/auth.test.ts` runs
 * Better Auth against these tables.
 *
 * Who may touch what (RLS):
 * - Sign-in, sessions, password reset and 2FA run before a tenant is known, so the auth path runs
 *   under `withPlatform` (`app_platform`): it may read, create and update any user (no DELETE) and
 *   fully manage sessions, accounts, verifications and two_factors.
 * - Tenant code (`withTenant`, `app_rw`) sees only its own users (platform admins have no
 *   operator_id, so no tenant ever sees them), and the sessions/accounts of those users (team
 *   management, T-032: add a lineman with a password, reset it, sign a staff member out).
 * - `devices` and `mobile_refresh_tokens` are tenant tables. `app_platform` may only SELECT refresh
 *   tokens (lookup by hash before the tenant is known); rotation and revocation run in `withTenant`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { appPlatform, appRw, operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { languageEnum, operators } from "./tenancy";

/** D-16: three fixed tenant roles plus the platform admin, who belongs to no tenant. */
export const USER_ROLES = ["owner", "staff", "lineman", "platform_admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleEnum = pgEnum("user_role", USER_ROLES);

/** `disabled` users can't sign in (T-032 "deactivate"); they are never deleted. */
export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);

/** Why a mobile refresh token stopped working (T-028). */
export const REFRESH_TOKEN_REVOKE_REASONS = [
  "logout",
  "reuse_detected",
  "device_revoked",
  "user_disabled",
  "password_changed",
] as const;
export type RefreshTokenRevokeReason = (typeof REFRESH_TOKEN_REVOKE_REASONS)[number];
export const refreshTokenRevokeReasonEnum = pgEnum(
  "refresh_token_revoke_reason",
  REFRESH_TOKEN_REVOKE_REASONS,
);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: primaryId(),
    /** The user's tenant. NULL only for platform admins (CHECK below). */
    operatorId: uuid("operator_id").references(() => operators.id),
    role: userRoleEnum("role").notNull(),
    name: text("name").notNull(),
    /**
     * Sign-in name, globally unique and lower-cased (Better Auth username plugin's `username`).
     * Suggested: the mobile number for linemen.
     */
    login: text("login").notNull(),
    /** The login as typed (Better Auth `displayUsername`). Optional. */
    displayLogin: text("display_login"),
    /** Lower-cased (Better Auth lower-cases emails). Linemen usually have none. */
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    phone: text("phone"),
    language: languageEnum("language").notNull(),
    status: userStatusEnum("status").notNull().default("active"),
    /** Better Auth two-factor plugin (required for platform admins, PLAN §9.2). */
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    unique("users_login_unique").on(t.login),
    unique("users_email_unique").on(t.email),
    check(
      "users_operator_matches_role",
      sql`(${t.role} = 'platform_admin') = (${t.operatorId} IS NULL)`,
    ),
    check(
      "users_login_normalized",
      sql`${t.login} = lower(${t.login}) AND ${t.login} !~ '[[:space:]]' AND char_length(${t.login}) BETWEEN 3 AND 100`,
    ),
    check("users_email_lower", sql`${t.email} = lower(${t.email})`),
    check(
      "users_platform_admin_has_email",
      sql`${t.role} <> 'platform_admin' OR ${t.email} IS NOT NULL`,
    ),
    check("users_name_not_blank", sql`btrim(${t.name}) <> ''`),
    ...tenantPolicies(t),
    pgPolicy("users_platform_select", { for: "select", to: appPlatform, using: sql`true` }),
    pgPolicy("users_platform_insert", { for: "insert", to: appPlatform, withCheck: sql`true` }),
    pgPolicy("users_platform_update", {
      for: "update",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/**
 * Policy condition for auth tables keyed by `user_id`: the row belongs to a user of the current
 * tenant. `table` is a literal table name (qualified so the subquery can't capture another column).
 */
function ownTenantUser(table: "sessions" | "accounts") {
  return sql.raw(
    `EXISTS (SELECT 1 FROM public.users u WHERE u.id = ${table}.user_id AND u.operator_id = app.current_operator())`,
  );
}

/** Better Auth `session` (web cookie sessions: owner, staff, platform admin). */
export const sessions = pgTable(
  "sessions",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /**
     * When **this** session passed the TOTP check (sign-in 2FA step or enrolment), or NULL for a
     * password-only session (T-086b). Set by T-026's session-create hook, never copied from an
     * older session. A platform admin's session needs it (`resolveAdminContext`).
     */
    twoFactorVerifiedAt: timestamp("two_factor_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("sessions_token_unique").on(t.token),
    index("sessions_user_id_idx").on(t.userId),
    pgPolicy("sessions_tenant", {
      for: "all",
      to: appRw,
      using: ownTenantUser("sessions"),
      withCheck: ownTenantUser("sessions"),
    }),
    pgPolicy("sessions_platform", {
      for: "all",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** Better Auth `account`: the password hash lives here (`provider_id = 'credential'`). */
export const accounts = pgTable(
  "accounts",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    /** Password hash (argon2id, E-04). Never the password. */
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("accounts_provider_account_unique").on(t.providerId, t.accountId),
    index("accounts_user_id_idx").on(t.userId),
    pgPolicy("accounts_tenant", {
      for: "all",
      to: appRw,
      using: ownTenantUser("accounts"),
      withCheck: ownTenantUser("accounts"),
    }),
    pgPolicy("accounts_platform", {
      for: "all",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** Better Auth `verification` (password-reset and similar one-time tokens). Auth path only. */
export const verifications = pgTable(
  "verifications",
  {
    id: primaryId(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("verifications_identifier_idx").on(t.identifier),
    pgPolicy("verifications_platform", {
      for: "all",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** Better Auth two-factor plugin `twoFactor` (TOTP secret, encrypted by Better Auth). Auth path only. */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [
    index("two_factors_user_id_idx").on(t.userId),
    pgPolicy("two_factors_platform", {
      for: "all",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

/** The Better Auth model → table map for `drizzleAdapter(db, { provider: "pg", schema: authSchema })`. */
export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  twoFactor: twoFactors,
} as const;

/**
 * A lineman's phone (PLAN §7.2, T-028). One row per app installation per operator. `device_code`
 * (3 upper-case letters/digits) is unique per operator forever, revoked devices included, because
 * provisional receipt refs `P-{device_code}-{seq}` must never become ambiguous.
 */
export const devices = pgTable(
  "devices",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    /** The user signed in on this phone now (the last one who signed in). */
    userId: uuid("user_id").notNull(),
    /** Random UUID the app makes once per installation (contract `DeviceInfo.install_id`). */
    installId: uuid("install_id").notNull(),
    deviceCode: text("device_code").notNull(),
    model: text("model"),
    osVersion: text("os_version"),
    appVersion: text("app_version"),
    appVersionCode: integer("app_version_code"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** Set by "Sign out this phone" (T-032); every refresh token of the device stops working. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    tenantKey(t),
    unique("devices_operator_install_unique").on(t.operatorId, t.installId),
    unique("devices_operator_code_unique").on(t.operatorId, t.deviceCode),
    index("devices_operator_user_idx").on(t.operatorId, t.userId),
    foreignKey({
      name: "devices_user_fk",
      columns: [t.operatorId, t.userId],
      foreignColumns: [users.operatorId, users.id],
    }),
    foreignKey({
      name: "devices_revoked_by_fk",
      columns: [t.operatorId, t.revokedBy],
      foreignColumns: [users.operatorId, users.id],
    }),
    check("devices_code_format", sql`${t.deviceCode} ~ '^[A-Z0-9]{3}$'`),
    check(
      "devices_revoked_by_needs_revoked_at",
      sql`${t.revokedBy} IS NULL OR ${t.revokedAt} IS NOT NULL`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

/**
 * Mobile refresh tokens (PLAN §9.2, T-028): 180-day sliding, single use, bound to a device.
 * Only the SHA-256 hash is stored (64 lower-case hex chars, enforced). Every refresh inserts the
 * next token of the same `family_id` and sets `rotated_at` on the old one; presenting a rotated
 * token again is reuse, which revokes the whole family.
 */
export const mobileRefreshTokens = pgTable(
  "mobile_refresh_tokens",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    userId: uuid("user_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    /** The id of the first token of this login; shared by all its rotations. */
    familyId: uuid("family_id").notNull(),
    /** The token this one replaced (NULL for the first token of a family). */
    parentId: uuid("parent_id"),
    /** hex(SHA-256(token)). The token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When it was swapped for its successor (single use). */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: refreshTokenRevokeReasonEnum("revoked_reason"),
  },
  (t) => [
    tenantKey(t),
    unique("mobile_refresh_tokens_hash_unique").on(t.tokenHash),
    index("mobile_refresh_tokens_family_idx").on(t.operatorId, t.familyId),
    index("mobile_refresh_tokens_device_idx").on(t.operatorId, t.deviceId),
    foreignKey({
      name: "mobile_refresh_tokens_user_fk",
      columns: [t.operatorId, t.userId],
      foreignColumns: [users.operatorId, users.id],
    }),
    foreignKey({
      name: "mobile_refresh_tokens_device_fk",
      columns: [t.operatorId, t.deviceId],
      foreignColumns: [devices.operatorId, devices.id],
    }),
    foreignKey({
      name: "mobile_refresh_tokens_parent_fk",
      columns: [t.operatorId, t.parentId],
      foreignColumns: [t.operatorId, t.id],
    }),
    check("mobile_refresh_tokens_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "mobile_refresh_tokens_revoked_consistent",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedReason} IS NULL)`,
    ),
    check("mobile_refresh_tokens_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    ...tenantPolicies(t),
    pgPolicy("mobile_refresh_tokens_platform_select", {
      for: "select",
      to: appPlatform,
      using: sql`true`,
    }),
  ],
).enableRLS();

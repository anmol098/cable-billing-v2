/**
 * Lineman sign-in on Android (T-028, PLAN §9.2, §10.2, §11.6, §11.9, D-07, D-16).
 *
 * `createMobileAuthService(...)` returns the methods behind `/api/mobile/v1`:
 *
 * | Method | Endpoint | What |
 * |---|---|---|
 * | `login` | `POST /auth/login` | lineman only; registers the phone (`devices`), starts a token family |
 * | `refresh` | `POST /auth/refresh` | rotates the refresh token (single use, reuse → family revoked) |
 * | `logout` | `POST /auth/logout` | revokes the token's family; always succeeds |
 * | `authenticate` | every bearer endpoint | access token → TenantContext (channel `mobile`) |
 * | `appConfig` | `GET /app/config` | min version, operator, tenant mode, feature flags |
 *
 * Results use camelCase; apps/web maps them to the contract's wire shapes (`@cb/contracts`) and
 * failures to `ErrorResponse` with the code's HTTP status.
 *
 * **Security rules** (reviewers: see the T-028 completion notes):
 * - No enumeration: an unknown login and a wrong password give the same INVALID_CREDENTIALS after
 *   the same argon2 work. ROLE_NOT_ALLOWED / ACCOUNT_DISABLED only after the password was right.
 * - Rate limits: sign-in shares T-026's per-account and per-IP counters (web and phone attempts
 *   add up); refresh and logout have their own per-IP and per-installation limits. The limiter
 *   fails open (logged), like T-026.
 * - Refresh tokens: random, only SHA-256 stored, single use, 180-day sliding, bound to the
 *   device and installation. Presenting a rotated token again revokes the whole family
 *   (`reuse_detected`), except the one-time grace below.
 * - Grace for a lost refresh response (T-063 follow-up): the **immediately previous** token is
 *   accepted once more within {@link REFRESH_REUSE_GRACE_SECONDS} of its rotation, from the same
 *   installation, only while its successor has never been used and is not revoked. The unused
 *   successor is then retired and a new pair issued. Anything else is reuse.
 * - Every authenticated request re-reads the user, operator, device and token family, so
 *   deactivation, "Sign out this phone" and logout apply to the very next request.
 * - Audit (no PII): `auth.signed_in` / `auth.sign_in_blocked` / `auth.signed_out` with
 *   `channel: "mobile"` (same actions as the web, T-026), `mobile_auth.refresh_reuse_detected`,
 *   and `devices.revoke` (./revoke.ts).
 */
import {
  accounts,
  devices,
  isUuid,
  mobileRefreshTokens,
  operators,
  parseOperatorSettings,
  sqlStateOf,
  type Tx,
  type UserRole,
  users,
  uuidv7,
} from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, eq, isNull } from "drizzle-orm";
import { writeAuditEvent } from "../audit/audit";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  AUTH_RATE_LIMITS,
  type RateLimiter,
  type RateLimitRule,
  rateLimitKey,
} from "../auth/rate-limit";
import { clientInfo, clientIp } from "../auth/request-info";
import { readTenantMode, type TenantMode } from "../authz/writable";
import type { ServiceRuntime } from "../context/runtime";
import {
  assertIssuedTenantContext,
  resolveTenantContext,
  type TenantContext,
} from "../context/tenant-context";
import { errorLogFields } from "../logging/logger";
import { pickFreeDeviceCode } from "./device-code";
import { revokeMobileRefreshTokens } from "./revoke";
import {
  type AccessTokenClaims,
  addSeconds,
  createAccessTokenSigner,
  hashRefreshToken,
  newRefreshToken,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./tokens";
import {
  checkAppVersion,
  DEFAULT_MIN_APP_VERSION_CODE,
  type VersionGateResult,
} from "./version-gate";

/** Limits for the token endpoints (sign-in uses T-026's {@link AUTH_RATE_LIMITS}). */
export const MOBILE_AUTH_RATE_LIMITS = Object.freeze({
  /** A phone refreshes about every 15 minutes; this leaves room for retries. */
  refreshPerInstall: { limit: 30, windowSeconds: 15 * 60 },
  /** Generous: a whole office of phones can share one carrier-grade NAT address. */
  refreshPerIp: { limit: 600, windowSeconds: 15 * 60 },
  logoutPerIp: { limit: 300, windowSeconds: 15 * 60 },
} satisfies Record<string, RateLimitRule>);

/** Why a mobile auth call failed: a contract error code (`@cb/contracts` `ERROR_CODES`). */
export type MobileAuthFailureCode =
  | "VALIDATION"
  | "APP_TOO_OLD"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_DISABLED"
  | "ROLE_NOT_ALLOWED"
  | "REFRESH_TOKEN_INVALID"
  | "DEVICE_REVOKED"
  | "RATE_LIMITED";

export interface MobileAuthFailure {
  readonly code: MobileAuthFailureCode;
  /** Machine detail for logs and tests (never shown to the user). */
  readonly reason?: string;
  /** RATE_LIMITED. */
  readonly retryAfterSeconds?: number;
  /** APP_TOO_OLD. */
  readonly minAppVersionCode?: number;
  /** VALIDATION. */
  readonly fields?: readonly { readonly path: string; readonly issue: string }[];
}

export type MobileAuthResult<T> = Result<T, MobileAuthFailure>;

/** Per request: the request headers (IP, user agent, version, bearer) and the request id. */
export interface MobileRequestMeta {
  readonly headers: Headers;
  /** The id used in logs, audit rows and the error body. */
  readonly requestId: string;
}

export interface MobileDeviceInfo {
  readonly installId: string;
  readonly model: string;
  readonly os: string;
  readonly appVersion: string;
  readonly appVersionCode: number;
}

export interface MobileLoginInput {
  readonly login: string;
  readonly password: string;
  readonly device: MobileDeviceInfo;
}

export interface MobileTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface MobileOperatorInfo {
  readonly id: string;
  readonly name: string;
  readonly officePhone: string | null;
  readonly receiptFooter: string | null;
}

export interface MobileLoginResult {
  readonly tokens: MobileTokens;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly login: string;
    readonly language: "hi" | "en";
  };
  readonly operator: MobileOperatorInfo;
  readonly device: { readonly id: string; readonly deviceCode: string };
}

export interface MobileAppConfig {
  readonly minAppVersionCode: number;
  readonly operator: MobileOperatorInfo;
  readonly tenantMode: TenantMode;
  /** Feature flags by snake_case name; none yet. */
  readonly features: Readonly<Record<string, boolean>>;
}

export interface MobileAuthentication {
  /** channel `mobile`, `deviceId` set: pass it to `service.call`. */
  readonly ctx: TenantContext;
  readonly claims: AccessTokenClaims;
  /** The app's versionCode from the header (null when absent on an ungated endpoint). */
  readonly appVersionCode: number | null;
}

export interface CreateMobileAuthServiceOptions {
  /** Database, logger and clock (the clock decides token expiry: inject it in tests). */
  readonly runtime: ServiceRuntime;
  /** `BETTER_AUTH_SECRET`; the access-token key is derived from it (./tokens.ts). */
  readonly secret: string;
  readonly rateLimiter: RateLimiter;
  /** The force-update minimum (`min_app_version_code`). Default {@link DEFAULT_MIN_APP_VERSION_CODE}. */
  readonly minAppVersionCode?: number;
  /** Feature flags for `/app/config`. Default none. */
  readonly features?: Readonly<Record<string, boolean>>;
}

export interface MobileAuthService {
  readonly minAppVersionCode: number;
  login(
    input: MobileLoginInput,
    meta: MobileRequestMeta,
  ): Promise<MobileAuthResult<MobileLoginResult>>;
  refresh(
    input: { readonly refreshToken: string; readonly installId: string },
    meta: MobileRequestMeta,
  ): Promise<MobileAuthResult<{ readonly tokens: MobileTokens }>>;
  /** Always `ok` for a well-formed request (unknown and revoked tokens included), or RATE_LIMITED. */
  logout(
    input: { readonly refreshToken: string },
    meta: MobileRequestMeta,
  ): Promise<MobileAuthResult<{ readonly revoked: boolean }>>;
  /**
   * Bearer token → TenantContext. `appVersionGate` comes from the endpoint (`ENDPOINTS[x]
   * .appVersionGate`): false only for `/app/config` (and logout, which has no bearer).
   */
  authenticate(
    meta: MobileRequestMeta,
    options: { readonly appVersionGate: boolean },
  ): Promise<MobileAuthResult<MobileAuthentication>>;
  appConfig(ctx: TenantContext): Promise<MobileAppConfig>;
}

const fail = (failure: MobileAuthFailure) => err(failure);

/** Contract limits on `OperatorInfo` / `UserInfo` strings. */
const OPERATOR_PHONE = /^\+?[0-9]{6,19}$/;

/** Builds the service. No I/O until a method is called. */
export function createMobileAuthService(
  options: CreateMobileAuthServiceOptions,
): MobileAuthService {
  const { runtime, rateLimiter } = options;
  const { db, logger } = runtime;
  const signer = createAccessTokenSigner(options.secret);
  const minAppVersionCode = options.minAppVersionCode ?? DEFAULT_MIN_APP_VERSION_CODE;
  if (!Number.isSafeInteger(minAppVersionCode) || minAppVersionCode < 1) {
    throw new TypeError("minAppVersionCode must be a positive integer");
  }
  const features = Object.freeze({ ...(options.features ?? {}) });

  /** Counts one attempt; RATE_LIMITED when over. Fails open (logged) when the limiter is down. */
  async function limit(key: string, rule: RateLimitRule, endpoint: string) {
    try {
      const result = await rateLimiter.hit(key, rule);
      if (result.allowed) return null;
      logger.warn("mobile_auth.rate_limited", {
        endpoint,
        scope: key.split(":").slice(0, 2).join(":"),
      });
      return {
        code: "RATE_LIMITED",
        retryAfterSeconds: result.retryAfterSeconds,
      } satisfies MobileAuthFailure;
    } catch (error) {
      logger.error("mobile_auth.rate_limit_unavailable", {
        limiter: rateLimiter.kind,
        endpoint,
        ...errorLogFields(error),
      });
      return null;
    }
  }

  function gateFailure(gate: Exclude<VersionGateResult, { ok: true }>): MobileAuthFailure {
    if (gate.code === "APP_TOO_OLD") {
      return { code: "APP_TOO_OLD", minAppVersionCode: gate.minAppVersionCode };
    }
    return {
      code: "VALIDATION",
      reason: "app_version_header",
      fields: [{ path: "header.x-app-version-code", issue: "invalid_format" }],
    };
  }

  function auditMeta(meta: MobileRequestMeta) {
    const client = clientInfo(meta.headers);
    return {
      ip: client?.ip ?? null,
      userAgent: client?.userAgent ?? null,
      requestId: meta.requestId,
    };
  }

  function issueTokens(
    claims: Omit<AccessTokenClaims, "iat" | "exp">,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
    now: Date,
  ): MobileTokens {
    const access = signer.issue(claims, now);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  /** Inserts the next refresh token of a family; returns the raw token (never stored). */
  async function insertRefreshToken(
    tx: Tx,
    row: {
      operatorId: string;
      userId: string;
      deviceId: string;
      familyId: string;
      parentId: string | null;
      id?: string;
    },
    now: Date,
  ) {
    const token = newRefreshToken();
    const expiresAt = addSeconds(now, REFRESH_TOKEN_TTL_SECONDS);
    await tx.insert(mobileRefreshTokens).values({
      id: row.id ?? uuidv7(),
      operatorId: row.operatorId,
      userId: row.userId,
      deviceId: row.deviceId,
      familyId: row.familyId,
      parentId: row.parentId,
      tokenHash: hashRefreshToken(token),
      createdAt: now,
      expiresAt,
    });
    return { token, expiresAt };
  }

  // ---------------------------------------------------------------------------------------------
  // login

  type Candidate = {
    userId: string;
    operatorId: string | null;
    role: UserRole;
    status: "active" | "disabled";
    name: string;
    login: string;
    language: "hi" | "en";
    operatorStatus: "active" | "suspended" | null;
    passwordHash: string | null;
  };

  async function findCandidate(login: string): Promise<Candidate | null> {
    const rows = await db.withPlatform(
      (tx) =>
        tx
          .select({
            userId: users.id,
            operatorId: users.operatorId,
            role: users.role,
            status: users.status,
            name: users.name,
            login: users.login,
            language: users.language,
            operatorStatus: operators.status,
            passwordHash: accounts.password,
          })
          .from(users)
          .leftJoin(operators, eq(operators.id, users.operatorId))
          .leftJoin(
            accounts,
            and(eq(accounts.userId, users.id), eq(accounts.providerId, "credential")),
          )
          .where(eq(users.login, login))
          .limit(1),
      { accessMode: "read only" },
    );
    return rows[0] ?? null;
  }

  function blockOf(candidate: Candidate) {
    if (candidate.status !== "active")
      return { code: "ACCOUNT_DISABLED", reason: "user_disabled" } as const;
    if (candidate.role !== "lineman" || candidate.operatorId === null) {
      return { code: "ROLE_NOT_ALLOWED", reason: "role_not_allowed" } as const;
    }
    if (candidate.operatorStatus !== "active") {
      return { code: "ACCOUNT_DISABLED", reason: "operator_suspended" } as const;
    }
    return null;
  }

  async function auditBlocked(candidate: Candidate, reason: string, meta: MobileRequestMeta) {
    try {
      const write = (tx: Tx) =>
        writeAuditEvent(tx, {
          operatorId: candidate.operatorId,
          actorId: candidate.userId,
          actorRole: candidate.role,
          action: "auth.sign_in_blocked",
          entityType: "user",
          entityId: candidate.userId,
          after: { reason, channel: "mobile" },
          ...auditMeta(meta),
        });
      if (candidate.operatorId === null) await db.withPlatform(write);
      else await db.withTenant(candidate.operatorId, write);
    } catch (error) {
      logger.error("mobile_auth.audit_failed", {
        action: "auth.sign_in_blocked",
        user_id: candidate.userId,
        request_id: meta.requestId,
        ...errorLogFields(error),
      });
    }
  }

  async function operatorInfo(tx: Tx, operatorId: string): Promise<MobileOperatorInfo> {
    const [row] = await tx
      .select({
        id: operators.id,
        name: operators.name,
        phone: operators.phone,
        settings: operators.settings,
      })
      .from(operators)
      .where(eq(operators.id, operatorId))
      .limit(1);
    if (!row) throw new Error("operator row not visible in its own tenant");
    let officePhone: string | null = null;
    let receiptFooter: string | null = null;
    try {
      const settings = parseOperatorSettings(row.settings);
      officePhone = settings.office_phone;
      receiptFooter = settings.receipt_footer;
    } catch (error) {
      logger.error("mobile_auth.operator_settings_invalid", {
        operator_id: row.id,
        ...errorLogFields(error),
      });
    }
    // Fall back to the business phone from sign-up when the office number is not set.
    const businessPhone = row.phone?.replace(/[\s-]/g, "") ?? null;
    if (officePhone === null && businessPhone && OPERATOR_PHONE.test(businessPhone)) {
      officePhone = businessPhone;
    }
    return { id: row.id, name: row.name.slice(0, 200), officePhone, receiptFooter };
  }

  async function registerDevice(
    candidate: Candidate & { operatorId: string },
    device: MobileDeviceInfo,
    meta: MobileRequestMeta,
    now: Date,
  ) {
    const { operatorId, userId } = candidate;
    return db.withTenant(operatorId, async (tx) => {
      const [existing] = await tx
        .select({
          id: devices.id,
          deviceCode: devices.deviceCode,
          userId: devices.userId,
          revokedAt: devices.revokedAt,
        })
        .from(devices)
        .where(eq(devices.installId, device.installId))
        .for("update");

      const details = {
        userId,
        model: device.model,
        osVersion: device.os,
        appVersion: device.appVersion,
        appVersionCode: device.appVersionCode,
        lastSeenAt: now,
      };
      let deviceId: string;
      let deviceCode: string;
      let endedSessions = 0;
      if (existing) {
        deviceId = existing.id;
        deviceCode = existing.deviceCode;
        // One sign-in per phone: whoever was signed in here before (this user or another) is out.
        endedSessions = await revokeMobileRefreshTokens(tx, {
          deviceId,
          reason: "logout",
          now,
        });
        // A phone the owner signed out may sign in again with a password (T-021 decision 8).
        await tx
          .update(devices)
          .set({ ...details, revokedAt: null, revokedBy: null })
          .where(eq(devices.id, deviceId));
      } else {
        const taken = await tx.select({ code: devices.deviceCode }).from(devices);
        const code = pickFreeDeviceCode(new Set(taken.map((row) => row.code)));
        if (!code) throw new Error("operator has no free device codes left");
        deviceId = uuidv7();
        deviceCode = code;
        await tx.insert(devices).values({
          id: deviceId,
          operatorId,
          installId: device.installId,
          deviceCode,
          createdAt: now,
          ...details,
        });
      }

      const familyId = uuidv7();
      const refresh = await insertRefreshToken(
        tx,
        { id: familyId, operatorId, userId, deviceId, familyId, parentId: null },
        now,
      );
      await writeAuditEvent(tx, {
        operatorId,
        actorId: userId,
        actorRole: candidate.role,
        action: "auth.signed_in",
        entityType: "user",
        entityId: userId,
        after: {
          channel: "mobile",
          method: "password",
          device_id: deviceId,
          device_code: deviceCode,
          new_device: !existing,
          was_revoked: Boolean(existing?.revokedAt),
          previous_user_signed_out: Boolean(existing && existing.userId !== userId),
          ended_sessions: endedSessions,
          app_version_code: device.appVersionCode,
        },
        ...auditMeta(meta),
      });
      const operator = await operatorInfo(tx, operatorId);
      return { deviceId, deviceCode, familyId, refresh, operator, newDevice: !existing };
    });
  }

  async function login(
    input: MobileLoginInput,
    meta: MobileRequestMeta,
  ): Promise<MobileAuthResult<MobileLoginResult>> {
    const gate = checkAppVersion(meta.headers, { gated: true, minAppVersionCode });
    if (!gate.ok) return fail(gateFailure(gate));
    if (!isUuid(input.device.installId)) {
      return fail({
        code: "VALIDATION",
        fields: [{ path: "device.install_id", issue: "invalid_format" }],
      });
    }
    const installId = input.device.installId.toLowerCase();

    const ip = clientIp(meta.headers) ?? "unknown";
    const ipLimited = await limit(
      rateLimitKey("signin:ip", ip),
      AUTH_RATE_LIMITS.signInPerIp,
      "login",
    );
    if (ipLimited) return fail(ipLimited);

    const loginName = input.login.trim().toLowerCase();
    const candidate = loginName ? await findCandidate(loginName) : null;
    // Same keys as the web sign-in (T-026): attempts on both channels count together.
    const accountKey = candidate
      ? rateLimitKey("signin:account", candidate.userId)
      : rateLimitKey("signin:login", loginName);
    const accountLimited = await limit(accountKey, AUTH_RATE_LIMITS.signInPerAccount, "login");
    if (accountLimited) return fail(accountLimited);

    let passwordOk = false;
    if (candidate?.passwordHash) {
      passwordOk = await verifyPassword({ hash: candidate.passwordHash, password: input.password });
    } else {
      // Unknown login (or no password set): the same argon2 work, the same answer.
      await hashPassword(input.password);
    }
    if (!candidate || !passwordOk) {
      logger.info("mobile_auth.login_failed", {
        request_id: meta.requestId,
        ...(candidate ? { user_id: candidate.userId } : {}),
      });
      return fail({ code: "INVALID_CREDENTIALS" });
    }

    const block = blockOf(candidate);
    if (block) {
      await auditBlocked(candidate, block.reason, meta);
      logger.warn("mobile_auth.login_blocked", {
        user_id: candidate.userId,
        reason: block.reason,
        request_id: meta.requestId,
      });
      return fail(block);
    }

    const now = runtime.now();
    const lineman = candidate as Candidate & { operatorId: string };
    const device = { ...input.device, installId };
    let registered: Awaited<ReturnType<typeof registerDevice>> | undefined;
    for (let attempt = 1; !registered; attempt += 1) {
      try {
        registered = await registerDevice(lineman, device, meta, now);
      } catch (error) {
        // Two first sign-ins racing on one install id, or on one free device code: try again.
        if (sqlStateOf(error) !== "23505" || attempt >= 5) throw error;
      }
    }

    logger.info("mobile_auth.signed_in", {
      user_id: lineman.userId,
      operator_id: lineman.operatorId,
      device_id: registered.deviceId,
      new_device: registered.newDevice,
      request_id: meta.requestId,
    });
    return ok({
      tokens: issueTokens(
        {
          sub: lineman.userId,
          op: lineman.operatorId,
          dev: registered.deviceId,
          fam: registered.familyId,
          role: "lineman",
        },
        registered.refresh.token,
        registered.refresh.expiresAt,
        now,
      ),
      user: {
        id: lineman.userId,
        name: lineman.name.slice(0, 200),
        login: lineman.login,
        language: lineman.language,
      },
      operator: registered.operator,
      device: { id: registered.deviceId, deviceCode: registered.deviceCode },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // refresh

  async function refresh(
    input: { readonly refreshToken: string; readonly installId: string },
    meta: MobileRequestMeta,
  ): Promise<MobileAuthResult<{ readonly tokens: MobileTokens }>> {
    const gate = checkAppVersion(meta.headers, { gated: true, minAppVersionCode });
    if (!gate.ok) return fail(gateFailure(gate));
    if (!isUuid(input.installId)) {
      return fail({
        code: "VALIDATION",
        fields: [{ path: "install_id", issue: "invalid_format" }],
      });
    }
    const installId = input.installId.toLowerCase();
    const ip = clientIp(meta.headers) ?? "unknown";
    const ipLimited = await limit(
      rateLimitKey("mobile-refresh:ip", ip),
      MOBILE_AUTH_RATE_LIMITS.refreshPerIp,
      "refresh",
    );
    if (ipLimited) return fail(ipLimited);
    const installLimited = await limit(
      rateLimitKey("mobile-refresh:install", installId),
      MOBILE_AUTH_RATE_LIMITS.refreshPerInstall,
      "refresh",
    );
    if (installLimited) return fail(installLimited);

    const invalid = (reason: string, fields: Record<string, string | number | boolean> = {}) => {
      logger.warn("mobile_auth.refresh_refused", { reason, request_id: meta.requestId, ...fields });
      return fail({ code: "REFRESH_TOKEN_INVALID", reason } satisfies MobileAuthFailure);
    };

    const tokenHash = hashRefreshToken(input.refreshToken);
    const [found] = await db.withPlatform(
      (tx) =>
        tx
          .select({ id: mobileRefreshTokens.id, operatorId: mobileRefreshTokens.operatorId })
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.tokenHash, tokenHash))
          .limit(1),
      { accessMode: "read only" },
    );
    if (!found) return invalid("unknown_token");

    const now = runtime.now();
    return db.withTenant(found.operatorId, async (tx) => {
      const [row] = await tx
        .select()
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.id, found.id))
        .for("update");
      if (!row) return invalid("unknown_token");
      const logIds = { family_id: row.familyId, device_id: row.deviceId, user_id: row.userId };

      const [device] = await tx
        .select({
          id: devices.id,
          installId: devices.installId,
          userId: devices.userId,
          revokedAt: devices.revokedAt,
        })
        .from(devices)
        .where(eq(devices.id, row.deviceId))
        .limit(1);
      if (!device || device.revokedAt || row.revokedReason === "device_revoked") {
        if (device?.revokedAt) {
          await revokeMobileRefreshTokens(tx, {
            deviceId: row.deviceId,
            reason: "device_revoked",
            now,
          });
        }
        logger.warn("mobile_auth.refresh_refused", {
          reason: "device_revoked",
          request_id: meta.requestId,
          ...logIds,
        });
        return fail({
          code: "DEVICE_REVOKED",
          reason: "device_revoked",
        } satisfies MobileAuthFailure);
      }
      if (row.revokedAt) return invalid("revoked", logIds);
      if (device.installId !== installId) return invalid("install_mismatch", logIds);
      if (row.expiresAt.getTime() <= now.getTime()) return invalid("expired", logIds);

      // The token the new one replaces: normally `row`; in the grace case its unused successor.
      let parentId = row.id;
      if (row.rotatedAt) {
        const [child] = await tx
          .select()
          .from(mobileRefreshTokens)
          .where(
            and(
              eq(mobileRefreshTokens.familyId, row.familyId),
              eq(mobileRefreshTokens.parentId, row.id),
            ),
          )
          .for("update");
        const withinGrace =
          now.getTime() - row.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_SECONDS * 1000;
        const graceAllowed =
          child !== undefined &&
          child.rotatedAt === null &&
          child.revokedAt === null &&
          child.expiresAt.getTime() > now.getTime() &&
          withinGrace;
        if (!graceAllowed || !child) {
          const revoked = await revokeMobileRefreshTokens(tx, {
            familyId: row.familyId,
            reason: "reuse_detected",
            now,
          });
          await writeAuditEvent(tx, {
            operatorId: row.operatorId,
            actorId: row.userId,
            actorRole: "lineman",
            action: "mobile_auth.refresh_reuse_detected",
            entityType: "device",
            entityId: row.deviceId,
            after: { family_id: row.familyId, revoked_count: revoked, within_grace: withinGrace },
            ...auditMeta(meta),
          });
          return invalid("reuse_detected", { ...logIds, revoked_count: revoked });
        }
        await tx
          .update(mobileRefreshTokens)
          .set({ rotatedAt: now })
          .where(eq(mobileRefreshTokens.id, child.id));
        parentId = child.id;
        logger.info("mobile_auth.refresh_grace_used", { request_id: meta.requestId, ...logIds });
      }

      const [user] = await tx
        .select({ role: users.role, status: users.status, operatorStatus: operators.status })
        .from(users)
        .innerJoin(operators, eq(operators.id, users.operatorId))
        .where(eq(users.id, row.userId))
        .limit(1);
      if (user?.status !== "active") {
        const revoked = await revokeMobileRefreshTokens(tx, {
          familyId: row.familyId,
          reason: "user_disabled",
          now,
        });
        logger.warn("mobile_auth.refresh_refused", {
          reason: "user_disabled",
          request_id: meta.requestId,
          revoked_count: revoked,
          ...logIds,
        });
        return fail({
          code: "ACCOUNT_DISABLED",
          reason: "user_disabled",
        } satisfies MobileAuthFailure);
      }
      if (user.operatorStatus !== "active") {
        logger.warn("mobile_auth.refresh_refused", {
          reason: "operator_suspended",
          request_id: meta.requestId,
          ...logIds,
        });
        return fail({
          code: "ACCOUNT_DISABLED",
          reason: "operator_suspended",
        } satisfies MobileAuthFailure);
      }
      if (user.role !== "lineman") return invalid("role_changed", logIds);
      if (device.userId !== row.userId) {
        await revokeMobileRefreshTokens(tx, { familyId: row.familyId, reason: "logout", now });
        return invalid("device_user_changed", logIds);
      }

      if (!row.rotatedAt) {
        await tx
          .update(mobileRefreshTokens)
          .set({ rotatedAt: now })
          .where(eq(mobileRefreshTokens.id, row.id));
      }
      const next = await insertRefreshToken(
        tx,
        {
          operatorId: row.operatorId,
          userId: row.userId,
          deviceId: row.deviceId,
          familyId: row.familyId,
          parentId,
        },
        now,
      );
      await tx
        .update(devices)
        .set({
          lastSeenAt: now,
          ...(gate.appVersionCode === null ? {} : { appVersionCode: gate.appVersionCode }),
        })
        .where(eq(devices.id, device.id));
      return ok({
        tokens: issueTokens(
          {
            sub: row.userId,
            op: row.operatorId,
            dev: row.deviceId,
            fam: row.familyId,
            role: "lineman",
          },
          next.token,
          next.expiresAt,
          now,
        ),
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // logout

  async function logout(
    input: { readonly refreshToken: string },
    meta: MobileRequestMeta,
  ): Promise<MobileAuthResult<{ readonly revoked: boolean }>> {
    const ip = clientIp(meta.headers) ?? "unknown";
    const limited = await limit(
      rateLimitKey("mobile-logout:ip", ip),
      MOBILE_AUTH_RATE_LIMITS.logoutPerIp,
      "logout",
    );
    if (limited) return fail(limited);

    const tokenHash = hashRefreshToken(input.refreshToken);
    const [found] = await db.withPlatform(
      (tx) =>
        tx
          .select({ id: mobileRefreshTokens.id, operatorId: mobileRefreshTokens.operatorId })
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.tokenHash, tokenHash))
          .limit(1),
      { accessMode: "read only" },
    );
    if (!found) return ok({ revoked: false });

    const now = runtime.now();
    const revoked = await db.withTenant(found.operatorId, async (tx) => {
      const [row] = await tx
        .select({
          familyId: mobileRefreshTokens.familyId,
          userId: mobileRefreshTokens.userId,
          deviceId: mobileRefreshTokens.deviceId,
          role: users.role,
        })
        .from(mobileRefreshTokens)
        .innerJoin(users, eq(users.id, mobileRefreshTokens.userId))
        .where(eq(mobileRefreshTokens.id, found.id))
        .for("update", { of: mobileRefreshTokens });
      if (!row) return 0;
      const count = await revokeMobileRefreshTokens(tx, {
        familyId: row.familyId,
        reason: "logout",
        now,
      });
      if (count > 0) {
        await writeAuditEvent(tx, {
          operatorId: found.operatorId,
          actorId: row.userId,
          actorRole: row.role,
          action: "auth.signed_out",
          entityType: "user",
          entityId: row.userId,
          after: { channel: "mobile", device_id: row.deviceId },
          ...auditMeta(meta),
        });
        logger.info("mobile_auth.signed_out", {
          user_id: row.userId,
          device_id: row.deviceId,
          request_id: meta.requestId,
        });
      }
      return count;
    });
    return ok({ revoked: revoked > 0 });
  }

  // ---------------------------------------------------------------------------------------------
  // authenticate (every bearer endpoint)

  async function authenticate(
    meta: MobileRequestMeta,
    authOptions: { readonly appVersionGate: boolean },
  ): Promise<MobileAuthResult<MobileAuthentication>> {
    const gate = checkAppVersion(meta.headers, {
      gated: authOptions.appVersionGate,
      minAppVersionCode,
    });
    if (!gate.ok) return fail(gateFailure(gate));

    const unauthenticated = (reason: string) =>
      fail({ code: "UNAUTHENTICATED", reason } satisfies MobileAuthFailure);
    const header = meta.headers.get("authorization");
    const match = header ? /^Bearer +([^\s]+) *$/i.exec(header) : null;
    if (!match?.[1]) return unauthenticated("missing_token");
    const verified = signer.verify(match[1], runtime.now());
    if (!verified.ok) return unauthenticated(verified.problem);
    const { claims } = verified;

    const client = clientInfo(meta.headers);
    const resolved = await resolveTenantContext(runtime, {
      userId: claims.sub,
      channel: "mobile",
      deviceId: claims.dev,
      requestId: meta.requestId,
      ...(client ? { client } : {}),
    });
    if (!resolved.ok) {
      const reason = String(resolved.error.details?.reason ?? resolved.error.code);
      if (reason === "device_revoked") {
        return fail({ code: "DEVICE_REVOKED", reason } satisfies MobileAuthFailure);
      }
      if (resolved.error.code === "ACCOUNT_DISABLED") {
        return fail({ code: "ACCOUNT_DISABLED", reason } satisfies MobileAuthFailure);
      }
      if (resolved.error.code === "FORBIDDEN") {
        return fail({ code: "ROLE_NOT_ALLOWED", reason } satisfies MobileAuthFailure);
      }
      return unauthenticated(reason);
    }
    const ctx = resolved.value;
    if (ctx.operatorId !== claims.op.toLowerCase()) return unauthenticated("operator_mismatch");

    // Logout, reuse detection or another sign-in on this phone ended the token's family.
    const live = await db.withTenant(
      ctx.operatorId,
      (tx) =>
        tx
          .select({ id: mobileRefreshTokens.id })
          .from(mobileRefreshTokens)
          .where(
            and(
              eq(mobileRefreshTokens.familyId, claims.fam),
              eq(mobileRefreshTokens.deviceId, claims.dev),
              eq(mobileRefreshTokens.userId, claims.sub),
              isNull(mobileRefreshTokens.revokedAt),
            ),
          )
          .limit(1),
      { accessMode: "read only" },
    );
    if (live.length === 0) return unauthenticated("family_revoked");

    return ok({ ctx, claims, appVersionCode: gate.appVersionCode });
  }

  // ---------------------------------------------------------------------------------------------
  // app config

  async function appConfig(ctx: TenantContext): Promise<MobileAppConfig> {
    assertIssuedTenantContext(ctx);
    return db.withTenant(
      ctx.operatorId,
      async (tx) => ({
        minAppVersionCode,
        operator: await operatorInfo(tx, ctx.operatorId),
        tenantMode: await readTenantMode(tx),
        features,
      }),
      { accessMode: "read only" },
    );
  }

  return { minAppVersionCode, login, refresh, logout, authenticate, appConfig };
}

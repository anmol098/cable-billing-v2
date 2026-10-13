/**
 * TenantContext: who is acting, for which tenant (PLAN §9.1 item 1).
 *
 * **The only way to get one is `resolveTenantContext`**, which takes the user id from a verified
 * server session (web, T-026) or a verified access token (mobile, T-028) and reads `operatorId`
 * and `role` from that user's database row. Nothing in a request body, query or header can choose
 * the tenant or the role.
 *
 * Enforced three ways:
 * - by type: `TenantContext` carries a brand keyed by a module-private `unique symbol`, so an
 *   object literal (e.g. built from request JSON) is not assignable to it;
 * - at runtime: every issued context is frozen and remembered in a WeakSet; `defineService`
 *   refuses any context that was not issued here (a cast `as TenantContext` doesn't get through);
 * - by data: operatorId/role/status come from `users` + `operators`, the device from `devices`.
 */
import { devices, isUuid, operators, users } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, eq, isNull } from "drizzle-orm";
import { isTenantRole, type TenantRole } from "../authz/capabilities";
import { type ServiceError, serviceError } from "../errors/errors";
import { isRequestId, type ServiceRuntime } from "./runtime";

/** `web`: owner/staff in the browser. `mobile`: the lineman app (PLAN §9.2, D-16). */
export type Channel = "web" | "mobile";

/** Request metadata kept for the audit trail. Never used for decisions. */
export interface ClientInfo {
  readonly ip?: string;
  readonly userAgent?: string;
}

declare const tenantContextBrand: unique symbol;

export interface TenantContext {
  /** The tenant. From the user's row, never from the request. */
  readonly operatorId: string;
  readonly userId: string;
  /** The user's role now (from the row; role changes apply on the next request). */
  readonly role: TenantRole;
  readonly channel: Channel;
  /** Set exactly when `channel` is `mobile`: the (non-revoked) device the token is bound to. */
  readonly deviceId?: string;
  /** Correlates logs and audit events of one request. */
  readonly requestId: string;
  readonly client?: ClientInfo;
  readonly [tenantContextBrand]: true;
}

/**
 * What the authentication layer proves about the caller. `userId` (and `deviceId` on mobile) must
 * come from a verified session or token, never from request input.
 */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly channel: Channel;
  readonly deviceId?: string;
  readonly requestId: string;
  readonly client?: ClientInfo;
}

export type ContextError = ServiceError<"UNAUTHENTICATED" | "FORBIDDEN" | "ACCOUNT_DISABLED">;

// Shared across duplicate module instances (bundlers can load a package twice, e.g. per layer),
// so a context issued by one copy is accepted by another.
const REGISTRY_KEY = Symbol.for("@cb/core/issued-tenant-contexts");
type Registry = WeakSet<object>;
function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let set = holder[REGISTRY_KEY];
  if (!set) {
    set = new WeakSet();
    holder[REGISTRY_KEY] = set;
  }
  return set;
}

/** True when `value` is a context issued by `resolveTenantContext` (or the test helper). */
export function isIssuedTenantContext(value: unknown): value is TenantContext {
  return typeof value === "object" && value !== null && registry().has(value);
}

/** Throws when `ctx` was not issued here (a forged or cast object). */
export function assertIssuedTenantContext(ctx: unknown): asserts ctx is TenantContext {
  if (!isIssuedTenantContext(ctx)) {
    throw new TypeError(
      "TenantContext was not issued by resolveTenantContext (never build one from request data)",
    );
  }
}

/**
 * Freezes and registers a context. Internal: used by `resolveTenantContext` and by
 * `@cb/core/testing`. Not exported from the package entry point.
 */
export function issueTenantContext(fields: {
  operatorId: string;
  userId: string;
  role: TenantRole;
  channel: Channel;
  deviceId?: string;
  requestId: string;
  client?: ClientInfo;
}): TenantContext {
  const ctx = Object.freeze({
    operatorId: fields.operatorId.toLowerCase(),
    userId: fields.userId.toLowerCase(),
    role: fields.role,
    channel: fields.channel,
    ...(fields.deviceId === undefined ? {} : { deviceId: fields.deviceId.toLowerCase() }),
    requestId: fields.requestId,
    ...(fields.client === undefined ? {} : { client: Object.freeze({ ...fields.client }) }),
  }) as unknown as TenantContext;
  registry().add(ctx);
  return ctx;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-fA-F:.]{2,45}$/;

/** Keeps a well-formed IP (the audit column is `inet`) and a bounded user agent. */
export function sanitizeClientInfo(client: ClientInfo | undefined): ClientInfo | undefined {
  if (!client) return undefined;
  const ip = client.ip?.trim();
  const userAgent = client.userAgent?.slice(0, 512);
  const safe: { ip?: string; userAgent?: string } = {};
  if (ip && (IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip)))) safe.ip = ip;
  if (userAgent) safe.userAgent = userAgent;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** Which roles may use which channel (D-16: lineman = Android only; owner/staff = web). */
const CHANNEL_ROLES: Readonly<Record<Channel, readonly TenantRole[]>> = {
  web: ["owner", "staff"],
  mobile: ["lineman"],
};

const unauthenticated = (reason: string) =>
  serviceError("UNAUTHENTICATED", "Cannot build tenant context", { reason });

/**
 * Builds the TenantContext for an authenticated user (web session or mobile token).
 *
 * - unknown user / malformed id → UNAUTHENTICATED (`reason: "unknown_user"`)
 * - user disabled → ACCOUNT_DISABLED (`reason: "user_disabled"`); operator suspended →
 *   ACCOUNT_DISABLED (`reason: "operator_suspended"`)
 * - platform admin (no tenant) → FORBIDDEN (`reason: "not_a_tenant_user"`)
 * - role not allowed on the channel → FORBIDDEN (`reason: "channel_not_allowed"`)
 * - mobile without a device, or the device is unknown in this tenant or revoked →
 *   UNAUTHENTICATED (`reason: "device_missing"` / `"device_revoked"`)
 *
 * Reads with `withPlatform` (users, operators: the platform role may read them before the tenant
 * is known) and then `withTenant` for the device.
 */
export async function resolveTenantContext(
  runtime: Pick<ServiceRuntime, "db">,
  principal: AuthenticatedPrincipal,
): Promise<Result<TenantContext, ContextError>> {
  if (!isRequestId(principal.requestId)) {
    throw new TypeError("resolveTenantContext: requestId is malformed (use newRequestId())");
  }
  if (!isUuid(principal.userId)) return err(unauthenticated("unknown_user"));
  if (principal.channel !== "web" && principal.channel !== "mobile") {
    return err(unauthenticated("unknown_channel"));
  }

  const rows = await runtime.db.withPlatform(
    (tx) =>
      tx
        .select({
          operatorId: users.operatorId,
          role: users.role,
          status: users.status,
          operatorStatus: operators.status,
        })
        .from(users)
        .leftJoin(operators, eq(operators.id, users.operatorId))
        .where(eq(users.id, principal.userId))
        .limit(1),
    { accessMode: "read only" },
  );
  const user = rows[0];
  if (!user) return err(unauthenticated("unknown_user"));
  if (user.status !== "active") {
    return err(serviceError("ACCOUNT_DISABLED", "User is disabled", { reason: "user_disabled" }));
  }
  if (user.operatorId === null || !isTenantRole(user.role)) {
    return err(serviceError("FORBIDDEN", "Not a tenant user", { reason: "not_a_tenant_user" }));
  }
  if (user.operatorStatus !== "active") {
    return err(
      serviceError("ACCOUNT_DISABLED", "Operator is suspended", { reason: "operator_suspended" }),
    );
  }
  if (!CHANNEL_ROLES[principal.channel].includes(user.role)) {
    return err(
      serviceError("FORBIDDEN", "Role not allowed on this channel", {
        reason: "channel_not_allowed",
      }),
    );
  }

  const operatorId = user.operatorId;
  let deviceId: string | undefined;
  if (principal.channel === "mobile") {
    if (principal.deviceId === undefined || !isUuid(principal.deviceId)) {
      return err(unauthenticated("device_missing"));
    }
    const candidate = principal.deviceId;
    const device = await runtime.db.withTenant(
      operatorId,
      (tx) =>
        tx
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, candidate), isNull(devices.revokedAt)))
          .limit(1),
      { accessMode: "read only" },
    );
    if (device.length === 0) return err(unauthenticated("device_revoked"));
    deviceId = candidate;
  }

  const client = sanitizeClientInfo(principal.client);
  return ok(
    issueTenantContext({
      operatorId,
      userId: principal.userId,
      role: user.role,
      channel: principal.channel,
      ...(deviceId === undefined ? {} : { deviceId }),
      requestId: principal.requestId,
      ...(client === undefined ? {} : { client }),
    }),
  );
}

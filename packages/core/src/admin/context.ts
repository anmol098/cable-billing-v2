/**
 * AdminContext: a verified platform admin with 2-step sign-in on (T-086, PLAN §9.2, §12.4).
 *
 * The only way to get one is {@link resolveAdminContext}, which takes the user id from a verified
 * web session (T-026 `getSession`) and re-reads that user's row: role `platform_admin`, no tenant,
 * active, TOTP enabled. Every admin service refuses a context that was not issued here (a cast
 * object is refused at runtime too), the same way `defineService` treats a `TenantContext`.
 * A tenant user (owner, staff, lineman) can never get one.
 */
import { isUuid, users } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { eq } from "drizzle-orm";
import { isRequestId, type ServiceRuntime } from "../context/runtime";
import { type ClientInfo, sanitizeClientInfo } from "../context/tenant-context";
import { type ServiceError, serviceError } from "../errors/errors";

declare const adminContextBrand: unique symbol;

export interface AdminContext {
  readonly userId: string;
  /** Correlates logs and audit events of one request. */
  readonly requestId: string;
  readonly client?: ClientInfo;
  readonly [adminContextBrand]: true;
}

/** What the web session proves about the caller (T-026 `WebSession`). */
export interface AdminPrincipal {
  readonly userId: string;
  /** The session's user has TOTP on (`WebSession.twoFactorEnabled`). */
  readonly twoFactorEnabled: boolean;
  readonly requestId: string;
  readonly client?: ClientInfo;
}

/** Why a caller is not a usable admin: `details.reason` says which check failed. */
export type AdminContextError = ServiceError<"UNAUTHENTICATED" | "FORBIDDEN" | "ACCOUNT_DISABLED">;

const REGISTRY_KEY = Symbol.for("@cb/core/issued-admin-contexts");
function registry(): WeakSet<object> {
  const holder = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
  let set = holder[REGISTRY_KEY];
  if (!set) {
    set = new WeakSet();
    holder[REGISTRY_KEY] = set;
  }
  return set;
}

/** True when `value` was issued by {@link resolveAdminContext}. */
export function isIssuedAdminContext(value: unknown): value is AdminContext {
  return typeof value === "object" && value !== null && registry().has(value);
}

/** Throws when `ctx` was not issued here (a programming error, never a user error). */
export function assertIssuedAdminContext(ctx: unknown): asserts ctx is AdminContext {
  if (!isIssuedAdminContext(ctx)) {
    throw new TypeError("AdminContext was not issued by resolveAdminContext");
  }
}

function issueAdminContext(fields: {
  userId: string;
  requestId: string;
  client?: ClientInfo;
}): AdminContext {
  const ctx = Object.freeze({
    userId: fields.userId.toLowerCase(),
    requestId: fields.requestId,
    ...(fields.client === undefined ? {} : { client: Object.freeze({ ...fields.client }) }),
  }) as unknown as AdminContext;
  registry().add(ctx);
  return ctx;
}

const refuse = (
  code: AdminContextError["code"],
  reason: string,
): Result<never, AdminContextError> =>
  err(serviceError(code, "Not a usable platform admin", { reason }));

/**
 * Builds the AdminContext for a signed-in user.
 *
 * - unknown user / malformed id → UNAUTHENTICATED `unknown_user`
 * - disabled → ACCOUNT_DISABLED `user_disabled`
 * - a tenant user (any role with a tenant) → FORBIDDEN `not_a_platform_admin`
 * - TOTP not on (session or row) → FORBIDDEN `two_factor_required`
 */
export async function resolveAdminContext(
  runtime: Pick<ServiceRuntime, "db">,
  principal: AdminPrincipal,
): Promise<Result<AdminContext, AdminContextError>> {
  if (!isRequestId(principal.requestId)) {
    throw new TypeError("resolveAdminContext: requestId is malformed (use newRequestId())");
  }
  if (!isUuid(principal.userId)) return refuse("UNAUTHENTICATED", "unknown_user");
  const rows = await runtime.db.withPlatform(
    (tx) =>
      tx
        .select({
          operatorId: users.operatorId,
          role: users.role,
          status: users.status,
          twoFactorEnabled: users.twoFactorEnabled,
        })
        .from(users)
        .where(eq(users.id, principal.userId))
        .limit(1),
    { accessMode: "read only" },
  );
  const user = rows[0];
  if (!user) return refuse("UNAUTHENTICATED", "unknown_user");
  if (user.status !== "active") return refuse("ACCOUNT_DISABLED", "user_disabled");
  if (user.role !== "platform_admin" || user.operatorId !== null) {
    return refuse("FORBIDDEN", "not_a_platform_admin");
  }
  if (!user.twoFactorEnabled || !principal.twoFactorEnabled) {
    return refuse("FORBIDDEN", "two_factor_required");
  }
  const client = sanitizeClientInfo(principal.client);
  return ok(
    issueAdminContext({
      userId: principal.userId,
      requestId: principal.requestId,
      ...(client === undefined ? {} : { client }),
    }),
  );
}

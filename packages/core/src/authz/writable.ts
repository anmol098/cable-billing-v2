/**
 * Read-only mode (D-13, PLAN §9.4, §13): one central check, `assertWritable(tx, ctx, capability)`.
 *
 * A tenant is read-only when its subscription is `read_only` or `cancelled` (PLAN §13: cancelled
 * = "same as read_only"), and — failing closed — when it has no subscription row at all (every
 * provisioned tenant gets one, T-027; a missing row is a data bug, surfaced, not ignored).
 *
 * In read-only mode:
 * - every `read` capability works ("viewing");
 * - write capabilities work only if they are on {@link READ_ONLY_ALLOWLIST}: collections go on
 *   (D-13: "collections are still allowed. Linemen can still sync payments and submit handovers"),
 *   and the owner can still pay the subscription;
 * - everything else gets TENANT_READ_ONLY.
 *
 * Sign-in is not a service capability (T-026/T-028 never call this).
 */
import { type SubscriptionStatus, subscriptions, type Tx } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { type ServiceError, serviceError } from "../errors/errors";
import { type Capability, capabilitySpec } from "./capabilities";

/** `normal` = full access; `read_only` = view + collections (contract `tenant_mode`). */
export type TenantMode = "normal" | "read_only";

/** Subscription states that make the tenant read-only (PLAN §13). */
export const READ_ONLY_STATUSES: readonly SubscriptionStatus[] = ["read_only", "cancelled"];

/**
 * Write capabilities still allowed in read-only mode. Keep in step with `@cb/contracts`
 * (`TENANT_READ_ONLY`: "payments, handovers, receipt links and receipt actions" keep working; only
 * the phone update can get it).
 */
export const READ_ONLY_ALLOWLIST: ReadonlySet<Capability> = new Set<Capability>([
  "payments.record", // collections: Android payment sync and counter payments (D-13)
  "receipts.share", // receipt links and printed/opened actions are part of collecting (T-051)
  "handover.submit", // D-13: linemen can still submit handovers
  "subscription.manage", // PLAN §9.4: subscription payment (how a tenant leaves read-only)
]);

/** The tenant mode for a subscription status; `null` (no row) is read-only (fail closed). */
export function tenantModeOf(status: SubscriptionStatus | null | undefined): TenantMode {
  if (status === null || status === undefined) return "read_only";
  return READ_ONLY_STATUSES.includes(status) ? "read_only" : "normal";
}

/** May `capability` run in `mode`? Pure; the matrix test covers every capability × mode. */
export function isAllowedInMode(capability: Capability, mode: TenantMode): boolean {
  if (mode === "normal") return true;
  if (capabilitySpec(capability).kind === "read") return true;
  return READ_ONLY_ALLOWLIST.has(capability);
}

/**
 * Reads the current tenant's mode inside a `withTenant` transaction (RLS limits `subscriptions`
 * to the tenant's own row). For `GET /app/config` `tenant_mode` and web banners.
 */
export async function readTenantMode(tx: Tx): Promise<TenantMode> {
  const rows = await tx.select({ status: subscriptions.status }).from(subscriptions).limit(1);
  return tenantModeOf(rows[0]?.status ?? null);
}

/**
 * TENANT_READ_ONLY when the tenant is read-only and `capability` is not allowed then. Run it
 * inside the service's `withTenant` transaction (defineService does), so the check and the write
 * see the same subscription state.
 */
export async function assertWritable(
  tx: Tx,
  capability: Capability,
): Promise<Result<void, ServiceError<"TENANT_READ_ONLY">>> {
  if (capabilitySpec(capability).kind === "read") return ok(undefined);
  const mode = await readTenantMode(tx);
  if (isAllowedInMode(capability, mode)) return ok(undefined);
  return err(serviceError("TENANT_READ_ONLY", "Tenant is in read-only mode", { capability }));
}

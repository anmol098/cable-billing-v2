/**
 * Whether the signed-in user may change the settings pages right now (T-030): only the Owner
 * (`business_profile.manage`, PLAN §9.3), and not while the tenant is read-only (D-13). The read
 * services return this so the pages show a form or a read-only view; the write services enforce
 * the same rules on their own (role and read-only checks in `defineService`), so hiding a button
 * is never the only guard.
 */
import type { Tx } from "@cb/db";
import { can } from "../authz/capabilities";
import { readTenantMode } from "../authz/writable";
import type { TenantContext } from "../context/tenant-context";

/** Why the settings are read-only for this user: not the Owner, or the tenant is read-only. */
export type SettingsReadOnlyReason = "not_owner" | "tenant_read_only";

export interface SettingsAccess {
  /** True when the user may save changes (Owner, tenant writable). */
  readonly editable: boolean;
  /** Null when `editable`. `not_owner` wins over `tenant_read_only`. */
  readonly readOnlyReason: SettingsReadOnlyReason | null;
}

/** The settings access for `ctx`, read inside the service's tenant transaction. */
export async function settingsAccess(tx: Tx, ctx: TenantContext): Promise<SettingsAccess> {
  if (!can(ctx.role, "business_profile.manage")) {
    return { editable: false, readOnlyReason: "not_owner" };
  }
  if ((await readTenantMode(tx)) === "read_only") {
    return { editable: false, readOnlyReason: "tenant_read_only" };
  }
  return { editable: true, readOnlyReason: null };
}

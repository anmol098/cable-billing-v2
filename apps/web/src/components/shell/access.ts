/**
 * Role → "may see" for the shell (server side: it imports @cb/core). Visibility always comes from
 * the T-025 capability matrix, never from role names.
 */
import { can, type TenantRole } from "@cb/core";
import type { CanFn } from "@/lib/nav";

/** `(capability) => can(role, capability)`. */
export function roleCan(role: TenantRole): CanFn {
  return (capability) => can(role, capability);
}

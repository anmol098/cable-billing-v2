import { err, ok, type Result } from "@cb/domain";
import type { TenantContext } from "../context/tenant-context";
import { type ServiceError, serviceError } from "../errors/errors";
import { type Capability, can } from "./capabilities";

/** FORBIDDEN unless the context's role has `capability` (PLAN §9.3). */
export function assertRole(
  ctx: Pick<TenantContext, "role">,
  capability: Capability,
): Result<void, ServiceError<"FORBIDDEN">> {
  if (can(ctx.role, capability)) return ok(undefined);
  return err(serviceError("FORBIDDEN", "Role lacks capability", { capability }));
}

/**
 * The admin gate (T-086). **Every** admin layout, page and Server Action calls `getAdminContext()`
 * (a test scans the folder): layouts don't re-run on client navigation and Server Actions can be
 * posted directly, so the layout alone is not a boundary. `src/proxy.ts` only checks for a cookie.
 *
 * 1. T-026 `requirePlatformAdmin()`: no session → /login; a tenant user → /home; an admin who has
 *    not turned on TOTP yet → /login/2fa/setup (platform admin sessions last at most 8 hours).
 * 2. T-086 `resolveAdminContext`: re-reads the user's row (platform_admin, no tenant, active, TOTP
 *    on) and this session's row (T-086b: it must itself have passed TOTP; a password-only session
 *    → /login) and issues the `AdminContext` every admin service requires.
 */
import {
  type AdminContext,
  type AdminContextError,
  clientInfo,
  requestIdFromHeaders,
  resolveAdminContext,
  TWO_FACTOR_SETUP_PATH,
} from "@cb/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { PATHNAME_HEADER } from "@/lib/auth/paths";
import { getServerRuntime } from "@/lib/auth/server";
import { loginRedirectPath, requirePlatformAdmin } from "@/lib/auth/session";

/** Where a refused caller goes (pure, unit-tested). */
export function adminRefusalPath(error: AdminContextError, pathname: string | null): string {
  const reason = error.details?.reason;
  if (reason === "not_a_platform_admin") return "/home";
  if (reason === "two_factor_required") return TWO_FACTOR_SETUP_PATH;
  return loginRedirectPath(pathname);
}

export const getAdminContext = cache(async (): Promise<AdminContext> => {
  const session = await requirePlatformAdmin();
  const requestHeaders = await headers();
  const client = clientInfo(requestHeaders);
  const result = await resolveAdminContext(getServerRuntime(), {
    userId: session.userId,
    sessionId: session.sessionId,
    requestId: requestIdFromHeaders(requestHeaders),
    ...(client ? { client } : {}),
  });
  if (!result.ok) redirect(adminRefusalPath(result.error, requestHeaders.get(PATHNAME_HEADER)));
  return result.value;
});

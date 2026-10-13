/**
 * Server-side auth guards for Server Components, layouts and Server Actions (T-026).
 *
 * `src/proxy.ts` only checks that a session cookie is present (optimistic, Next.js guidance);
 * **these helpers are the real check** and every protected layout, page and action must call one:
 *
 * - `getTenantContext()`: owner/staff pages and actions → the T-025 `TenantContext` (channel
 *   `web`), or a redirect to /login (no/invalid session) or /admin (platform admin).
 * - `requirePlatformAdmin()`: /admin layout (T-086) → the admin's session; redirects to /login,
 *   or to the TOTP enrolment page until 2FA is on.
 * - `getWebSession()`: the checked session or `null`, for pages that render either way.
 *
 * All are memoised per request (`react` `cache`).
 */
import {
  LOGIN_PATH,
  safeNextPath,
  type TenantContext,
  TWO_FACTOR_SETUP_PATH,
  type WebSession,
} from "@cb/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { PATHNAME_HEADER } from "@/lib/auth/paths";
import { getAuthService, getServerRuntime } from "./server";

/** `/login?next=<the page that was asked for>` (the proxy passes the path in a header). */
export function loginRedirectPath(next: string | null | undefined, notice?: string): string {
  const params = new URLSearchParams();
  const safe = safeNextPath(next);
  if (safe) params.set("next", safe);
  if (notice) params.set("notice", notice);
  const query = params.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}

/** The checked web session for this request, or `null`. */
export const getWebSession = cache(async (): Promise<WebSession | null> => {
  return getAuthService().getSession(await headers());
});

/**
 * The TenantContext of the signed-in owner/staff member. Never returns for anyone else: no
 * session → /login, platform admin → /admin.
 */
export const getTenantContext = cache(async (): Promise<TenantContext> => {
  const requestHeaders = await headers();
  const result = await getAuthService().tenantContext(getServerRuntime(), requestHeaders);
  if (result.ok) return result.value;
  if (result.error.code === "FORBIDDEN" && result.error.details?.reason === "not_a_tenant_user") {
    redirect("/admin");
  }
  redirect(loginRedirectPath(requestHeaders.get(PATHNAME_HEADER)));
});

/** The platform admin's session, with TOTP on. */
export async function requirePlatformAdmin(): Promise<WebSession> {
  const session = await getWebSession();
  if (!session) redirect(loginRedirectPath((await headers()).get(PATHNAME_HEADER)));
  if (session.role !== "platform_admin") redirect("/home");
  if (session.twoFactorEnrolmentRequired) redirect(TWO_FACTOR_SETUP_PATH);
  return session;
}

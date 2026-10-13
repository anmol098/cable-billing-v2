/**
 * Next.js 16 Proxy (formerly `middleware.ts`): an **optimistic** sign-in check for the signed-in
 * parts of the app (T-026).
 *
 * It only looks for the session cookie, without touching the database. As Next.js advises, it is
 * not the security boundary: every protected layout, page and Server Action checks the session
 * itself (`getTenantContext()` / `requirePlatformAdmin()` in `@/lib/auth/session`), which also
 * covers a forged, expired or revoked cookie.
 *
 * - No session cookie → redirect to `/login?next=<path>`.
 * - Otherwise passes the asked-for path to the page in `x-cb-pathname` (for the same redirect when
 *   the server-side check fails).
 */
import { type NextRequest, NextResponse } from "next/server";
import { PATHNAME_HEADER, SESSION_COOKIE_NAMES } from "@/lib/auth/paths";

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const asked = `${pathname}${search}`;
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
  if (!hasSessionCookie) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", asked);
    return NextResponse.redirect(login);
  }
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, asked);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Literal values (Next reads them at build time). Same list as PROTECTED_PREFIXES.
  matcher: [
    "/admin/:path*",
    "/home/:path*",
    "/customers/:path*",
    "/payments/:path*",
    "/linemen/:path*",
    "/bills/:path*",
    "/reports/:path*",
    "/settings/:path*",
  ],
};

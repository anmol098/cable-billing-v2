/**
 * Constants shared by `src/proxy.ts` and the server-side guards. Kept free of server imports so
 * the proxy bundle stays small (a test checks they match @cb/core's values).
 */

/** Request header the proxy sets to the asked-for path (`/customers?q=1`), for `?next=`. */
export const PATHNAME_HEADER = "x-cb-pathname";

/** Better Auth's session cookie (`AUTH_COOKIE_PREFIX` + `.session_token`), with and without `__Secure-`. */
export const SESSION_COOKIE_NAMES = ["__Secure-cb.session_token", "cb.session_token"] as const;

/**
 * URL prefixes of the signed-in parts of the app: the `(operator)` route group's sections (PLAN
 * §12.1, created by T-029) and `/admin`. Route groups don't appear in URLs, so they are listed.
 * Keep in sync with `config.matcher` in `src/proxy.ts` (a test checks).
 */
export const PROTECTED_PREFIXES = [
  "/admin",
  "/home",
  "/customers",
  "/payments",
  "/linemen",
  "/bills",
  "/reports",
  "/settings",
] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

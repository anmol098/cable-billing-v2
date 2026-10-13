/**
 * What the auth layer reads from request headers: the client IP (rate limits, audit), the user
 * agent (audit) and the platform request id (logs, audit).
 *
 * On Vercel, `x-real-ip` and `x-forwarded-for` are set by Vercel's edge, which overwrites any
 * client-sent value, so they can be trusted there. Elsewhere (local, CI) they may be missing or
 * client-controlled: they only feed per-IP limits and audit metadata, never a decision about who
 * the user is (per-account limits don't depend on them).
 */

import { requestIdFrom } from "../context/runtime";
import { type ClientInfo, sanitizeClientInfo } from "../context/tenant-context";

/** The headers Better Auth reads the session IP from (same order as {@link clientIp}). */
export const CLIENT_IP_HEADERS = ["x-real-ip", "x-forwarded-for"] as const;

/** The client's IP from the platform headers, or `undefined` when there is none / it is malformed. */
export function clientIp(headers: Headers): string | undefined {
  const real = headers.get("x-real-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return sanitizeClientInfo({ ip: real || forwarded || undefined })?.ip;
}

/** IP + user agent for the audit trail (sanitised: well-formed IP, bounded user agent). */
export function clientInfo(headers: Headers): ClientInfo | undefined {
  return sanitizeClientInfo({
    ip: clientIp(headers),
    userAgent: headers.get("user-agent") ?? undefined,
  });
}

/**
 * The request id: Vercel's `x-vercel-id` (set by the platform) when well-formed, else a new one.
 * Never a header a client chooses (T-025).
 */
export function requestIdFromHeaders(headers: Headers): string {
  return requestIdFrom(headers.get("x-vercel-id"));
}

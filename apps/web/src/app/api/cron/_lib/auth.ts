/**
 * Cron route protection (T-043, PLAN §14): Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 *
 * - `CRON_SECRET` unset → 503 and nothing runs (a route that ran unauthenticated would let anyone
 *   trigger billing work). Previews and local runs have no secret unless one is set.
 * - Missing or wrong header → 401. The comparison hashes both sides to a fixed length and uses
 *   `timingSafeEqual`, so neither the content nor the length of the secret leaks through timing.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type CronAuthResult = "ok" | "not_configured" | "unauthorized";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Pure check of an `Authorization` header against the configured secret. */
export function checkCronAuthorization(
  authorization: string | null | undefined,
  secret: string | undefined,
): CronAuthResult {
  if (!secret) return "not_configured";
  const expected = digest(`Bearer ${secret}`);
  const actual = digest(authorization ?? "");
  // Always compare (also for a missing header) so every path takes the same time.
  const equal = timingSafeEqual(expected, actual);
  return equal && typeof authorization === "string" ? "ok" : "unauthorized";
}

/** A JSON error response for a refused cron call (no detail beyond the code). */
export function cronAuthResponse(result: Exclude<CronAuthResult, "ok">): Response {
  return Response.json(
    { error: result === "not_configured" ? "CRON_NOT_CONFIGURED" : "UNAUTHORIZED" },
    {
      status: result === "not_configured" ? 503 : 401,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

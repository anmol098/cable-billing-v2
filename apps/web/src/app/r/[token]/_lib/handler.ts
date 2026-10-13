/**
 * Shared request handling for `/r/<token>` (page) and `/r/<token>/pdf` (A5 PDF): rate limits,
 * lookup (`openReceiptLink` from @cb/core), headers, and the generic pages.
 *
 * Responses (identical for every token that doesn't open a receipt, so the status and body never
 * tell whether a link existed):
 * - receipt: 200 (HTML or PDF);
 * - unknown, malformed, expired or revoked link: **404** + the generic "link does not work" page;
 * - too many views (per IP / per link): 429 + `Retry-After` + the generic "please wait" page;
 * - server problem (no database configured, database down): 503 + the generic error page.
 *
 * Every response: `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: private, no-store`
 * (no CDN or browser cache of a receipt), `Referrer-Policy: no-referrer` (the token is in the URL).
 */
import {
  clientIp,
  createMemoryRateLimiter,
  createUpstashRateLimiter,
  errorLogFields,
  type Logger,
  type OpenReceiptLinkResult,
  openReceiptLink,
  type PublicReceipt,
  type RateLimiter,
  type ReceiptLinkFormat,
} from "@cb/core";
import { deploymentTarget, serverEnv } from "@/env";
import { getServerRuntime } from "@/lib/auth/server";
import { type GenericPageKind, genericPageHtml } from "./html";

export const RECEIPT_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
});

const STATUS: Record<GenericPageKind, number> = { unavailable: 404, rate_limited: 429, error: 503 };

export function genericResponse(kind: GenericPageKind, retryAfterSeconds?: number): Response {
  return new Response(genericPageHtml(kind), {
    status: STATUS[kind],
    headers: {
      ...RECEIPT_RESPONSE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
    },
  });
}

// One limiter per server instance (kept on globalThis so `next dev` reloads keep the counters).
const LIMITER_KEY = Symbol.for("@cb/web/receipt-link-limiter");
const holder = globalThis as unknown as Record<symbol, RateLimiter | undefined>;

/** Upstash when configured (production requires it), else in memory (local, CI, previews). */
function receiptRateLimiter(logger: Logger): RateLimiter {
  let limiter = holder[LIMITER_KEY];
  if (!limiter) {
    const url = serverEnv.UPSTASH_REDIS_REST_URL;
    const token = serverEnv.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) {
      limiter = createUpstashRateLimiter({ url, token });
    } else {
      if (deploymentTarget(serverEnv) !== "local") {
        logger.warn("receipt_link.rate_limiter_in_memory", { reason: "upstash_not_configured" });
      }
      limiter = createMemoryRateLimiter();
    }
    holder[LIMITER_KEY] = limiter;
  }
  return limiter;
}

export type ReceiptLookup =
  | { readonly kind: "ok"; readonly receipt: PublicReceipt; readonly now: Date }
  | { readonly kind: "response"; readonly response: Response };

/** Rate limits + lookup. On anything but a receipt, the generic response to send. */
export async function lookUpReceipt(
  request: Request,
  token: string,
  format: ReceiptLinkFormat,
): Promise<ReceiptLookup> {
  let runtime: ReturnType<typeof getServerRuntime>;
  try {
    runtime = getServerRuntime();
  } catch (error) {
    // Missing DATABASE_URL / BETTER_AUTH_SECRET (local or CI without a database).
    console.error(
      JSON.stringify({ event: "receipt_link.not_configured", ...errorLogFields(error) }),
    );
    return { kind: "response", response: genericResponse("error") };
  }
  const logger = runtime.logger;
  let result: OpenReceiptLinkResult;
  const now = runtime.now();
  try {
    result = await openReceiptLink(
      { db: runtime.db, limiter: receiptRateLimiter(logger), logger, now: () => now },
      { token, clientIp: clientIp(request.headers), format },
    );
  } catch (error) {
    logger.error("receipt_link.failed", { format, ...errorLogFields(error) });
    return { kind: "response", response: genericResponse("error") };
  }
  if (result.kind === "ok") return { kind: "ok", receipt: result.receipt, now };
  if (result.kind === "rate_limited") {
    return {
      kind: "response",
      response: genericResponse("rate_limited", result.retryAfterSeconds),
    };
  }
  return { kind: "response", response: genericResponse("unavailable") };
}

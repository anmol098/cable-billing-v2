/**
 * Opening a receipt preview link: the public, unauthenticated side (FR-021, PLAN §9.4, RULE-22).
 *
 * There is no user and no tenant context from the client. The token is the only input:
 *
 * 1. **Rate limits** (before anything else, for every request): per client IP and per token
 *    ({@link RECEIPT_LINK_RATE_LIMITS}). Both counters are hit on every request, so the work is the
 *    same whatever the token. Keys are `rateLimitKey(...)` hashes: the IP and the token are never
 *    stored in clear, not even in the limiter.
 * 2. **Lookup by hash** in `withPlatform` (read only; `app_platform` may only SELECT
 *    `receipt_links`). A malformed, unknown, expired or revoked token gives the same
 *    `{ kind: "unavailable" }`: the caller shows one generic page with one status, so the response
 *    never says whether a link existed (no existence oracle). Unknown, expired and revoked tokens
 *    cost the same one indexed SELECT.
 * 3. **Only then the tenant**: `withTenant(link.operator_id)` (the id comes from the database row,
 *    never from the request) counts the access (`access_count`, `last_access_at`, guarded again
 *    against revocation/expiry in the same statement) and reads that one receipt.
 *
 * Access log: one JSON line per request (`receipt_link.opened` / `.unavailable` /
 * `.rate_limited`) with ids, format and counts only. No token, hash, IP, user agent, name or phone.
 */
import type { DbClient } from "@cb/db";
import { receiptLinks } from "@cb/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { type RateLimiter, type RateLimitRule, rateLimitKey } from "../../auth/rate-limit";
import { errorLogFields, type Logger } from "../../logging/logger";
import { hashReceiptLinkToken, isReceiptLinkTokenShape } from "./token";
import { loadPublicReceipt, type PublicReceipt } from "./view";

/**
 * Per-IP limits are generous because many Indian mobile users share one IP (carrier-grade NAT);
 * tokens are 256-bit, so the limits protect the database from floods rather than the secret.
 */
export const RECEIPT_LINK_RATE_LIMITS = Object.freeze({
  /** Page or PDF views from one IP. */
  perIp: { limit: 120, windowSeconds: 10 * 60 },
  /** Views of one link (a customer opening and downloading a few times is far below this). */
  perToken: { limit: 30, windowSeconds: 10 * 60 },
} satisfies Record<string, RateLimitRule>);

export type ReceiptLinkFormat = "html" | "pdf";

export type OpenReceiptLinkResult =
  | { readonly kind: "ok"; readonly receipt: PublicReceipt }
  | { readonly kind: "unavailable" }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number };

export interface OpenReceiptLinkDeps {
  readonly db: Pick<DbClient, "withPlatform" | "withTenant">;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  /** Clock (tests); default `new Date()`. */
  readonly now?: () => Date;
  /** Override the limits (tests). */
  readonly limits?: { readonly perIp: RateLimitRule; readonly perToken: RateLimitRule };
}

export interface OpenReceiptLinkRequest {
  /** The token from the URL, as received. */
  readonly token: string;
  /** The client's IP from the platform headers; `undefined` shares one "unknown" bucket. */
  readonly clientIp: string | undefined;
  readonly format: ReceiptLinkFormat;
}

const UNAVAILABLE: OpenReceiptLinkResult = Object.freeze({ kind: "unavailable" });

async function checkRateLimits(
  deps: OpenReceiptLinkDeps,
  request: OpenReceiptLinkRequest,
  log: Logger,
): Promise<OpenReceiptLinkResult | null> {
  const limits = deps.limits ?? RECEIPT_LINK_RATE_LIMITS;
  try {
    const [ip, token] = await Promise.all([
      deps.limiter.hit(
        rateLimitKey("receipt_link:ip", request.clientIp ?? "unknown"),
        limits.perIp,
      ),
      // Bounded: a huge path segment is hashed by its first 512 characters.
      deps.limiter.hit(
        rateLimitKey("receipt_link:token", request.token.slice(0, 512)),
        limits.perToken,
      ),
    ]);
    if (ip.allowed && token.allowed) return null;
    const scope = ip.allowed ? "token" : "ip";
    log.warn("receipt_link.rate_limited", { scope, format: request.format });
    return {
      kind: "rate_limited",
      retryAfterSeconds: Math.max(ip.retryAfterSeconds, token.retryAfterSeconds, 1),
    };
  } catch (error) {
    // An outage of the shared limiter (Upstash) must not take receipts down: fail open, loudly.
    log.error("receipt_link.rate_limit_failed", errorLogFields(error));
    return null;
  }
}

/** Resolves a token to its receipt (see the module comment). Never throws for a bad token. */
export async function openReceiptLink(
  deps: OpenReceiptLinkDeps,
  request: OpenReceiptLinkRequest,
): Promise<OpenReceiptLinkResult> {
  const log = deps.logger.child({ event_source: "receipt_link", format: request.format });
  const limited = await checkRateLimits(deps, request, log);
  if (limited) return limited;

  if (!isReceiptLinkTokenShape(request.token)) {
    log.info("receipt_link.unavailable", { reason: "malformed" });
    return UNAVAILABLE;
  }
  const now = deps.now?.() ?? new Date();
  const tokenHash = hashReceiptLinkToken(request.token);
  const [link] = await deps.db.withPlatform(
    (tx) =>
      tx
        .select({
          id: receiptLinks.id,
          operatorId: receiptLinks.operatorId,
          receiptId: receiptLinks.receiptId,
          expiresAt: receiptLinks.expiresAt,
          revokedAt: receiptLinks.revokedAt,
        })
        .from(receiptLinks)
        .where(eq(receiptLinks.tokenHash, tokenHash))
        .limit(1),
    { accessMode: "read only" },
  );
  if (!link) {
    log.info("receipt_link.unavailable", { reason: "unknown" });
    return UNAVAILABLE;
  }
  if (link.revokedAt !== null || link.expiresAt.getTime() <= now.getTime()) {
    log.info("receipt_link.unavailable", {
      reason: link.revokedAt !== null ? "revoked" : "expired",
      operator_id: link.operatorId,
      link_id: link.id,
    });
    return UNAVAILABLE;
  }

  const opened = await deps.db.withTenant(link.operatorId, async (tx) => {
    // Count the view, re-checking revocation and expiry in the same statement (a revoke that
    // committed after the lookup wins).
    const [counted] = await tx
      .update(receiptLinks)
      .set({ accessCount: sql`${receiptLinks.accessCount} + 1`, lastAccessAt: now })
      .where(
        and(
          eq(receiptLinks.id, link.id),
          isNull(receiptLinks.revokedAt),
          gt(receiptLinks.expiresAt, now),
        ),
      )
      .returning({ receiptId: receiptLinks.receiptId, accessCount: receiptLinks.accessCount });
    if (!counted) return null;
    const receipt = await loadPublicReceipt(tx, link.operatorId, counted.receiptId);
    return receipt ? { receipt, accessCount: counted.accessCount } : null;
  });
  if (!opened) {
    log.warn("receipt_link.unavailable", {
      reason: "gone_while_opening",
      operator_id: link.operatorId,
      link_id: link.id,
    });
    return UNAVAILABLE;
  }
  log.info("receipt_link.opened", {
    operator_id: link.operatorId,
    receipt_id: link.receiptId,
    link_id: link.id,
    access_count: opened.accessCount,
    cancelled: opened.receipt.cancelled,
  });
  return { kind: "ok", receipt: opened.receipt };
}

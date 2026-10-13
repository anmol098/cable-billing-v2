/**
 * Weekly purge of long-expired receipt links (PLAN §14 `receipt-links-cleanup`, D-14). Receipts
 * themselves are never touched; only the link rows (token hash, counters) go.
 *
 * A link is purged {@link RECEIPT_LINK_PURGE_AFTER_DAYS} days after it expired (revoked links too,
 * once expired): until then the office can still see why a customer's old link no longer opens.
 *
 * Platform job: `withPlatform` lists the tenants that have such links (`app_platform` may SELECT
 * `receipt_links`), then each tenant's rows are deleted in that tenant's `withTenant` transaction
 * (the tenant policy allows DELETE; `app_platform` has no DELETE policy), in batches, with one
 * system audit event per tenant. Idempotent: a re-run deletes whatever is still past the cut-off.
 */
import { receiptLinks } from "@cb/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { continueLater, defineJob } from "../../jobs/definition";

/** Days after expiry before a link row is deleted. */
export const RECEIPT_LINK_PURGE_AFTER_DAYS = 30;
/** Rows deleted per transaction. */
export const RECEIPT_LINK_PURGE_BATCH = 1000;
/** `jobs.dedupe_key` for the weekly run (one live purge job at a time). */
export const RECEIPT_LINK_PURGE_DEDUPE_KEY = "receipts.purge_expired_links";

export const purgeExpiredReceiptLinksJob = defineJob({
  type: "receipts.purge_expired_links",
  scope: "platform",
  payload: z.object({}),
  maxAttempts: 3,
  async run(ctx) {
    const cutoff = new Date(ctx.now.getTime() - RECEIPT_LINK_PURGE_AFTER_DAYS * 86_400_000);
    const tenants = await ctx.db.withPlatform(
      (tx) =>
        tx
          .selectDistinct({ operatorId: receiptLinks.operatorId })
          .from(receiptLinks)
          .where(lt(receiptLinks.expiresAt, cutoff)),
      { accessMode: "read only" },
    );
    let deleted = 0;
    for (const { operatorId } of tenants) {
      for (;;) {
        if (ctx.shouldYield()) {
          ctx.log.info("receipt_link.purge_paused", { deleted });
          return continueLater();
        }
        const removed = await ctx.db.withTenant(operatorId, async (tx) => {
          const batch = await tx
            .select({ id: receiptLinks.id })
            .from(receiptLinks)
            .where(and(eq(receiptLinks.operatorId, operatorId), lt(receiptLinks.expiresAt, cutoff)))
            .limit(RECEIPT_LINK_PURGE_BATCH);
          if (batch.length === 0) return 0;
          const rows = await tx
            .delete(receiptLinks)
            .where(
              and(
                eq(receiptLinks.operatorId, operatorId),
                inArray(
                  receiptLinks.id,
                  batch.map((row) => row.id),
                ),
              ),
            )
            .returning({ id: receiptLinks.id });
          await ctx.audit(tx, {
            operatorId,
            action: "receipt_links.purged",
            entityType: "receipt_link",
            after: { count: rows.length, expired_before: cutoff.toISOString() },
          });
          return rows.length;
        });
        deleted += removed;
        if (removed < RECEIPT_LINK_PURGE_BATCH) break;
      }
    }
    ctx.log.info("receipt_link.purged", { tenants: tenants.length, deleted });
    return undefined;
  },
});

/**
 * Making and switching off receipt preview links (FR-021, PLAN §9.4, D-14). Both services use the
 * capability `receipts.share` (Owner, Staff, Lineman; allowed in read-only mode, D-13): whoever may
 * share a receipt may also switch its links off (e.g. a link sent to the wrong number).
 *
 * **A new link per call (no reuse).** Only `sha256(token)` is stored, so a live link's URL can't be
 * rebuilt later; every call makes a fresh random token. Earlier links of the same receipt keep
 * working until they expire or are revoked. To bound a misbehaving client, a receipt has at most
 * {@link RECEIPT_LINK_MAX_LIVE} live links (CONFLICT `too_many_links` after that).
 */
import { receiptLinks, receipts, uuidv7 } from "@cb/db";
import { err, ok } from "@cb/domain";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../../context/service";
import { notFound, serviceError } from "../../errors/errors";
import { generateReceiptLinkToken, RECEIPT_LINK_TTL_MS } from "./token";

/** Live (unexpired, unrevoked) links one receipt may have at once. */
export const RECEIPT_LINK_MAX_LIVE = 20;

export const CreateReceiptLinkInput = z.object({
  /** The payment whose receipt the link shows (the contract's `paymentId` path parameter). */
  paymentId: z.uuid(),
});

export interface CreatedReceiptLink {
  readonly linkId: string;
  readonly receiptId: string;
  readonly receiptNumber: string;
  /**
   * The secret for the URL (`receiptLinkUrl(baseUrls().receipt, token)`). Returned once, here only.
   * Never log, audit or store it.
   */
  readonly token: string;
  /** When the link stops working (now + 90 days, D-14). */
  readonly expiresAt: Date;
}

/**
 * `receipts.create_link`: a new 90-day preview link for a posted payment's receipt.
 * NOT_FOUND when the payment is not in the tenant (or has no receipt yet).
 */
export const createReceiptLink = defineService<
  typeof CreateReceiptLinkInput,
  CreatedReceiptLink,
  "CONFLICT" | "NOT_FOUND"
>({
  name: "receipts.create_link",
  capability: "receipts.share",
  input: CreateReceiptLinkInput,
  async run({ ctx, input, tx, audit, log, now }) {
    const [receipt] = await tx
      .select({ id: receipts.id, receiptNumber: receipts.receiptNumber })
      .from(receipts)
      .where(and(eq(receipts.operatorId, ctx.operatorId), eq(receipts.paymentId, input.paymentId)))
      .limit(1);
    if (!receipt) return err(notFound());

    const [live] = await tx
      .select({ n: count() })
      .from(receiptLinks)
      .where(
        and(
          eq(receiptLinks.operatorId, ctx.operatorId),
          eq(receiptLinks.receiptId, receipt.id),
          isNull(receiptLinks.revokedAt),
          gt(receiptLinks.expiresAt, now),
        ),
      );
    if ((live?.n ?? 0) >= RECEIPT_LINK_MAX_LIVE) {
      return err(
        serviceError("CONFLICT", "This receipt has too many open links", {
          reason: "too_many_links",
        }),
      );
    }

    const { token, tokenHash } = generateReceiptLinkToken();
    const id = uuidv7();
    const expiresAt = new Date(now.getTime() + RECEIPT_LINK_TTL_MS);
    await tx.insert(receiptLinks).values({
      id,
      operatorId: ctx.operatorId,
      receiptId: receipt.id,
      tokenHash,
      createdAt: now,
      createdBy: ctx.userId,
      expiresAt,
    });
    await audit.record({
      entityType: "receipt_link",
      entityId: id,
      after: { receipt_id: receipt.id, expires_at: expiresAt.toISOString() },
    });
    log.info("receipt_link.created", { receipt_id: receipt.id, link_id: id });
    return ok({
      linkId: id,
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      token,
      expiresAt,
    });
  },
});

export const RevokeReceiptLinksInput = z.object({ paymentId: z.uuid() });

export interface RevokedReceiptLinks {
  readonly receiptId: string;
  /** How many live links were switched off now (0 when there were none). */
  readonly revoked: number;
}

/**
 * `receipts.revoke_links`: switches off every live link of a payment's receipt, at once and for
 * good (revocation is one-way, T-023 trigger). The page then shows the same generic "link does not
 * work" page as for an unknown link. NOT_FOUND when the payment is not in the tenant.
 */
export const revokeReceiptLinks = defineService({
  name: "receipts.revoke_links",
  capability: "receipts.share",
  input: RevokeReceiptLinksInput,
  async run({ ctx, input, tx, audit, log, now }) {
    const [receipt] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.operatorId, ctx.operatorId), eq(receipts.paymentId, input.paymentId)))
      .limit(1);
    if (!receipt) return err(notFound());

    const revoked = await tx
      .update(receiptLinks)
      .set({ revokedAt: now, revokedBy: ctx.userId })
      .where(
        and(
          eq(receiptLinks.operatorId, ctx.operatorId),
          eq(receiptLinks.receiptId, receipt.id),
          isNull(receiptLinks.revokedAt),
          gt(receiptLinks.expiresAt, now),
        ),
      )
      .returning({ id: receiptLinks.id });
    if (revoked.length === 0) {
      audit.skip("no_change");
    } else {
      await audit.record({
        entityType: "receipt",
        entityId: receipt.id,
        after: { revoked_link_ids: revoked.map((link) => link.id) },
      });
    }
    log.info("receipt_link.revoked", { receipt_id: receipt.id, count: revoked.length });
    return ok({ receiptId: receipt.id, revoked: revoked.length });
  },
});

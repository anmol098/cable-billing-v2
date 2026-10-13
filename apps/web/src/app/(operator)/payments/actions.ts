"use server";

/**
 * Server Actions of the payment pages (T-048). Next.js checks the Origin of every Server Action
 * (CSRF); `getTenantContext()` is the sign-in gate (the tenant and role come from the session,
 * never from the browser); the services check the capability, the tenant (another tenant's ids →
 * NOT_FOUND) and read-only mode:
 *
 * - take a counter payment: `payments.post` (Owner, Staff; allowed in read-only mode, D-13),
 *   idempotent on the form's payment id;
 * - copy a receipt link: `receipts.create_link`;
 * - mark a flagged payment as checked: `payments.resolve_review`;
 * - undo a payment: `payments.reverse` (**Owner only**, server-side; audited, append-only).
 */
import {
  createReceiptLink,
  postPayment,
  receiptLinkUrl,
  resolvePaymentReview,
  reversePayment,
  searchCustomers,
} from "@cb/core";
import { revalidatePath } from "next/cache";
import {
  isUndoReason,
  MAX_UNDO_NOTE_LENGTH,
  type UndoReason,
  undoReasonText,
} from "@/components/payments/format";
import {
  type FindCustomersResult,
  type ReceiptLinkResult,
  type ResolveResult,
  receiptLinkErrorKey,
  resolveErrorKey,
  type TakePaymentInput,
  type TakePaymentResult,
  takePaymentErrorKey,
  type UndoResult,
  undoErrorKey,
} from "@/components/payments/results";
import { baseUrls } from "@/env";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

/** Customers matching what was typed in the counter's "Find customer" box (best first). */
export async function findCustomersAction(query: string): Promise<FindCustomersResult> {
  const ctx = await getTenantContext();
  const q = String(query ?? "")
    .trim()
    .slice(0, 100);
  if (!q) return { ok: true, customers: [] };
  const result = await searchCustomers.call(getServerRuntime(), ctx, {
    q,
    status: "all",
    limit: 8,
  });
  if (!result.ok) return { ok: false };
  return {
    ok: true,
    customers: result.value.rows.map((row) => ({
      id: row.id,
      code: row.customerCode,
      name: row.name,
      phone: row.phone,
      areaName: row.areaName,
      balancePaise: row.balancePaise,
      active: row.status === "active",
    })),
  };
}

/**
 * Saves a counter payment. `input.id` is the form's payment id: the same form saved twice (double
 * click, retry after a lost answer) is posted once and both calls get the same receipt.
 */
export async function takePaymentAction(input: TakePaymentInput): Promise<TakePaymentResult> {
  const ctx = await getTenantContext();
  const upiReference = input.method === "upi" ? input.upiReference?.trim() : undefined;
  const result = await postPayment.call(getServerRuntime(), ctx, {
    id: input.id,
    customerId: input.customerId,
    amountPaise: input.amountPaise,
    method: input.method,
    ...(upiReference ? { upiReference } : {}),
  });
  if (!result.ok) {
    if (result.error.code === "INTERNAL")
      console.error("payments.counter_failed", result.error.code);
    return { ok: false, error: takePaymentErrorKey(result.error) };
  }
  const posted = result.value;
  revalidatePath("/payments", "layout");
  revalidatePath(`/customers/${posted.payment.customerId}`, "layout");
  return {
    ok: true,
    payment: {
      paymentId: posted.payment.id,
      outcome: posted.outcome,
      receiptNumber: posted.receipt.receiptNumber,
      amountPaise: posted.payment.amountPaise,
      method: posted.payment.method,
      newBalancePaise: posted.newBalance,
      reviewReason: posted.payment.reviewReason,
      cancelled: posted.reversed,
    },
  };
}

/** A new receipt link (T-050) for the customer; the browser copies it. Never "sent". */
export async function copyReceiptLinkAction(paymentId: string): Promise<ReceiptLinkResult> {
  const ctx = await getTenantContext();
  const result = await createReceiptLink.call(getServerRuntime(), ctx, { paymentId });
  if (!result.ok) return { ok: false, error: receiptLinkErrorKey(result.error) };
  return { ok: true, url: receiptLinkUrl(baseUrls().receipt, result.value.token) };
}

/** Marks a flagged payment as checked, with an optional note. */
export async function resolveReviewAction(input: {
  paymentId: string;
  note?: string;
}): Promise<ResolveResult> {
  const ctx = await getTenantContext();
  const result = await resolvePaymentReview.call(getServerRuntime(), ctx, {
    paymentId: input.paymentId,
    note: input.note ?? null,
  });
  if (!result.ok) return { ok: false, error: resolveErrorKey(result.error) };
  revalidatePath("/payments", "layout");
  return { ok: true };
}

/**
 * Undoes a payment (Owner only; the service refuses everyone else). Stored reason:
 * `<reason code>[: note]`; "other" needs a note.
 */
export async function undoPaymentAction(input: {
  paymentId: string;
  reason: UndoReason;
  note?: string;
}): Promise<UndoResult> {
  const ctx = await getTenantContext();
  if (!isUndoReason(input.reason)) return { ok: false, error: "reason_required" };
  const note = String(input.note ?? "")
    .trim()
    .slice(0, MAX_UNDO_NOTE_LENGTH);
  if (input.reason === "other" && !note) return { ok: false, error: "note_required" };
  const result = await reversePayment.call(getServerRuntime(), ctx, {
    paymentId: input.paymentId,
    reason: undoReasonText(input.reason, note),
  });
  if (!result.ok) return { ok: false, error: undoErrorKey(result.error) };
  revalidatePath("/payments", "layout");
  revalidatePath(`/customers/${result.value.payment.customerId}`, "layout");
  return { ok: true };
}

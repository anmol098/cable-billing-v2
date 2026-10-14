/**
 * Razorpay signatures (documented formats; no SDK):
 *
 * - **Webhooks:** header `X-Razorpay-Signature` = hex HMAC-SHA256 of the **raw request body** with
 *   the webhook secret (`RAZORPAY_WEBHOOK_SECRET`). Verify before parsing: re-serialised JSON would
 *   not match.
 * - **Checkout (subscriptions):** the handler gets `razorpay_signature` = hex HMAC-SHA256 of
 *   `"<razorpay_payment_id>|<subscription_id>"` with the API key secret (`RAZORPAY_KEY_SECRET`).
 *
 * Comparison is constant-time over equal-length digests; a missing, malformed or wrong signature
 * is simply `false` (callers answer 401 without saying which).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** Hex HMAC-SHA256 of `payload` with `secret`. Also used by tests and fixtures to sign bodies. */
export function razorpayHmac(payload: string | Uint8Array, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqualHex(expectedHex: string, given: string | null | undefined): boolean {
  if (typeof given !== "string" || !HEX_SHA256.test(given.trim())) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(given.trim().toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when `signature` is the webhook secret's HMAC of exactly these body bytes. */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  return safeEqualHex(razorpayHmac(rawBody, secret), signature);
}

/** True when Checkout's `razorpay_signature` matches this payment and subscription. */
export function verifyCheckoutSignature(
  args: { paymentId: string; subscriptionId: string; signature: string | null | undefined },
  keySecret: string,
): boolean {
  if (!keySecret) return false;
  return safeEqualHex(
    razorpayHmac(`${args.paymentId}|${args.subscriptionId}`, keySecret),
    args.signature,
  );
}

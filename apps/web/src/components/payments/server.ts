/**
 * Server only. How the payment pages read one payment: the signed-in TenantContext + the server
 * runtime (never ids or roles from the browser). Cached per request, so a page and its
 * `generateMetadata` share one read. A made-up id and another business's payment both give `null`
 * (→ 404).
 */
import { getPayment, type PaymentDetail } from "@cb/core";
import { cache } from "react";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const loadPayment = cache(async (paymentId: string): Promise<PaymentDetail | null> => {
  if (!UUID.test(paymentId)) return null;
  const ctx = await getTenantContext();
  const result = await getPayment.call(getServerRuntime(), ctx, { paymentId });
  if (result.ok) return result.value;
  if (result.error.code === "NOT_FOUND" || result.error.code === "FORBIDDEN") return null;
  throw new Error(`payments.get failed: ${result.error.code}`);
});

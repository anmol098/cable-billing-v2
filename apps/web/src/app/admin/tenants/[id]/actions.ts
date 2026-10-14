"use server";

/**
 * Tenant detail actions (T-086): extend the subscription, record an offline payment, open and end
 * support access. Each calls `getAdminContext()` (the gate), then an admin service that writes the
 * tenant's audit log and the platform log, then redirects back with `?done=` or `?error=` (the page
 * says what happened in words). Works without client JavaScript.
 */
import {
  endSupportAccess,
  extendSubscription,
  grantSupportAccess,
  recordOfflinePayment,
} from "@cb/core";
import { parseRupeesInput } from "@cb/domain";
import { redirect } from "next/navigation";
import { getServerRuntime } from "@/lib/auth/server";
import { getAdminContext } from "../../_lib/context";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function back(operatorId: string, outcome: { done?: string; error?: string }): never {
  const params = new URLSearchParams(outcome as Record<string, string>);
  const safeId = /^[0-9a-f-]{36}$/i.test(operatorId) ? operatorId : "";
  redirect(safeId ? `/admin/tenants/${safeId}?${params.toString()}` : "/admin/tenants");
}

function errorKey(error: { code: string; details?: Readonly<Record<string, unknown>> }): string {
  if (error.code === "VALIDATION") return "validation";
  if (error.code === "NOT_FOUND") return "not_found";
  if (error.code === "CONFLICT") return "conflict";
  console.error("admin.tenant_action_failed", error.code);
  return "generic";
}

export async function extendSubscriptionAction(form: FormData): Promise<void> {
  const ctx = await getAdminContext();
  const operatorId = text(form, "operatorId");
  const result = await extendSubscription.call(getServerRuntime(), ctx, {
    operatorId,
    lastDay: text(form, "lastDay"),
    reason: text(form, "reason"),
  });
  back(
    operatorId,
    result.ok
      ? { done: result.value.changed ? "extended" : "extend_no_change" }
      : { error: errorKey(result.error) },
  );
}

export async function recordOfflinePaymentAction(form: FormData): Promise<void> {
  const ctx = await getAdminContext();
  const operatorId = text(form, "operatorId");
  const amount = parseRupeesInput(text(form, "amountRupees"));
  if (!amount.ok || amount.value.paise === null) back(operatorId, { error: "amount" });
  const reference = text(form, "reference");
  const note = text(form, "note");
  const result = await recordOfflinePayment.call(getServerRuntime(), ctx, {
    operatorId,
    paymentId: text(form, "paymentId"),
    amountPaise: amount.ok ? (amount.value.paise ?? 0) : 0,
    method: text(form, "method") as never,
    receivedOn: text(form, "receivedOn"),
    months: Number.parseInt(text(form, "months"), 10),
    ...(reference ? { reference } : {}),
    ...(note ? { note } : {}),
  });
  back(
    operatorId,
    result.ok
      ? { done: result.value.status === "recorded" ? "payment_recorded" : "payment_already" }
      : { error: errorKey(result.error) },
  );
}

export async function grantSupportAccessAction(form: FormData): Promise<void> {
  const ctx = await getAdminContext();
  const operatorId = text(form, "operatorId");
  const result = await grantSupportAccess.call(getServerRuntime(), ctx, {
    operatorId,
    reason: text(form, "reason"),
  });
  if (!result.ok) back(operatorId, { error: errorKey(result.error) });
  redirect(`/admin/tenants/${operatorId}/support`);
}

export async function endSupportAccessAction(form: FormData): Promise<void> {
  const ctx = await getAdminContext();
  const operatorId = text(form, "operatorId");
  const result = await endSupportAccess.call(getServerRuntime(), ctx, {
    operatorId,
    grantId: text(form, "grantId"),
  });
  back(operatorId, result.ok ? { done: "support_ended" } : { error: errorKey(result.error) });
}

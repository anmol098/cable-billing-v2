"use server";

/**
 * Server Actions of the Owner's "New bill change" (T-045). The tenant and the actor come from the
 * session; `adjustments.create_manual` refuses everyone but the Owner and checks the customer
 * belongs to this business. The form's id makes a double tap or a retry save once.
 */
import { createManualAdjustment } from "@cb/core";
import { revalidatePath } from "next/cache";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { type ManualInput, type ManualResult, manualErrorKey } from "./_parts/results";

export async function createManualAdjustmentAction(input: ManualInput): Promise<ManualResult> {
  const ctx = await getTenantContext();
  try {
    const result = await createManualAdjustment.call(getServerRuntime(), ctx, {
      id: input.id,
      customerId: input.customerId,
      direction: input.direction,
      amountPaise: input.amountPaise,
      reason: String(input.reason ?? ""),
    });
    if (!result.ok) return { ok: false, error: manualErrorKey(result.error) };
    revalidatePath("/bills/adjustments");
    revalidatePath(`/customers/${input.customerId}`, "layout");
    return { ok: true, adjustmentId: result.value.adjustment.id };
  } catch (error) {
    console.error("adjustments.manual_action_failed", error instanceof Error ? error.name : "x");
    return { ok: false, error: "generic" };
  }
}

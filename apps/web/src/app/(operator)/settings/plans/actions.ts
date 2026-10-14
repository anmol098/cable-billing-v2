"use server";

/**
 * Plan Server Actions (T-031). The TenantContext comes from the session; the plan id comes from
 * the page and is only ever looked up inside the caller's tenant (another tenant's id is
 * NOT_FOUND). The core services enforce Owner-only and read-only mode, validate and audit.
 * Amounts arrive in paise from the whole-rupee field (`AmountInput`).
 */
import { type AnyService, createPlan, restorePlan, retirePlan, updatePlan } from "@cb/core";
import { revalidatePath } from "next/cache";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { type PlanActionResult, planErrorKey } from "./action-state";

const PLANS_PATH = "/settings/plans";

async function run(
  service: AnyService,
  input: unknown,
  { showing = false }: { showing?: boolean } = {},
): Promise<PlanActionResult> {
  const ctx = await getTenantContext();
  try {
    const result = await service.call(getServerRuntime(), ctx, input);
    if (!result.ok) {
      // A stale list (someone else changed it) is fixed by showing the fresh one.
      if (result.error.code === "NOT_FOUND") revalidatePath(PLANS_PATH);
      return { ok: false, error: planErrorKey(result.error, showing) };
    }
    revalidatePath(PLANS_PATH);
    const value = result.value as { changed?: unknown };
    return Array.isArray(value?.changed)
      ? { ok: true, changed: value.changed.length > 0 }
      : { ok: true };
  } catch (error) {
    console.error("settings.plan_action_failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, error: "unexpected" };
  }
}

export async function createPlanAction(
  name: string,
  monthlyAmountPaise: number | null,
): Promise<PlanActionResult> {
  if (monthlyAmountPaise === null) return { ok: false, error: "amount_required" };
  return run(createPlan, { name, monthlyAmountPaise });
}

export async function updatePlanAction(
  planId: string,
  name: string,
  monthlyAmountPaise: number | null,
): Promise<PlanActionResult> {
  if (monthlyAmountPaise === null) return { ok: false, error: "amount_required" };
  return run(updatePlan, { planId, name, monthlyAmountPaise });
}

export async function retirePlanAction(planId: string): Promise<PlanActionResult> {
  return run(retirePlan, { planId });
}

export async function restorePlanAction(planId: string): Promise<PlanActionResult> {
  return run(restorePlan, { planId }, { showing: true });
}

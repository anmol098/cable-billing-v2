"use server";

/**
 * "Make bills now" / "Try problems again" Server Actions (T-047, PLAN §8.2, D-16). Next.js checks
 * the Origin of every Server Action (CSRF); `getTenantContext()` is the sign-in gate; the services
 * enforce the rest: `billing.run` is Owner-only (Staff get FORBIDDEN even if they post the action
 * by hand), read-only mode refuses (D-13), another tenant's run is NOT_FOUND. The run itself is done
 * by the `billing.run` job in the background; the page refreshes until it finishes.
 */
import { retryFailedItems, startBillingRun } from "@cb/core";
import { revalidatePath } from "next/cache";
import { type RunActionResult, runErrorKey } from "@/components/bills/run-result";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

function failed(error: { code: string; details?: Readonly<Record<string, unknown>> }) {
  if (error.code === "INTERNAL") console.error("bills.run_action_failed", error.code);
  return { ok: false, error: runErrorKey(error) } as const;
}

export async function startRunAction(input: { period: string }): Promise<RunActionResult> {
  const ctx = await getTenantContext();
  const result = await startBillingRun.call(getServerRuntime(), ctx, { period: input.period });
  if (!result.ok) return failed(result.error);
  revalidatePath("/bills", "layout");
  return { ok: true, outcome: result.value.outcome };
}

export async function retryRunAction(input: { runId: string }): Promise<RunActionResult> {
  const ctx = await getTenantContext();
  const result = await retryFailedItems.call(getServerRuntime(), ctx, { runId: input.runId });
  if (!result.ok) return failed(result.error);
  revalidatePath("/bills", "layout");
  return { ok: true, outcome: result.value.outcome };
}

"use server";

/**
 * Server Actions of the plan-change / back-dated change screen (T-045). The tenant and the actor
 * come from the session; the ids are checked by the services (another business's id is
 * NOT_FOUND). Never trusts the client about who may do what: the services check the role.
 *
 * - `previewChangeAction`: `adjustments.preview_change` (Owner, Staff), nothing saved.
 * - `saveChangeAction`: a plan change today or in a month not yet billed → `connections.change_plan`
 *   (Owner, Staff; T-034's hook makes the netting adjustment); a change that reaches back into a
 *   billed month, or any back-dated status change → `adjustments.back_dated_change` (Owner only,
 *   with the reason).
 */
import {
  backDatedConnectionChange,
  type ConnectionChangeCommand,
  changeConnectionPlan,
  previewConnectionChange,
} from "@cb/core";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/auth/session";
import { callAsUser } from "../../../_components/server";
import { type ChangeInput, changeErrorKey, type PreviewResult, type SaveResult } from "./results";

function changeOf(input: ChangeInput): ConnectionChangeCommand {
  return {
    kind: input.kind,
    planId: input.kind === "plan" ? (input.planId ?? null) : null,
    rentalPaise: input.kind === "plan" ? (input.rentalPaise ?? null) : null,
    stopReason:
      input.kind === "suspend" || input.kind === "disconnect" ? (input.stopReason ?? null) : null,
    note: null,
  };
}

export async function previewChangeAction(input: ChangeInput): Promise<PreviewResult> {
  const ctx = await getTenantContext();
  try {
    const result = await callAsUser(
      previewConnectionChange,
      {
        assignmentId: input.assignmentId,
        effectiveDate: input.effectiveDate,
        change: changeOf(input),
      },
      ctx,
    );
    if (!result.ok) return { ok: false, error: changeErrorKey(result.error) };
    const p = result.value;
    return {
      ok: true,
      preview: {
        kind: p.kind,
        fromRentalPaise: p.fromRentalPaise,
        toRentalPaise: p.toRentalPaise,
        noChange: p.noChange,
        backDated: p.backDated,
        latestBilledPeriod: p.latestBilledPeriod,
        months: p.months.map((m) => ({
          period: m.period,
          scope: m.scope,
          outcome: m.outcome,
          chargedBeforePaise: m.chargedBeforePaise,
          chargedAfterPaise: m.chargedAfterPaise,
        })),
        totalPaise: p.totalPaise,
      },
    };
  } catch (error) {
    console.error("adjustments.preview_action_failed", error instanceof Error ? error.name : "x");
    return { ok: false, error: "generic" };
  }
}

/**
 * Saves the change. `backDated` is what the preview said; the server decides again (a Staff
 * member never reaches the back-dated service: it refuses everyone but the Owner).
 */
export async function saveChangeAction(
  customerId: string,
  input: ChangeInput & { readonly backDated: boolean; readonly reason?: string | null },
): Promise<SaveResult> {
  const ctx = await getTenantContext();
  const reason = String(input.reason ?? "").trim();
  const viaBackDatedFlow = input.backDated || input.kind !== "plan";
  try {
    if (viaBackDatedFlow) {
      if (ctx.role !== "owner") return { ok: false, error: "billed_period" };
      if (reason.length < 3) return { ok: false, error: "reason" };
      const result = await callAsUser(
        backDatedConnectionChange,
        {
          assignmentId: input.assignmentId,
          effectiveDate: input.effectiveDate,
          change: changeOf(input),
          reason,
        },
        ctx,
      );
      if (!result.ok) return { ok: false, error: changeErrorKey(result.error) };
    } else {
      const result = await callAsUser(
        changeConnectionPlan,
        {
          assignmentId: input.assignmentId,
          effectiveDate: input.effectiveDate,
          planId: input.planId ?? null,
          rentalPaise: input.planId ? null : (input.rentalPaise ?? null),
        },
        ctx,
      );
      if (!result.ok) return { ok: false, error: changeErrorKey(result.error) };
    }
  } catch (error) {
    console.error("adjustments.save_action_failed", error instanceof Error ? error.name : "x");
    return { ok: false, error: "generic" };
  }
  revalidatePath(`/customers/${customerId}`, "layout");
  revalidatePath("/bills/adjustments");
  return { ok: true };
}

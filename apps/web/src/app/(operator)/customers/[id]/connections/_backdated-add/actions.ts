"use server";

/**
 * Server Actions of the Owner's "Add connection" (T-045a). The tenant and the actor come from the
 * session; the customer and plan ids are checked by the services (another business's id is
 * NOT_FOUND), and the services check the role: only the Owner can reach
 * `adjustments.back_dated_add`.
 *
 * - `previewAddAction`: `adjustments.preview_add`, nothing saved.
 * - `saveAddAction`: a start day the preview said reaches back into a billed month →
 *   `adjustments.back_dated_add` with the reason and the total the Owner was shown; any other day →
 *   `connections.add` (T-034), which still refuses a billed month with `billed_period` (e.g. when
 *   the preview was not shown yet). When the bills changed after the preview (CONFLICT
 *   `preview_stale`, or VALIDATION `not_back_dated`), nothing is saved and the form asks the Owner
 *   to check the new preview.
 */
import { addConnection, backDatedAddConnection, previewAddConnection } from "@cb/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/auth/session";
import { callAsUser } from "../../../_components/server";
import { connectionFormStateFor } from "../_parts/form-errors";
import {
  type ConnectionFormValues,
  connectionInputFrom,
  connectionValuesFrom,
} from "../_parts/form-state";
import {
  type AddPreviewInput,
  type AddPreviewResult,
  type BackDatedAddFormState,
  previewErrorKey,
  REASON_MAX,
  REASON_MIN,
} from "./state";

/** What adding the connection would do to the bills. Bind the customer id. */
export async function previewAddAction(
  customerId: string,
  input: AddPreviewInput,
): Promise<AddPreviewResult> {
  const ctx = await getTenantContext();
  try {
    const result = await callAsUser(
      previewAddConnection,
      {
        customerId,
        planId: input.planId ?? null,
        rentalPaise: input.planId ? null : (input.rentalPaise ?? null),
        startDate: input.startDate,
      },
      ctx,
    );
    if (!result.ok) return { ok: false, error: previewErrorKey(result.error) };
    const p = result.value;
    return {
      ok: true,
      preview: {
        startDate: p.startDate,
        rentalPaise: p.rentalPaise,
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
    console.error("adjustments.preview_add_failed", error instanceof Error ? error.name : "x");
    return { ok: false, error: "generic" };
  }
}

/** A failed save → what the form shows (a missing reason goes under the reason box). */
function failedState(
  error: { readonly code: string; readonly details?: Readonly<Record<string, unknown>> },
  values: ConnectionFormValues,
  reason: string,
): BackDatedAddFormState {
  const fields = Array.isArray(error.details?.fields)
    ? (error.details.fields as { path?: unknown; code?: unknown }[])
    : [];
  if (error.code === "VALIDATION" && fields.some((f) => f.path === "reason")) {
    return { error: "fix_fields", values, reason, reasonMissing: true };
  }
  const stale =
    (error.code === "CONFLICT" && error.details?.reason === "preview_stale") ||
    (error.code === "VALIDATION" && fields.some((f) => f.code === "not_back_dated"));
  if (stale) return { values, reason, stale: true };
  return { ...connectionFormStateFor(error, values), reason };
}

/** Saves the Owner's "Add connection". Bind the customer id. */
export async function saveAddAction(
  customerId: string,
  _previous: BackDatedAddFormState,
  formData: FormData,
): Promise<BackDatedAddFormState> {
  const ctx = await getTenantContext();
  const values = connectionValuesFrom(formData);
  const backDated = formData.get("backDated") === "1";
  const shown = formData.get("previewTotal");
  const expectedTotalPaise =
    typeof shown === "string" && /^[0-9]{1,15}$/.test(shown) ? Number(shown) : null;
  const typed = formData.get("reason");
  const reason = typeof typed === "string" ? typed.slice(0, REASON_MAX).trim() : "";
  const parsed = connectionInputFrom(values);
  const reasonMissing = backDated && reason.length < REASON_MIN;
  // A back-dated save without the total the Owner was shown: show the preview again.
  if (backDated && expectedTotalPaise === null) return { values, reason, stale: true };
  if (!parsed.ok || reasonMissing) {
    return {
      error: "fix_fields",
      ...(parsed.ok ? {} : { fields: parsed.fields }),
      values,
      reason,
      reasonMissing,
    };
  }
  // "Saved. The bill changes are made." only when there are some (a ₹0 rent makes none).
  let billChanges = false;
  try {
    if (backDated) {
      const result = await callAsUser(
        backDatedAddConnection,
        { customerId, ...parsed.input, reason, expectedTotalPaise: expectedTotalPaise ?? 0 },
        ctx,
      );
      if (!result.ok) return failedState(result.error, values, reason);
      billChanges = result.value.adjustments.length > 0;
    } else {
      const result = await callAsUser(addConnection, { customerId, ...parsed.input }, ctx);
      if (!result.ok) return failedState(result.error, values, reason);
    }
  } catch (error) {
    console.error("adjustments.back_dated_add_failed", error instanceof Error ? error.name : "x");
    return { error: "unexpected", values, reason };
  }
  revalidatePath(`/customers/${customerId}`, "layout");
  if (billChanges) revalidatePath("/bills/adjustments");
  redirect(`/customers/${customerId}/connections?saved=${billChanges ? "backdate" : "added"}`);
}

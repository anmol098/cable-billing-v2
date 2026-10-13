"use server";

/**
 * Connections tab Server Actions (T-034). The tenant and the actor come from the session; the
 * customer / assignment ids are checked by the services (another business's id is NOT_FOUND).
 */
import {
  addConnection,
  disconnectConnection,
  reactivateConnection,
  type StopReason,
  suspendConnection,
} from "@cb/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/auth/session";
import { callAsUser } from "../../_components/server";
import { connectionFormStateFor, statusChangeErrorFor } from "./_parts/form-errors";
import {
  type ConnectionFormState,
  connectionInputFrom,
  connectionValuesFrom,
  type StatusChangeResult,
} from "./_parts/form-state";

/** Saves "Add connection". Bind the customer id: `addConnectionAction.bind(null, id)`. */
export async function addConnectionAction(
  customerId: string,
  _previous: ConnectionFormState,
  formData: FormData,
): Promise<ConnectionFormState> {
  const ctx = await getTenantContext();
  const values = connectionValuesFrom(formData);
  const parsed = connectionInputFrom(values);
  if (!parsed.ok) return { error: "fix_fields", fields: parsed.fields, values };
  try {
    const result = await callAsUser(addConnection, { customerId, ...parsed.input }, ctx);
    if (!result.ok) return connectionFormStateFor(result.error, values);
  } catch (error) {
    console.error("connections.add_action_failed", error instanceof Error ? error.name : "unknown");
    return { error: "unexpected", values };
  }
  revalidatePath(`/customers/${customerId}`, "layout");
  redirect(`/customers/${customerId}/connections?saved=added`);
}

export interface StatusChangeCommand {
  readonly assignmentId: string;
  readonly action: "suspend" | "reactivate" | "disconnect";
  readonly effectiveDate: string;
  readonly reason?: string | null;
  readonly note?: string | null;
}

/** Stop / start again / remove one connection. Bind the customer id (for revalidation). */
export async function changeConnectionStatusAction(
  customerId: string,
  command: StatusChangeCommand,
): Promise<StatusChangeResult> {
  const ctx = await getTenantContext();
  const base = { assignmentId: command.assignmentId, effectiveDate: command.effectiveDate };
  // The services check the reason against the list (VALIDATION → "Choose a reason").
  const reason = (command.reason || null) as StopReason | null;
  const note = command.note?.trim() ? command.note : null;
  try {
    const result =
      command.action === "suspend"
        ? await callAsUser(suspendConnection, { ...base, reason, note }, ctx)
        : command.action === "reactivate"
          ? await callAsUser(reactivateConnection, base, ctx)
          : await callAsUser(
              disconnectConnection,
              { ...base, reason: reason as StopReason, note },
              ctx,
            );
    if (!result.ok)
      return { ok: false, ...statusChangeErrorFor(result.error, ctx.role === "owner") };
  } catch (error) {
    console.error(
      "connections.status_action_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return { ok: false, error: "unexpected" };
  }
  revalidatePath(`/customers/${customerId}`, "layout");
  return { ok: true };
}

"use server";

/**
 * Profile Summary Server Actions (T-033): change details, close / make active again. The tenant
 * and the actor come from the session; the customer id is checked by the service (another
 * business's id is NOT_FOUND).
 */
import { setCustomerStatus, updateCustomer } from "@cb/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/auth/session";
import { customerFormStateFor } from "../../_components/form-errors";
import { type CustomerFormState, orNull, valuesFrom } from "../../_components/form-state";
import { callAsUser } from "../../_components/server";

/** Saves "Change details". Bind the customer id: `updateCustomerAction.bind(null, id)`. */
export async function updateCustomerAction(
  customerId: string,
  _previous: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const ctx = await getTenantContext();
  const values = valuesFrom(formData);
  if (values.customerCode.trim() === "" || values.name.trim() === "") {
    return {
      error: "fix_fields",
      fields: {
        ...(values.customerCode.trim() === "" ? { customerCode: "required" as const } : {}),
        ...(values.name.trim() === "" ? { name: "required" as const } : {}),
      },
      values,
    };
  }
  try {
    const result = await callAsUser(
      updateCustomer,
      {
        customerId,
        customerCode: values.customerCode,
        name: values.name,
        phone: values.phone,
        altPhone: values.altPhone,
        address: orNull(values.address),
        areaId: orNull(values.areaId),
      },
      ctx,
    );
    if (!result.ok) {
      if (result.error.code === "NOT_FOUND" && !orNull(values.areaId)) {
        return { error: "unexpected", values };
      }
      return customerFormStateFor(result.error, values);
    }
  } catch (error) {
    console.error(
      "customers.update_action_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return { error: "unexpected", values };
  }
  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}?saved=changes`);
}

export type StatusActionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: "open_connections" | "read_only" | "not_allowed" | "unexpected";
      readonly count?: number;
    };

/** Closes the customer (`inactive`) or makes it active again. */
export async function setCustomerStatusAction(
  customerId: string,
  status: "active" | "inactive",
): Promise<StatusActionResult> {
  const ctx = await getTenantContext();
  try {
    const result = await callAsUser(setCustomerStatus, { customerId, status }, ctx);
    if (!result.ok) {
      const { code, details } = result.error;
      if (code === "CONFLICT" && details?.reason === "open_connections") {
        const count = Number(details.openConnections);
        return { ok: false, error: "open_connections", ...(count > 0 ? { count } : {}) };
      }
      if (code === "TENANT_READ_ONLY") return { ok: false, error: "read_only" };
      if (code === "FORBIDDEN") return { ok: false, error: "not_allowed" };
      return { ok: false, error: "unexpected" };
    }
  } catch (error) {
    console.error(
      "customers.status_action_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return { ok: false, error: "unexpected" };
  }
  revalidatePath(`/customers/${customerId}`);
  return { ok: true };
}

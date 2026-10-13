"use server";

/**
 * "Add customer" Server Action (T-033). Next.js checks the Origin of every Server Action (CSRF);
 * the tenant comes from the signed-in session, never from the form. On success it opens the new
 * customer's profile; on failure it returns what the form shows (the field that is wrong, e.g. a
 * code that is already used).
 */
import { createCustomer } from "@cb/core";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/auth/session";
import { customerFormStateFor } from "../_components/form-errors";
import { type CustomerFormState, orNull, valuesFrom } from "../_components/form-state";
import { callAsUser } from "../_components/server";

export async function createCustomerAction(
  _previous: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const ctx = await getTenantContext();
  const values = valuesFrom(formData);
  let customerId: string;
  try {
    const result = await callAsUser(
      createCustomer,
      {
        customerCode: values.customerCode,
        name: values.name,
        phone: values.phone,
        altPhone: values.altPhone,
        address: orNull(values.address),
        areaId: orNull(values.areaId),
      },
      ctx,
    );
    if (!result.ok) return customerFormStateFor(result.error, values);
    customerId = result.value.customer.id;
  } catch (error) {
    console.error(
      "customers.create_action_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return { error: "unexpected", values };
  }
  redirect(`/customers/${customerId}?saved=new`);
}

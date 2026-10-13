"use server";

/**
 * "Add customer" with its connection (T-034, J-02): saves the customer and, when a VC number was
 * written in step 2, its connection, in one transaction (`customers.create_with_connections`), so
 * a refused VC never leaves a half-saved customer. A customer problem goes back to step 1, a
 * connection problem to step 2, each with what was typed.
 */
import { createCustomerWithConnections } from "@cb/core";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/auth/session";
import { customerFormStateFor } from "../../../_components/form-errors";
import { orNull, valuesFrom } from "../../../_components/form-state";
import { callAsUser } from "../../../_components/server";
import {
  connectionFormStateFor,
  isConnectionError,
} from "../../../[id]/connections/_parts/form-errors";
import {
  connectionInputFrom,
  connectionValuesFrom,
  isEmptyConnection,
} from "../../../[id]/connections/_parts/form-state";
import { type AddCustomerState, CONNECTIONS_STEP } from "./state";

export async function createCustomerWithConnectionAction(
  _previous: AddCustomerState,
  formData: FormData,
): Promise<AddCustomerState> {
  const ctx = await getTenantContext();
  const values = valuesFrom(formData);
  const connectionValues = connectionValuesFrom(formData);
  const connections = [];
  if (!isEmptyConnection(connectionValues)) {
    const parsed = connectionInputFrom(connectionValues);
    if (!parsed.ok) {
      return {
        error: "fix_fields",
        step: CONNECTIONS_STEP,
        values,
        connection: { error: "fix_fields", fields: parsed.fields, values: connectionValues },
      };
    }
    connections.push(parsed.input);
  }

  let customerId: string;
  try {
    const result = await callAsUser(
      createCustomerWithConnections,
      {
        customer: {
          customerCode: values.customerCode,
          name: values.name,
          phone: values.phone,
          altPhone: values.altPhone,
          address: orNull(values.address),
          areaId: orNull(values.areaId),
        },
        connections,
      },
      ctx,
    );
    if (!result.ok) {
      if (isConnectionError(result.error)) {
        const connection = connectionFormStateFor(result.error, connectionValues);
        const top = connection.error === "customer_closed" ? "unexpected" : connection.error;
        return {
          ...(top ? { error: top } : {}),
          step: CONNECTIONS_STEP,
          values,
          connection,
        };
      }
      return {
        ...customerFormStateFor(result.error, values),
        connection: { values: connectionValues },
      };
    }
    customerId = result.value.customer.id;
  } catch (error) {
    console.error(
      "customers.create_with_connections_action_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return { error: "unexpected", values, connection: { values: connectionValues } };
  }
  redirect(`/customers/${customerId}?saved=new`);
}

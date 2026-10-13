/**
 * Server only. How the customer pages and actions call the T-033 services: the signed-in
 * TenantContext (`getTenantContext()`, never ids from the client) + the server runtime.
 *
 * `loadCustomerProfile(id)` is cached per request, so the profile shell (header + tabs) and the
 * tab page share one read. Another tenant's id and a made-up id both give `null` (→ 404).
 */
import {
  type AnyService,
  customerFormOptions,
  getCustomer,
  type ServiceInput,
  type TenantContext,
} from "@cb/core";
import { cache } from "react";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

/** Calls `service` as the signed-in user. */
export async function callAsUser<S extends AnyService>(
  service: S,
  input: ServiceInput<S>,
  ctx?: TenantContext,
): Promise<Awaited<ReturnType<S["call"]>>> {
  const context = ctx ?? (await getTenantContext());
  return (await service.call(getServerRuntime(), context, input)) as Awaited<ReturnType<S["call"]>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The customer's profile, or `null` when there is no such customer in this business. */
export const loadCustomerProfile = cache(async (customerId: string) => {
  if (!UUID.test(customerId)) return null;
  const result = await callAsUser(getCustomer, { customerId });
  if (result.ok) return result.value;
  if (result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION") return null;
  throw new Error(`customers.get failed: ${result.error.code}`);
});

/** Areas and the next automatic code, for the forms and the list filter. */
export const loadFormOptions = cache(async () => {
  const result = await callAsUser(customerFormOptions, {});
  if (!result.ok) throw new Error(`customers.form_options failed: ${result.error.code}`);
  return result.value;
});

"use server";

/**
 * One import step (T-084): up to 250 lines of whole customers, as the preview's `steps` grouped
 * them, saved by `imports.customers.apply` as the signed-in user (never ids from the client: the
 * lines carry only what the file said, and the service checks them all again).
 */
import { applyCustomerImport, type ImportLine } from "@cb/core";
import { getTenantContext } from "@/lib/auth/session";
import { callAsUser } from "../_components/server";
import type { StepResponse } from "./_lib/types";

export async function importStepAction(lines: ImportLine[]): Promise<StepResponse> {
  // Outside the try: a signed-out user is redirected to sign in.
  const ctx = await getTenantContext();
  try {
    const result = await callAsUser(applyCustomerImport, { lines }, ctx);
    if (result.ok) return { ok: true, result: result.value };
    if (result.error.code === "TENANT_READ_ONLY") return { ok: false, error: "read_only" };
    if (result.error.code === "FORBIDDEN") return { ok: false, error: "not_allowed" };
    console.error("customers.import_step_failed", result.error.code);
    return { ok: false, error: "unexpected" };
  } catch (error) {
    console.error("customers.import_step_failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, error: "unexpected" };
  }
}

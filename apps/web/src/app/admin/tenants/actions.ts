"use server";

/**
 * Create an operator (T-086, PRD J-01). `getAdminContext()` is the gate (platform_admin + TOTP);
 * Next.js checks the Origin of every Server Action (CSRF). The form carries the new operator id
 * made when the page was rendered, so a double submit creates one operator. After it is created
 * the owner gets T-026's "set your password" email (a reset link worded as an invitation).
 */
import { createTenantByAdmin } from "@cb/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthService, getServerRuntime } from "@/lib/auth/server";
import { getAdminContext } from "../_lib/context";

export interface CreateTenantState {
  readonly error?: "validation" | "email_taken" | "login_taken" | "operator_id_in_use" | "generic";
  /** Field names with a problem. */
  readonly fields?: readonly string[];
  readonly values?: Readonly<Record<string, string>>;
}

const FIELDS = [
  "businessName",
  "businessPhone",
  "ownerName",
  "ownerEmail",
  "ownerMobile",
  "language",
] as const;

/** provisionTenant's field paths → this form's field names. */
const PROVISION_PATHS: Readonly<Record<string, string>> = {
  "business.name": "businessName",
  "business.phone": "businessPhone",
  "owner.name": "ownerName",
  "owner.email": "ownerEmail",
  "owner.phone": "ownerMobile",
  "owner.login": "ownerMobile",
};

export async function createTenantAction(
  _previous: CreateTenantState,
  form: FormData,
): Promise<CreateTenantState> {
  const ctx = await getAdminContext();
  const values: Record<string, string> = {};
  for (const name of FIELDS) values[name] = String(form.get(name) ?? "").trim();
  const operatorId = String(form.get("operatorId") ?? "");
  const result = await createTenantByAdmin.call(getServerRuntime(), ctx, {
    operatorId,
    businessName: values.businessName ?? "",
    ...(values.businessPhone ? { businessPhone: values.businessPhone } : {}),
    ownerName: values.ownerName ?? "",
    ownerEmail: values.ownerEmail ?? "",
    ownerMobile: values.ownerMobile ?? "",
    language: values.language === "en" ? "en" : "hi",
  });
  if (!result.ok) {
    const { code, details } = result.error;
    if (code === "VALIDATION") {
      const fields = Array.isArray(details?.fields)
        ? (details.fields as { path: string }[]).map((f) => PROVISION_PATHS[f.path] ?? f.path)
        : [];
      return { error: "validation", fields, values };
    }
    const reason = details?.reason;
    if (
      code === "CONFLICT" &&
      (reason === "email_taken" || reason === "login_taken" || reason === "operator_id_in_use")
    ) {
      return { error: reason, values };
    }
    console.error("admin.create_tenant_failed", code);
    return { error: "generic", values };
  }
  if (result.value.status === "created" && values.ownerEmail) {
    const sent = await getAuthService().requestPasswordReset({
      email: values.ownerEmail,
      headers: await headers(),
      invite: { businessName: values.businessName ?? "", login: result.value.ownerLogin },
    });
    if (!sent.ok) console.error("admin.create_tenant_invite_failed", sent.error.code);
  }
  redirect(`/admin/tenants/${result.value.operatorId}?done=${result.value.status}`);
}

/** Server side of the customer forms: a customer service failure → what the form shows. */
import { type CoreErrorCode, isDuplicateCustomerCode, type ServiceError } from "@cb/core";
import {
  CUSTOMER_FIELDS,
  type CustomerFieldErrorKey,
  type CustomerFieldName,
  type CustomerFormState,
  type CustomerFormValues,
} from "./form-state";

/** Database CHECK / FK names (a value that slipped past the input checks) → the field. */
const CONSTRAINT_FIELDS: Record<string, [CustomerFieldName, CustomerFieldErrorKey]> = {
  customers_phone_format: ["phone", "phone_invalid"],
  customers_alt_phone_format: ["altPhone", "phone_invalid"],
  customers_name_not_blank: ["name", "required"],
  customers_code_valid: ["customerCode", "too_long"],
  customers_area_fk: ["areaId", "area_missing"],
};

function isField(path: string): path is CustomerFieldName {
  return (CUSTOMER_FIELDS as readonly string[]).includes(path);
}

/** One VALIDATION issue (path + Zod/service code) → the field's message. */
function fieldErrorFor(path: CustomerFieldName, code: string): CustomerFieldErrorKey {
  if (path === "phone" || path === "altPhone") return "phone_invalid";
  if (path === "areaId") return code === "archived" ? "area_archived" : "area_missing";
  if (code === "too_small") return "required";
  return "too_long";
}

/** A customer service failure → what the form shows. */
export function customerFormStateFor(
  error: ServiceError<string>,
  values: CustomerFormValues,
): CustomerFormState {
  if (isDuplicateCustomerCode(error)) {
    const takenBy = error.details?.customerId;
    return {
      error: "fix_fields",
      fields: { customerCode: "code_taken" },
      values,
      ...(typeof takenBy === "string" ? { takenBy } : {}),
    };
  }
  switch (error.code as CoreErrorCode) {
    case "VALIDATION": {
      const fields: Partial<Record<CustomerFieldName, CustomerFieldErrorKey>> = {};
      const issues = error.details?.fields;
      if (Array.isArray(issues)) {
        for (const issue of issues as { path?: unknown; code?: unknown }[]) {
          const path = String(issue.path ?? "");
          if (isField(path)) fields[path] ??= fieldErrorFor(path, String(issue.code ?? ""));
        }
      }
      const constraint = error.details?.constraint;
      const mapped = typeof constraint === "string" ? CONSTRAINT_FIELDS[constraint] : undefined;
      if (mapped) fields[mapped[0]] ??= mapped[1];
      if (Object.keys(fields).length === 0) return { error: "unexpected", values };
      return { error: "fix_fields", fields, values };
    }
    case "NOT_FOUND":
      // The only id a form sends besides the customer's own is the area.
      return { error: "fix_fields", fields: { areaId: "area_missing" }, values };
    case "TENANT_READ_ONLY":
      return { error: "read_only", values };
    case "FORBIDDEN":
      return { error: "not_allowed", values };
    case "CONFLICT":
      return { error: "busy", values };
    default:
      return { error: "unexpected", values };
  }
}

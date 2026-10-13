/** Server side of the connection forms: a connection service failure → what the form shows. */
import type { CoreErrorCode, ServiceError } from "@cb/core";
import type {
  ConnectionFieldErrorKey,
  ConnectionFieldName,
  ConnectionFormState,
  ConnectionFormValues,
  StatusChangeError,
} from "./form-state";

/** One VALIDATION issue → the field and its message (paths may be `connections.<i>.<field>`). */
function fieldFor(
  path: string,
  code: string,
): [ConnectionFieldName, ConnectionFieldErrorKey] | null {
  const field = path.replace(/^connections\.\d+\./, "");
  switch (field) {
    case "vcNumber":
      return ["vcNumber", "vc_invalid"];
    case "planId":
      return ["rentChoice", code === "retired" ? "plan_retired" : "choose_rent"];
    case "rentalPaise":
      return ["rentalPaise", "amount_invalid"];
    case "startDate":
      return [
        "startDate",
        code === "in_future"
          ? "start_future"
          : code === "too_old"
            ? "date_too_old"
            : "date_invalid",
      ];
    default:
      return null;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** True when the error is about the connection part of a combined save (add-customer step 2). */
export function isConnectionError(error: ServiceError<string>): boolean {
  if (typeof error.details?.connectionIndex === "number") return true;
  const fields = error.details?.fields;
  return (
    Array.isArray(fields) &&
    fields.some((issue: { path?: unknown }) => String(issue.path ?? "").startsWith("connections."))
  );
}

/** A connection service failure → what the form shows. */
export function connectionFormStateFor(
  error: ServiceError<string>,
  values: ConnectionFormValues,
): ConnectionFormState {
  const details = error.details ?? {};
  switch (error.code as CoreErrorCode) {
    case "VALIDATION": {
      const fields: Partial<Record<ConnectionFieldName, ConnectionFieldErrorKey>> = {};
      const issues = details.fields;
      if (Array.isArray(issues)) {
        for (const issue of issues as { path?: unknown; code?: unknown }[]) {
          const mapped = fieldFor(String(issue.path ?? ""), String(issue.code ?? ""));
          if (mapped) fields[mapped[0]] ??= mapped[1];
        }
      }
      if (Object.keys(fields).length === 0) return { error: "unexpected", values };
      return { error: "fix_fields", fields, values };
    }
    case "CONFLICT": {
      switch (details.reason) {
        case "vc_in_use": {
          if (details.sameCustomer === true) {
            return { error: "fix_fields", fields: { vcNumber: "vc_here" }, values };
          }
          const until = typeof details.until === "string" ? details.until : null;
          return {
            error: "fix_fields",
            fields: { vcNumber: until ? "vc_in_use_until" : "vc_in_use" },
            values,
            holder: {
              customerId: text(details.holderCustomerId),
              name: text(details.holderName),
              code: text(details.holderCustomerCode),
              until,
              earliestStart:
                typeof details.earliestStart === "string" ? details.earliestStart : null,
            },
          };
        }
        case "vc_retired":
          return { error: "fix_fields", fields: { vcNumber: "vc_retired" }, values };
        case "billed_period":
          return {
            error: "fix_fields",
            fields: { startDate: "date_billed" },
            values,
            billed: { period: text(details.period), earliestDate: text(details.earliestDate) },
          };
        case "customer_closed":
          return { error: "customer_closed", values };
        default:
          return { error: "busy", values };
      }
    }
    case "NOT_FOUND":
      // The only id the form sends besides the customer's own is the plan.
      return { error: "fix_fields", fields: { rentChoice: "plan_retired" }, values };
    case "TENANT_READ_ONLY":
      return { error: "read_only", values };
    case "FORBIDDEN":
      return { error: "not_allowed", values };
    default:
      return { error: "unexpected", values };
  }
}

/** A status-change failure → the message key (and the values the server knows). */
export function statusChangeErrorFor(
  error: ServiceError<string>,
  isOwner: boolean,
): StatusChangeError {
  const details = error.details ?? {};
  switch (error.code as CoreErrorCode) {
    case "VALIDATION": {
      const issues = Array.isArray(details.fields)
        ? (details.fields as { path?: unknown; code?: unknown }[])
        : [];
      const first = issues[0];
      const path = String(first?.path ?? "");
      const code = String(first?.code ?? "");
      if (path === "reason") return { error: "reason_required" };
      if (path === "effectiveDate") {
        if (code === "in_future") return { error: "date_future" };
        if (code === "too_old") return { error: "date_too_old" };
        if (code === "before_start") return { error: "date_before_start" };
        if (code === "before_last_change") return { error: "date_before_last_change" };
        return { error: "date_invalid" };
      }
      return { error: "unexpected" };
    }
    case "CONFLICT":
      if (details.reason === "billed_period") {
        return {
          error: isOwner ? "date_billed" : "date_billed_staff",
          period: text(details.period),
          date: text(details.earliestDate),
        };
      }
      if (details.reason === "invalid_transition") return { error: "changed" };
      return { error: "busy" };
    case "NOT_FOUND":
      return { error: "changed" };
    case "TENANT_READ_ONLY":
      return { error: "read_only" };
    case "FORBIDDEN":
      return { error: "not_allowed" };
    default:
      return { error: "unexpected" };
  }
}

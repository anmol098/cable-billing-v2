/**
 * What the customer forms (add, change details) send and get back. Client-safe (no `@cb/core`
 * import): the forms, the Server Actions and the unit tests share it. The mapping from a service
 * error is in ./form-errors.ts (server side).
 */

/** The form fields, named as the services name them. */
export const CUSTOMER_FIELDS = [
  "customerCode",
  "name",
  "phone",
  "altPhone",
  "areaId",
  "address",
] as const;
export type CustomerFieldName = (typeof CUSTOMER_FIELDS)[number];

/** `customers.error.*` keys shown under a field. */
export type CustomerFieldErrorKey =
  | "required"
  | "too_long"
  | "code_taken"
  | "phone_invalid"
  | "area_archived"
  | "area_missing";

/** `customers.error.*` keys shown at the top of a form. */
export type CustomerFormErrorKey =
  | "fix_fields"
  | "read_only"
  | "not_allowed"
  | "busy"
  | "unexpected";

/** What was typed, to put back into the fields after an error. */
export type CustomerFormValues = Record<CustomerFieldName, string>;

export interface CustomerFormState {
  readonly error?: CustomerFormErrorKey;
  readonly fields?: Partial<Record<CustomerFieldName, CustomerFieldErrorKey>>;
  readonly values?: CustomerFormValues;
  /** For `code_taken`: the customer that has the code (same business), to link to it. */
  readonly takenBy?: string;
}

export const EMPTY_VALUES: CustomerFormValues = {
  customerCode: "",
  name: "",
  phone: "",
  altPhone: "",
  areaId: "",
  address: "",
};

/** The typed values from a submitted form (missing fields are ""; lengths are capped). */
export function valuesFrom(formData: FormData): CustomerFormValues {
  const read = (name: CustomerFieldName) => {
    const value = formData.get(name);
    return typeof value === "string" ? value.slice(0, 500) : "";
  };
  return {
    customerCode: read("customerCode"),
    name: read("name"),
    phone: read("phone"),
    altPhone: read("altPhone"),
    areaId: read("areaId"),
    address: read("address"),
  };
}

/** Optional text: "" → null (the services store "no value" as NULL). */
export function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

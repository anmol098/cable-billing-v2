/**
 * What the connection forms send and get back (T-034). Client-safe (no `@cb/core` import): the
 * add-connection form, the add-customer step 2, the Server Actions and the unit tests share it.
 * The mapping from a service error is in ./form-errors.ts (server side).
 */

/** The form fields. `rentChoice` is a plan id or {@link OWN_AMOUNT}; `rentalPaise` is paise. */
export const CONNECTION_FIELDS = ["vcNumber", "rentChoice", "rentalPaise", "startDate"] as const;
export type ConnectionFieldName = (typeof CONNECTION_FIELDS)[number];

/** The `rentChoice` value for "Own amount". */
export const OWN_AMOUNT = "own";

/** `connections.error.*` keys shown under a field. */
export type ConnectionFieldErrorKey =
  | "vc_required"
  | "vc_invalid"
  | "vc_in_use"
  | "vc_in_use_until"
  | "vc_here"
  | "vc_retired"
  | "choose_rent"
  | "plan_retired"
  | "amount_invalid"
  | "date_invalid"
  | "start_future"
  | "date_too_old"
  | "date_billed";

/** `connections.error.*` keys shown at the top of a form. */
export type ConnectionFormErrorKey =
  | "fix_fields"
  | "read_only"
  | "not_allowed"
  | "busy"
  | "customer_closed"
  | "unexpected";

export type ConnectionFormValues = Record<ConnectionFieldName, string>;

/** Who has the VC (same business), for `vc_in_use` / `vc_in_use_until`. */
export interface VcHolder {
  readonly customerId: string;
  readonly name: string;
  readonly code: string;
  /** Last day with that customer (`YYYY-MM-DD`), or null while open. */
  readonly until: string | null;
  /** First day it can start here, or null. */
  readonly earliestStart: string | null;
}

export interface ConnectionFormState {
  readonly error?: ConnectionFormErrorKey;
  readonly fields?: Partial<Record<ConnectionFieldName, ConnectionFieldErrorKey>>;
  readonly values?: ConnectionFormValues;
  readonly holder?: VcHolder;
  /** For `date_billed`: the latest billed month and the earliest allowed day. */
  readonly billed?: { readonly period: string; readonly earliestDate: string };
}

export const EMPTY_CONNECTION_VALUES: ConnectionFormValues = {
  vcNumber: "",
  rentChoice: "",
  rentalPaise: "",
  startDate: "",
};

/** The typed values from a submitted form (missing fields are ""; lengths are capped). */
export function connectionValuesFrom(formData: FormData): ConnectionFormValues {
  const read = (name: ConnectionFieldName) => {
    const value = formData.get(name);
    return typeof value === "string" ? value.slice(0, 200) : "";
  };
  return {
    vcNumber: read("vcNumber"),
    rentChoice: read("rentChoice"),
    rentalPaise: read("rentalPaise"),
    startDate: read("startDate"),
  };
}

/** True when nothing was typed into the VC box (add-customer step 2: "no connection now"). */
export function isEmptyConnection(values: ConnectionFormValues): boolean {
  return values.vcNumber.trim() === "";
}

/**
 * The service input for the typed values, or the fields that are missing / wrong before even
 * asking the server.
 */
export function connectionInputFrom(values: ConnectionFormValues):
  | {
      readonly ok: true;
      readonly input: {
        vcNumber: string;
        planId?: string;
        rentalPaise?: number;
        startDate: string;
      };
    }
  | {
      readonly ok: false;
      readonly fields: Partial<Record<ConnectionFieldName, ConnectionFieldErrorKey>>;
    } {
  const fields: Partial<Record<ConnectionFieldName, ConnectionFieldErrorKey>> = {};
  if (values.vcNumber.trim() === "") fields.vcNumber = "vc_required";
  let rent: { planId: string } | { rentalPaise: number } | null = null;
  if (values.rentChoice === "") {
    fields.rentChoice = "choose_rent";
  } else if (values.rentChoice === OWN_AMOUNT) {
    const paise = /^[0-9]{1,12}$/.test(values.rentalPaise)
      ? Number(values.rentalPaise)
      : Number.NaN;
    if (!Number.isSafeInteger(paise) || paise % 100 !== 0) fields.rentalPaise = "amount_invalid";
    else rent = { rentalPaise: paise };
  } else {
    rent = { planId: values.rentChoice };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.startDate)) fields.startDate = "date_invalid";
  if (Object.keys(fields).length > 0 || rent === null) return { ok: false, fields };
  return {
    ok: true,
    input: { vcNumber: values.vcNumber, ...rent, startDate: values.startDate },
  };
}

/** Why a stop / start again / remove was refused (`connections.error.*`). */
export type StatusChangeErrorKey =
  | "read_only"
  | "not_allowed"
  | "busy"
  | "changed"
  | "unexpected"
  | "reason_required"
  | "date_invalid"
  | "date_future"
  | "date_too_old"
  | "date_before_start"
  | "date_before_last_change"
  | "date_billed"
  | "date_billed_staff";

export interface StatusChangeError {
  readonly error: StatusChangeErrorKey;
  /** `date_billed*`: the latest billed month (`YYYY-MM-01`). */
  readonly period?: string;
  /** `date_billed*`: the earliest allowed day. */
  readonly date?: string;
}

export type StatusChangeResult =
  | { readonly ok: true }
  | ({ readonly ok: false } & StatusChangeError);

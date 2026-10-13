/**
 * The error envelope and the stable machine error codes of the mobile API (PLAN §10.2: "Errors use
 * stable machine codes … which the app maps to Hindi/English messages and icons").
 *
 * - A code is a stable `UPPER_SNAKE` string. It never changes meaning and is never removed in v1.
 * - New codes may be added within v1 (the one open enum in this contract): the app maps an unknown
 *   code by its HTTP status (4xx → "call office", 401 → sign in again, 5xx/429 → try later).
 * - `message` is developer-facing English for logs. It is never shown to users and never contains
 *   personal data; the app shows the i18n text for the code.
 */

import { BASE_ERROR_CODES, type BaseErrorCode } from "@cb/domain";
import * as z from "zod";
import { Timestamp } from "./primitives";

/** Codes the mobile API adds on top of `@cb/domain`'s {@link BASE_ERROR_CODES}. */
export const MOBILE_ERROR_CODES = [
  "APP_TOO_OLD",
  "INVALID_CREDENTIALS",
  "ACCOUNT_DISABLED",
  "ROLE_NOT_ALLOWED",
  "REFRESH_TOKEN_INVALID",
  "DEVICE_REVOKED",
  "RATE_LIMITED",
  "CURSOR_INVALID",
  "CUSTOMER_NOT_FOUND",
  "PAYMENT_NOT_FOUND",
  "HANDOVER_ALREADY_ACCEPTED",
  "INTERNAL",
] as const;

export type MobileErrorCode = (typeof MOBILE_ERROR_CODES)[number];

/** Every error code the mobile API can return: the base codes first, then the mobile ones. */
export const ERROR_CODES = [...BASE_ERROR_CODES, ...MOBILE_ERROR_CODES] as const;

export type ErrorCode = BaseErrorCode | MobileErrorCode;

/**
 * What each code means and the HTTP status it is sent with. Batch endpoints also use some codes per
 * item (inside a 200 response); the status then applies only when the whole request fails.
 */
export const ERROR_CODE_INFO: Readonly<Record<ErrorCode, { status: number; meaning: string }>> = {
  VALIDATION: {
    status: 400,
    meaning: "The request is malformed or a value is out of range. `fields` says which.",
  },
  NOT_FOUND: { status: 404, meaning: "No such route or entity in this tenant." },
  FORBIDDEN: { status: 403, meaning: "This user's role may not do this (PLAN §9.3)." },
  UNAUTHENTICATED: {
    status: 401,
    meaning:
      "The access token is missing, expired or invalid. Call /auth/refresh once, then retry the request.",
  },
  CONFLICT: { status: 409, meaning: "The data changed underneath the request." },
  TENANT_READ_ONLY: {
    status: 403,
    meaning:
      "The operator's subscription is read-only (D-13). Collections still work (payments, handovers, receipt links and receipt actions); in the mobile API only the phone-number update can get this.",
  },
  ID_REUSED_WITH_DIFFERENT_DATA: {
    status: 409,
    meaning:
      "An idempotency key (payment id, action id, submission id) was already used with a different payload (PLAN §8.4). Never retry it; call the office.",
  },
  INVARIANT_VIOLATION: {
    status: 500,
    meaning: "A financial invariant would break. Always a server bug; nothing was saved.",
  },
  APP_TOO_OLD: {
    status: 426,
    meaning:
      "The app is older than min_app_version_code. Show the full-screen 'Update app' screen; queued payments stay on the phone.",
  },
  INVALID_CREDENTIALS: { status: 401, meaning: "Wrong login or password." },
  ACCOUNT_DISABLED: {
    status: 403,
    meaning: "The user (or the operator) is deactivated. Call the office.",
  },
  ROLE_NOT_ALLOWED: {
    status: 403,
    meaning: "Only linemen sign in on the Android app; owners and staff use the web.",
  },
  REFRESH_TOKEN_INVALID: {
    status: 401,
    meaning:
      "The refresh token is unknown, expired or was already used. Sign in again (queued payments are kept).",
  },
  DEVICE_REVOKED: {
    status: 401,
    meaning:
      "The owner signed this phone out. Sign in again (queued payments are kept and flagged if another user signs in).",
  },
  RATE_LIMITED: {
    status: 429,
    meaning: "Too many requests. Wait `retry_after_seconds` (also sent as Retry-After).",
  },
  CURSOR_INVALID: {
    status: 400,
    meaning: "The sync cursor is unknown or too old. Drop it and start a full sync (no cursor).",
  },
  CUSTOMER_NOT_FOUND: {
    status: 404,
    meaning: "No such customer in this operator (cross-tenant ids also get this).",
  },
  PAYMENT_NOT_FOUND: {
    status: 404,
    meaning:
      "The server has no such payment in this operator, usually because it has not synced yet. Keep the request and retry after the payment syncs.",
  },
  HANDOVER_ALREADY_ACCEPTED: {
    status: 409,
    meaning: "The office already accepted this day's handover; it can no longer change.",
  },
  INTERNAL: {
    status: 500,
    meaning: "Unexpected server error. Nothing was saved by the failed part; retry later.",
  },
};

export const ErrorCodeSchema = z.enum(ERROR_CODES).meta({
  id: "ErrorCode",
  description: [
    "Stable machine error code. The app maps it to Hindi/English text and an icon; it never shows `message`.",
    "New codes may be added within v1: map an unknown code by the HTTP status.",
    "",
    ...ERROR_CODES.map((code) => {
      const info = ERROR_CODE_INFO[code];
      return `- ${code} (${info.status}): ${info.meaning}`;
    }),
  ].join("\n"),
});

export const FieldIssue = z
  .object({
    path: z
      .string()
      .describe(
        "Where the problem is, as a dot path into the request body or parameters, e.g. 'payments.3.amount_paise' or 'query.limit'.",
      ),
    issue: z
      .string()
      .describe(
        "Machine reason, e.g. 'too_small', 'invalid_format', 'required'. For logs and tests, not shown to users.",
      ),
  })
  .meta({ id: "FieldIssue", description: "One invalid field in a VALIDATION error." });

const errorMessage = z
  .string()
  .max(1000)
  .describe("Developer-facing English detail for logs. Never shown to users; never contains PII.");

const fields = z
  .array(FieldIssue)
  .optional()
  .describe("Only for VALIDATION: the invalid fields. Absent for other codes.");

/** The `error` object of a failed request. */
export const ApiError = z
  .object({
    code: ErrorCodeSchema.describe("Stable machine code; see ErrorCode."),
    message: errorMessage,
    request_id: z
      .string()
      .min(1)
      .max(128)
      .describe("Server request id. Shown in diagnostics so support can find the server logs."),
    fields,
    min_app_version_code: z
      .int()
      .min(1)
      .optional()
      .describe(
        "Only for APP_TOO_OLD: the lowest Android versionCode the server accepts. Absent otherwise.",
      ),
    retry_after_seconds: z
      .int()
      .min(1)
      .optional()
      .describe("Only for RATE_LIMITED: seconds to wait before retrying. Absent otherwise."),
  })
  .meta({ id: "ApiError", description: "Why the request failed." });

export type ApiError = z.infer<typeof ApiError>;

/** The body of every non-2xx response. */
export const ErrorResponse = z
  .object({
    server_time: Timestamp.describe("Server clock when the response was made (UTC)."),
    error: ApiError.describe("The error: stable code plus details for logs."),
  })
  .meta({
    id: "ErrorResponse",
    description:
      "Body of every error response (4xx/5xx). The HTTP status follows the code (see ErrorCode).",
  });

export type ErrorResponse = z.infer<typeof ErrorResponse>;

/**
 * The per-item error inside a batch result (the request as a whole succeeded with 200). Same codes
 * as {@link ApiError}; no request id because the batch response is one request.
 */
export const ItemError = z
  .object({
    code: ErrorCodeSchema.describe("Stable machine code; see ErrorCode."),
    message: errorMessage,
    fields,
  })
  .meta({ id: "ItemError", description: "Why one item of a batch was rejected." });

export type ItemError = z.infer<typeof ItemError>;

/** The HTTP status for an error code. */
export function httpStatusForError(code: ErrorCode): number {
  return ERROR_CODE_INFO[code].status;
}

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

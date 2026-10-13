/**
 * Service error codes and the mapping from thrown errors to them (PLAN §9.1, §10.2).
 *
 * - Every code is one of `@cb/contracts` `ERROR_CODES` (a test checks it), so the mobile routes
 *   and server actions can turn a service error into an HTTP status with `httpStatusForError`.
 * - `message` is developer-facing English for logs. It never carries values from the request or
 *   the database (no PII); the UI shows the i18n text for the code.
 * - **Cross-tenant ids are NOT_FOUND**, never FORBIDDEN: a row of another tenant is invisible
 *   (RLS), so "not in this tenant" and "does not exist" must look the same. Database errors that
 *   could only come from referencing another tenant's row (RLS WITH CHECK `42501`, a composite
 *   foreign key `23503 … is not present`) map to NOT_FOUND with no details.
 */
import { sqlStateOf } from "@cb/db";
import { BASE_ERROR_CODES, type DomainError } from "@cb/domain";
import type { z } from "zod";

/**
 * Codes a core service can return: the base codes plus
 * - `ACCOUNT_DISABLED`: the user or the whole operator is deactivated (context building only);
 * - `INTERNAL`: a bug or an unexpected database error. Nothing was saved (the transaction rolled
 *   back) and the error was logged.
 */
export const CORE_ERROR_CODES = [...BASE_ERROR_CODES, "ACCOUNT_DISABLED", "INTERNAL"] as const;
export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

/** A service's error: a `DomainError` whose code is a core code or one the service adds. */
export type ServiceError<C extends string = CoreErrorCode> = DomainError<C>;

export function isCoreErrorCode(code: string): code is CoreErrorCode {
  return (CORE_ERROR_CODES as readonly string[]).includes(code);
}

/** Builds a service error. `message` is for logs only: never put request values or PII in it. */
export function serviceError<C extends string>(
  code: C,
  message?: string,
  details?: Readonly<Record<string, unknown>>,
): ServiceError<C> {
  return {
    code,
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  };
}

/** The NOT_FOUND every lookup returns, for a missing id and another tenant's id alike. */
export function notFound(): ServiceError<"NOT_FOUND"> {
  return { code: "NOT_FOUND" };
}

/** One invalid input field: its path and Zod's issue code. Never the value. */
export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

/** VALIDATION error from a Zod error: field paths and issue codes, never the submitted values. */
export function validationError(error: z.ZodError): ServiceError<"VALIDATION"> {
  const fields: FieldIssue[] = error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    code: issue.code,
  }));
  return { code: "VALIDATION", message: "Input failed validation", details: { fields } };
}

// SQLSTATEs (https://www.postgresql.org/docs/current/errcodes-appendix.html).
const SQLSTATE = {
  insufficientPrivilege: "42501", // RLS WITH CHECK failed: writing a row of another tenant
  foreignKeyViolation: "23503",
  uniqueViolation: "23505",
  checkViolation: "23514",
  notNullViolation: "23502",
  exclusionViolation: "23P01",
  invalidTextRepresentation: "22P02",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
  readOnlyTransaction: "25006",
  immutableRow: "CB001",
} as const;

function dbErrorField(error: unknown, field: "constraint" | "detail"): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Maps an error thrown inside a service (or by the database) to a service error. Unknown errors
 * become INTERNAL. The result never contains values from the failing row.
 */
export function toServiceError(error: unknown): ServiceError {
  const state = sqlStateOf(error);
  const constraint = dbErrorField(error, "constraint");
  const withConstraint = constraint === undefined ? undefined : { constraint };
  switch (state) {
    case SQLSTATE.insufficientPrivilege:
      // RLS rejected a row: it belongs (or would belong) to another tenant. Never say so.
      return notFound();
    case SQLSTATE.foreignKeyViolation: {
      // Postgres' detail is "Key (…)=(…) is not present in table …" when a referenced row is
      // missing (or is another tenant's: composite FKs) and "… is still referenced from table …"
      // when deleting/re-keying a row others point at.
      const detail = dbErrorField(error, "detail") ?? "";
      if (detail.includes("is still referenced")) {
        return serviceError("CONFLICT", "Row is still referenced", withConstraint);
      }
      return notFound();
    }
    case SQLSTATE.uniqueViolation:
    case SQLSTATE.exclusionViolation:
      return serviceError("CONFLICT", "Unique or exclusion constraint violated", withConstraint);
    case SQLSTATE.immutableRow:
      return serviceError("CONFLICT", "Append-only row cannot be changed", withConstraint);
    case SQLSTATE.serializationFailure:
    case SQLSTATE.deadlockDetected:
      return serviceError("CONFLICT", "Concurrent update; retry", { retryable: true });
    case SQLSTATE.checkViolation:
    case SQLSTATE.notNullViolation:
    case SQLSTATE.invalidTextRepresentation:
      return serviceError("VALIDATION", "Database constraint rejected the input", withConstraint);
    case SQLSTATE.readOnlyTransaction:
      return serviceError("INTERNAL", "A read capability tried to write");
    default:
      return serviceError("INTERNAL", "Unexpected error");
  }
}

/** True for codes the caller can fix or expect (logged at info/warn, not error). */
export function isExpectedError(code: string): boolean {
  return code !== "INTERNAL" && code !== "INVARIANT_VIOLATION";
}

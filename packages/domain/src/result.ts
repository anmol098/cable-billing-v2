/**
 * `Result<T, E>`: how pure domain functions report expected failures without throwing.
 *
 * - Expected, user-facing failures (bad input, nothing to bill, amount too large) are returned as
 *   `err(...)`. Callers must handle them; TypeScript narrows on `result.ok`.
 * - Programmer errors (a broken invariant, a non-integer paise value reaching arithmetic) still
 *   throw, because no caller can recover from them.
 *
 * Error codes are stable machine strings (PLAN §10.2: "Errors use stable machine codes … which the
 * app maps to Hindi/English messages and icons"). Never put user-facing text in an error: the UI
 * maps the code to an i18n key.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

export function andThen<T, U, E, F>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** The value, or throws {@link ResultError}. For tests and for results that cannot fail. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new ResultError(result.error);
}

export class ResultError<E = unknown> extends Error {
  readonly error: E;

  constructor(error: E) {
    super(`unwrap() on an error result: ${describe(error)}`);
    this.name = "ResultError";
    this.error = error;
  }
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object" && "code" in error) return String(error.code);
  return String(error);
}

/**
 * Base error codes shared by every layer. Packages extend the union with their own codes
 * (`DomainError<BaseErrorCode | "NOTHING_TO_BILL">`), and the mobile contract (T-051) and the
 * service wrapper (T-025) map them to HTTP statuses.
 *
 * - `VALIDATION`: the input is malformed or out of range (bad amount, bad date).
 * - `NOT_FOUND`: no such entity **in this tenant**. Cross-tenant ids also return this (CLAUDE.md).
 * - `FORBIDDEN`: the role may not do this (PLAN §9.3).
 * - `UNAUTHENTICATED`: no valid session or token.
 * - `CONFLICT`: the state changed underneath (already billed, already reversed, duplicate code).
 * - `TENANT_READ_ONLY`: the subscription is read-only (D-13).
 * - `ID_REUSED_WITH_DIFFERENT_DATA`: an idempotency key replayed with a different payload (PLAN §8.4).
 * - `INVARIANT_VIOLATION`: a financial invariant would break; always a bug, always alerted.
 */
export const BASE_ERROR_CODES = [
  "VALIDATION",
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHENTICATED",
  "CONFLICT",
  "TENANT_READ_ONLY",
  "ID_REUSED_WITH_DIFFERENT_DATA",
  "INVARIANT_VIOLATION",
] as const;

export type BaseErrorCode = (typeof BASE_ERROR_CODES)[number];

export type DomainError<C extends string = BaseErrorCode> = {
  readonly code: C;
  /** Developer-facing detail for logs. Never shown to users and never contains PII. */
  readonly message?: string;
  /** Machine-readable context, e.g. `{ field: "amount", reason: "decimal" }`. */
  readonly details?: Readonly<Record<string, unknown>>;
};

export function domainError<C extends string>(
  code: C,
  message?: string,
  details?: Readonly<Record<string, unknown>>,
): DomainError<C> {
  return {
    code,
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  };
}

export function isBaseErrorCode(code: string): code is BaseErrorCode {
  return (BASE_ERROR_CODES as readonly string[]).includes(code);
}

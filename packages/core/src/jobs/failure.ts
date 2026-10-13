/**
 * A job that has finally failed (T-043), and the safe error text stored in `jobs.last_error`.
 */
import { errorLogFields } from "../logging/logger";
import { PermanentJobError } from "./definition";

/** Why a job ended up `failed`. */
export const JOB_FAILURE_REASONS = [
  /** The handler threw on its last allowed attempt. */
  "max_attempts",
  /** The handler threw `PermanentJobError` (or the payload/scope was invalid). */
  "permanent",
  /** The last allowed attempt ran out of time (its lease expired without an outcome). */
  "lease_expired",
] as const;
export type JobFailureReason = (typeof JOB_FAILURE_REASONS)[number];

export interface JobFailure {
  readonly jobId: string;
  readonly type: string;
  /** The tenant the job worked for; null for a platform job. */
  readonly operatorId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly reason: JobFailureReason;
  /** Safe summary (no personal data): see {@link jobErrorSummary}. */
  readonly lastError: string;
  readonly failedAt: Date;
  /** Whether the tenant owner is emailed too (the definition's `notifyOwner`). */
  readonly notifyOwner: boolean;
}

/** Called once per failed job (alert emails, Sentry). Must not throw; the worker logs if it does. */
export type JobFailureHook = (failure: JobFailure) => Promise<unknown> | unknown;

const MAX_ERROR_LENGTH = 500;

/**
 * The text stored in `jobs.last_error` and sent in alerts: the error type, SQLSTATE and constraint
 * for database errors (their messages can quote row values, so they are dropped), otherwise a
 * PII-scrubbed message (see `errorLogFields`).
 */
export function jobErrorSummary(error: unknown): string {
  if (error instanceof PermanentJobError) return `permanent: ${error.code}`;
  const fields = errorLogFields(error);
  const parts = [fields.error_type ?? "Error"];
  if (fields.sqlstate) parts.push(`sqlstate=${fields.sqlstate}`);
  if (fields.constraint_name) parts.push(`constraint=${fields.constraint_name}`);
  let text = parts.join(" ");
  if (fields.error_message) text += `: ${fields.error_message}`;
  return text.slice(0, MAX_ERROR_LENGTH);
}

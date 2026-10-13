/**
 * Failure alerts for jobs (T-043, PLAN §14: "marks the job failed and emails the platform admin and
 * tenant owner"; Q-11 default).
 *
 * ```ts
 * const onFailure = createJobFailureNotifier({
 *   db,
 *   transport: createResendEmailTransport({ apiKey, from }),  // or a test double
 *   render: ({ audience, language, failure }) => ({ subject, text }), // i18n lives in the app
 *   logger,
 *   capture: (event) => Sentry.captureMessage(event.message, { level: "error", tags: event.tags }),
 * });
 * await runJobWorker({ db, registry, onFailure });
 * ```
 *
 * Recipients (read in `withPlatform`): every **active platform admin** with an email, plus, for a
 * tenant job whose definition has `notifyOwner` (the default), the tenant's **active owners** with an
 * email. Each email goes in the recipient's language (`users.language`); the words come from the
 * app's i18n messages through `render`, so core holds no user-facing text.
 *
 * Logs and the Sentry event carry ids, the job type and the safe error summary only (never an
 * email address or a name). A send failure is logged and captured; it never fails the worker.
 */
import { type DbClient, type Language, users } from "@cb/db";
import { and, eq, isNotNull, or, type SQL } from "drizzle-orm";
import { errorLogFields, type Logger } from "../logging/logger";
import type { JobFailure } from "./failure";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Lets the provider drop a duplicate send (retried webhook, re-run). */
  readonly idempotencyKey?: string;
}

/** Where email goes. Production: Resend; tests: {@link createRecordingEmailTransport}. */
export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";

export interface ResendTransportOptions {
  readonly apiKey: string;
  /** `Name <address>` on a verified domain (env `EMAIL_FROM`). */
  readonly from: string;
  /** Injected for tests. Default: global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

/** Thrown when the provider refuses a message. The message holds the HTTP status only. */
export class EmailSendError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Email provider answered HTTP ${status}`);
    this.name = "EmailSendError";
    this.status = status;
  }
}

/** Resend's REST API (`POST /emails`), no SDK needed. */
export function createResendEmailTransport(options: ResendTransportOptions): EmailTransport {
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? RESEND_EMAILS_ENDPOINT;
  return {
    name: "resend",
    async send(message) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      };
      if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey;
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      // The body may echo the address; never surface it.
      if (!response.ok) throw new EmailSendError(response.status);
    },
  };
}

/** Test double: keeps every message in `sent`. `failFor` makes sends to those addresses throw. */
export function createRecordingEmailTransport(
  options: { failFor?: readonly string[] } = {},
): EmailTransport & { readonly sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: "recording",
    sent,
    async send(message) {
      if (options.failFor?.includes(message.to)) throw new EmailSendError(500);
      sent.push(message);
    },
  };
}

/** For environments without an email provider (local, previews): logs that nothing was sent. */
export function createLogOnlyEmailTransport(logger: Logger): EmailTransport {
  return {
    name: "log_only",
    async send() {
      logger.warn("email.not_sent_no_provider", {});
    },
  };
}

export type JobAlertAudience = "platform_admin" | "owner";

export interface JobAlertRecipient {
  readonly userId: string;
  readonly email: string;
  readonly language: Language;
  readonly audience: JobAlertAudience;
}

export interface RenderJobAlertArgs {
  readonly audience: JobAlertAudience;
  readonly language: Language;
  readonly failure: JobFailure;
}

export type RenderJobAlert = (
  args: RenderJobAlertArgs,
) => { subject: string; text: string } | Promise<{ subject: string; text: string }>;

/** What `capture` receives (for Sentry): no personal data. */
export interface JobFailureEvent {
  /** `job.failed` once per failure; `job.alert_send_failed` per email that could not be sent. */
  readonly message: "job.failed" | "job.alert_send_failed";
  readonly tags: Readonly<Record<string, string>>;
  readonly extra: Readonly<Record<string, string | number | null>>;
}

export interface JobFailureNotifierOptions {
  readonly db: Pick<DbClient, "withPlatform">;
  readonly transport: EmailTransport;
  readonly render: RenderJobAlert;
  readonly logger: Logger;
  /** Error tracking (Sentry): once per failure (before the emails), and per failed send. */
  readonly capture?: (event: JobFailureEvent) => void;
}

export interface JobAlertReport {
  readonly sent: number;
  readonly failed: number;
  readonly recipients: number;
}

/** The people to alert about `failure` (active, with an email). Admins first. */
export async function findJobAlertRecipients(
  db: Pick<DbClient, "withPlatform">,
  failure: Pick<JobFailure, "operatorId" | "notifyOwner">,
): Promise<JobAlertRecipient[]> {
  const audiences: SQL[] = [eq(users.role, "platform_admin")];
  if (failure.operatorId !== null && failure.notifyOwner) {
    const owners = and(eq(users.role, "owner"), eq(users.operatorId, failure.operatorId));
    if (owners) audiences.push(owners);
  }
  const rows = await db.withPlatform(
    (tx) =>
      tx
        .select({
          userId: users.id,
          email: users.email,
          language: users.language,
          role: users.role,
        })
        .from(users)
        .where(and(eq(users.status, "active"), isNotNull(users.email), or(...audiences)))
        .orderBy(users.role, users.id),
    { accessMode: "read only" },
  );
  const recipients: JobAlertRecipient[] = [];
  for (const row of rows) {
    if (!row.email) continue;
    recipients.push({
      userId: row.userId,
      email: row.email,
      language: row.language,
      audience: row.role === "platform_admin" ? "platform_admin" : "owner",
    });
  }
  return recipients.sort((a, b) =>
    a.audience === b.audience ? 0 : a.audience === "platform_admin" ? -1 : 1,
  );
}

/** Builds the worker's `onFailure` hook: log + capture + one email per recipient. */
export function createJobFailureNotifier(
  options: JobFailureNotifierOptions,
): (failure: JobFailure) => Promise<JobAlertReport> {
  return async (failure) => {
    const log = options.logger.child({
      job_id: failure.jobId,
      job_type: failure.type,
      operator_id: failure.operatorId,
    });
    log.error("job.failure_alert", {
      attempts: failure.attempts,
      reason: failure.reason,
      last_error: failure.lastError,
    });
    options.capture?.({
      message: "job.failed",
      tags: { job_type: failure.type, reason: failure.reason },
      extra: {
        job_id: failure.jobId,
        operator_id: failure.operatorId,
        attempts: failure.attempts,
        last_error: failure.lastError,
      },
    });

    const recipients = await findJobAlertRecipients(options.db, failure);
    if (recipients.length === 0) log.warn("job.alert_no_recipients", {});
    let sent = 0;
    let failed = 0;
    for (const recipient of recipients) {
      try {
        const { subject, text } = await options.render({
          audience: recipient.audience,
          language: recipient.language,
          failure,
        });
        await options.transport.send({
          to: recipient.email,
          subject,
          text,
          idempotencyKey: `job-failed/${failure.jobId}/${recipient.userId}`,
        });
        sent += 1;
        log.info("job.alert_sent", {
          user_id: recipient.userId,
          audience: recipient.audience,
          transport: options.transport.name,
        });
      } catch (error) {
        failed += 1;
        log.error("job.alert_send_failed", {
          user_id: recipient.userId,
          audience: recipient.audience,
          transport: options.transport.name,
          ...errorLogFields(error),
        });
        options.capture?.({
          message: "job.alert_send_failed",
          tags: { job_type: failure.type, audience: recipient.audience },
          extra: {
            job_id: failure.jobId,
            user_id: recipient.userId,
            error_type: errorLogFields(error).error_type ?? "unknown",
          },
        });
      }
    }
    return { sent, failed, recipients: recipients.length };
  };
}

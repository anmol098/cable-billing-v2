/**
 * Subscription emails to the tenant's Owner(s) (PLAN §14: reminders at T-7, T-1 and grace start;
 * plus "working again" after a payment ends read-only mode, with the missed bill runs, D-25).
 *
 * - Recipients: the tenant's **active owners with an email**, each in their `users.language`.
 * - Words come from the app (`render`, i18n namespace `subscription`), so core holds no text.
 * - **Once per notice**: a sent notice is recorded as an audit event
 *   (`subscription.notice_sent`, `after.key`) in the tenant's log; the cron checks it before
 *   sending. A crash between sending and recording is covered by the provider's
 *   `Idempotency-Key` (`subscription-notice/<tenant>/<key>/<user>`).
 * - Honest: the emails say what we know (the trial ends on a date, no payment has reached us);
 *   they never claim a payment failed or that a message was delivered.
 */
import { auditEvents, type DbClient, type Language, type Tx, users } from "@cb/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { writeAuditEvent } from "../audit/audit";
import type { EmailTransport } from "../jobs/alerts";
import { errorLogFields, type Logger } from "../logging/logger";
import { CURRENT_PLAN, type SubscriptionPlan } from "./plan";
import type { SubscriptionNotice } from "./state";

export interface RenderSubscriptionNoticeArgs {
  readonly language: Language;
  readonly notice: SubscriptionNotice;
  readonly plan: SubscriptionPlan;
  /** Skipped billing months (`YYYY-MM-01`), for `reactivated`. */
  readonly missedRunPeriods: readonly string[];
}

export type RenderSubscriptionNotice = (
  args: RenderSubscriptionNoticeArgs,
) => { subject: string; text: string } | Promise<{ subject: string; text: string }>;

export interface SubscriptionNotifier {
  readonly transport: EmailTransport;
  readonly render: RenderSubscriptionNotice;
}

export interface NoticeRecipient {
  readonly userId: string;
  readonly email: string;
  readonly language: Language;
}

/** The tenant's active owners with an email address. */
export async function noticeRecipients(tx: Tx, operatorId: string): Promise<NoticeRecipient[]> {
  const rows = await tx
    .select({ userId: users.id, email: users.email, language: users.language })
    .from(users)
    .where(
      and(
        eq(users.operatorId, operatorId),
        eq(users.role, "owner"),
        eq(users.status, "active"),
        isNotNull(users.email),
      ),
    )
    .orderBy(users.id);
  return rows.flatMap((row) =>
    row.email ? [{ userId: row.userId, email: row.email, language: row.language }] : [],
  );
}

/** Was this notice already sent to the tenant? (audit event `subscription.notice_sent`). */
export async function noticeAlreadySent(tx: Tx, operatorId: string, key: string): Promise<boolean> {
  const rows = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.operatorId, operatorId),
        eq(auditEvents.entityType, "subscription"),
        eq(auditEvents.entityId, operatorId),
        eq(auditEvents.action, "subscription.notice_sent"),
        sql`${auditEvents.after} ->> 'key' = ${key}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface SendNoticeResult {
  readonly recipients: number;
  readonly sent: number;
  readonly failed: number;
}

/**
 * Sends `notice` to the tenant's owners and records it when at least one email went out (so a
 * failed send is tried again on the next run). Never throws for a failed send; logs it.
 */
export async function sendSubscriptionNotice(args: {
  readonly db: Pick<DbClient, "withTenant">;
  readonly operatorId: string;
  readonly notice: SubscriptionNotice;
  readonly missedRunPeriods?: readonly string[];
  readonly notifier: SubscriptionNotifier;
  readonly log: Logger;
  readonly requestId?: string | null;
  readonly plan?: SubscriptionPlan;
}): Promise<SendNoticeResult> {
  const { db, operatorId, notice, notifier } = args;
  const log = args.log.child({ operator_id: operatorId, notice_kind: notice.kind });
  const recipients = await db.withTenant(operatorId, (tx) => noticeRecipients(tx, operatorId), {
    accessMode: "read only",
  });
  if (recipients.length === 0) {
    log.warn("subscription.notice_no_recipients", {});
    return { recipients: 0, sent: 0, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      const { subject, text } = await notifier.render({
        language: recipient.language,
        notice,
        plan: args.plan ?? CURRENT_PLAN,
        missedRunPeriods: args.missedRunPeriods ?? [],
      });
      await notifier.transport.send({
        to: recipient.email,
        subject,
        text,
        idempotencyKey: `subscription-notice/${operatorId}/${notice.key}/${recipient.userId}`,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      log.error("subscription.notice_send_failed", {
        user_id: recipient.userId,
        ...errorLogFields(error),
      });
    }
  }
  if (sent > 0) {
    await db.withTenant(operatorId, (tx) =>
      writeAuditEvent(tx, {
        operatorId,
        actorId: null,
        actorRole: null,
        action: "subscription.notice_sent",
        entityType: "subscription",
        entityId: operatorId,
        after: {
          key: notice.key,
          kind: notice.kind,
          days_left: notice.daysLeft,
          recipients: sent,
        },
        requestId: args.requestId ?? null,
      }),
    );
  }
  log.info("subscription.notice_sent", { sent, failed });
  return { recipients: recipients.length, sent, failed };
}

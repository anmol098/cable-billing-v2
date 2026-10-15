/**
 * `/admin`: PRD §16 metrics across all operators (T-086). Totals, counts and rates only; no
 * operator's customers, payments or amounts. The read is recorded in the admin log.
 */
import { platformMetrics } from "@cb/core";
import { SUBSCRIPTION_STATUSES } from "@cb/db";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { getServerRuntime } from "@/lib/auth/server";
import { AdminPageHeader, Section, Stat, StatGrid, SubscriptionPill } from "./_components/parts";
import { getAdminContext } from "./_lib/context";
import { displayLocale, monthText, percentText } from "./_lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("overview.title"), robots: { index: false } };
}

export default async function AdminOverviewPage() {
  const ctx = await getAdminContext();
  const [result, t, locale] = await Promise.all([
    platformMetrics.call(getServerRuntime(), ctx, {}),
    getTranslations("admin"),
    getLocale(),
  ]);
  if (!result.ok) throw new Error(`admin metrics: ${result.error.code}`);
  const m = result.value;
  const dl = displayLocale(locale);
  const notMeasured = t("common.not_measured");
  const none = t("common.none");
  const reasons = Object.entries(m.billing.failedByReason).sort((a, b) => b[1] - a[1]);
  const syncRetryLater = Object.values(m.paymentSync.retryLaterByCode).reduce((a, b) => a + b, 0);

  return (
    <>
      <AdminPageHeader title={t("overview.title")} description={t("overview.description")} />

      <Section title={t("overview.tenants.title")} data-metrics="tenants">
        <StatGrid>
          <Stat value={m.tenants.total} label={t("overview.tenants.total")} />
          <Stat value={m.tenants.activeLast7Days} label={t("overview.tenants.active")} />
          <Stat value={m.people.activeWebUsersLast7Days} label={t("overview.people.web")} />
          <Stat value={m.people.activeLinemenLast7Days} label={t("overview.people.linemen")} />
        </StatGrid>
        <ul className="flex flex-wrap gap-3">
          {[...SUBSCRIPTION_STATUSES, "none" as const].map((status) => (
            <li key={status} className="flex items-center gap-2">
              <SubscriptionPill
                status={status === "none" ? null : status}
                label={t(`sub_status.${status}`)}
              />
              <span className="font-numeric font-strong">
                {m.tenants.bySubscription[status] ?? 0}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={t("overview.billing.title", { month: monthText(m.period, dl) })}
        data-metrics="billing"
      >
        <StatGrid>
          <Stat
            value={percentText(m.billing.successRate, dl, none)}
            label={t("overview.billing.success_rate")}
          />
          <Stat
            value={percentText(m.billing.exceptionRate, dl, none)}
            label={t("overview.billing.exception_rate")}
          />
          <Stat value={m.billing.billed} label={t("overview.billing.billed")} />
          <Stat value={m.billing.failed} label={t("overview.billing.failed")} />
        </StatGrid>
        {reasons.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h3 className="font-strong">{t("overview.billing.reasons")}</h3>
            <ul className="flex flex-col gap-1">
              {reasons.map(([reason, count]) => (
                <li key={reason} className="flex gap-2">
                  <span className="font-numeric font-strong">{count}</span>
                  <code className="text-text-muted">{reason}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section title={t("overview.field.title")} data-metrics="field">
        <StatGrid>
          <Stat
            value={m.receiptActionsLast30Days.printed ?? 0}
            label={t("overview.field.printed")}
          />
          <Stat
            value={m.receiptActionsLast30Days.whatsapp_opened ?? 0}
            label={t("overview.field.whatsapp_opened")}
          />
          <Stat
            value={m.receiptActionsLast30Days.sms_opened ?? 0}
            label={t("overview.field.sms_opened")}
          />
          <Stat
            value={m.receiptActionsLast30Days.pdf_shared ?? 0}
            label={t("overview.field.pdf_shared")}
          />
          <Stat
            value={percentText(m.reconciliation.discrepancyRate, dl, none)}
            label={t("overview.field.discrepancy_rate", {
              count: m.reconciliation.acceptedLast30Days,
            })}
          />
          <Stat
            value={percentText(m.paymentSync.successRate, dl, none)}
            label={t("overview.field.sync_success", { count: m.paymentSync.attempts })}
          />
          <Stat value={m.paymentSync.duplicatesPrevented} label={t("overview.field.duplicates")} />
          <Stat value={syncRetryLater} label={t("overview.field.sync_retry")} />
        </StatGrid>
      </Section>

      <Section title={t("overview.health.title")} data-metrics="health">
        <StatGrid>
          <Stat value={m.jobs.failedLast7Days} label={t("overview.health.failed_jobs")} />
          <Stat value={m.jobs.waiting} label={t("overview.health.waiting_jobs")} />
          <Stat
            value={m.books.tenantsWithBreach}
            label={t("overview.health.books_problems", { count: m.books.tenantsChecked })}
          />
          <Stat value={notMeasured} label={t("overview.health.migration_exceptions")} />
        </StatGrid>
      </Section>
    </>
  );
}

/**
 * `/admin/tenants/<id>/support`: the support view (T-086, PLAN §9.4). Only while this admin holds
 * a live support access for this operator: the service checks the grant against the server clock
 * on **every** request and writes `support.data_viewed` to the Owner's audit log. Without one (never
 * opened, ended, or past its 2 hours) the page says so and links back. Read-only; no payments,
 * invoices, balances, customer names or phone numbers.
 */
import { supportView } from "@cb/core";
import { Button } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getServerRuntime } from "@/lib/auth/server";
import { AdminPageHeader, Facts, Outcome, Section } from "../../../_components/parts";
import { getAdminContext } from "../../../_lib/context";
import { displayLocale, monthText, rupeesText, timeText } from "../../../_lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("support.title"), robots: { index: false } };
}

export default async function SupportViewPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAdminContext();
  const { id } = await params;
  const [result, t, locale] = await Promise.all([
    supportView.call(getServerRuntime(), ctx, { operatorId: id }),
    getTranslations("admin"),
    getLocale(),
  ]);
  const dl = displayLocale(locale);
  const back = (
    <Button asChild variant="quiet" icon="back">
      <Link href={`/admin/tenants/${id}`}>{t("support.back")}</Link>
    </Button>
  );
  if (!result.ok) {
    if (result.error.code === "VALIDATION") notFound();
    if (result.error.code !== "FORBIDDEN") throw new Error(`support view: ${result.error.code}`);
    return (
      <>
        <AdminPageHeader title={t("support.title")} back={back} />
        <Outcome tone="danger">{t("support.no_access")}</Outcome>
      </>
    );
  }
  const v = result.value;

  return (
    <>
      <AdminPageHeader title={t("support.title_for", { name: v.operator.name })} back={back} />
      <Outcome tone="success">
        {t("support.banner", { time: timeText(v.grant.expiresAt, dl), reason: v.grant.reason })}
      </Outcome>

      <Section title={t("support.team")} data-support="team">
        <ul className="flex flex-col gap-2">
          {v.team.map((m) => (
            <li key={m.login} className="flex flex-wrap gap-x-4 border-border border-t pt-2">
              <span className="font-strong">{m.name}</span>
              <span>{t(`role.${m.role}`)}</span>
              <code>{m.login}</code>
              <span>{t(`user_status.${m.status}`)}</span>
              {m.role === "lineman" ? (
                <span>{t("support.phones", { count: m.activePhones })}</span>
              ) : (
                <span className="text-text-muted">
                  {t("support.last_web", {
                    time: timeText(m.lastWebActivityAt, dl, t("common.never")),
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("support.setup")} data-support="setup">
        <Facts
          rows={[
            { label: t("support.areas"), value: v.areaCount },
            { label: t("support.plans"), value: v.plans.length },
          ]}
        />
        <ul className="flex flex-col gap-1">
          {v.plans.map((p) => (
            <li key={`${p.name}-${p.status}`} className="flex gap-x-4">
              <span className="font-strong">{p.name}</span>
              <span className="font-numeric">{rupeesText(p.monthlyAmountPaise)}</span>
              <span className="text-text-muted">{p.status}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("support.runs")} data-support="runs">
        <ul className="flex flex-col gap-1">
          {v.billingRuns.map((r) => (
            <li key={r.runId} className="flex flex-wrap gap-x-4">
              <span className="font-strong">{monthText(r.period, dl)}</span>
              <span>{t(`run_status.${r.status}`)}</span>
              <span>
                {t("tenant.runs.counts", {
                  billed: r.createdCount + r.alreadyExistsCount,
                  failed: r.failedCount,
                })}
              </span>
            </li>
          ))}
        </ul>
        {v.billingProblems.length > 0 ? (
          <ul className="flex flex-col gap-1" data-support="problems">
            {v.billingProblems.map((p) => (
              <li key={`${p.period}-${p.customerCode}`} className="flex flex-wrap gap-x-4">
                <span>{monthText(p.period, dl)}</span>
                <span className="font-strong">{p.customerCode}</span>
                <code>{p.reason}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title={t("support.jobs")} data-support="jobs">
        {v.failedJobs.length === 0 ? (
          <p>{t("support.no_failed_jobs")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {v.failedJobs.map((j) => (
              <li key={j.jobId} className="flex flex-wrap gap-x-4">
                <code>{j.type}</code>
                <span>{timeText(j.finishedAt, dl, t("common.none"))}</span>
                <span className="text-text-muted">{j.lastError ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
        <p>
          {v.latestInvariantCheck
            ? t(`tenant.books.${v.latestInvariantCheck.status === "breach" ? "breach" : "ok"}`, {
                time: timeText(v.latestInvariantCheck.checkedAt, dl),
                count: Object.values(v.latestInvariantCheck.counts).reduce((a, b) => a + b, 0),
              })
            : t("tenant.books.never")}
        </p>
      </Section>
    </>
  );
}

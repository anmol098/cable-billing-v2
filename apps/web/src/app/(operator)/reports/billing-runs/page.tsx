/**
 * `/reports/billing-runs?month=&outcome=&area=&page=` (T-081, BRD §12 "Billing run report: which
 * customers were billed, skipped or failed and why? Operator, period, run ID, status/reason").
 *
 * One month's bill run (default: the latest): its state and how and when it was made, the totals
 * row (customers checked, new bills and their total, nothing to bill, problems) and every customer
 * it looked at with the result and why in plain words (problems first). A row opens the bill, or
 * the customer when no bill was made. Words come from T-047's `bills` namespace where they exist.
 * A plain GET form. Owner and Staff (`reports.view`); making or retrying bills stays on
 * `/bills/runs` (Owner).
 */
import { billingRunReport } from "@cb/core";
import { BILLING_RUN_ITEM_OUTCOMES } from "@cb/db";
import type { DisplayLocale, Period } from "@cb/domain";
import { Button, Select } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DownloadListLink } from "@/app/(operator)/reports/_export/download-link";
import { monthParam, monthText, runsHref } from "@/components/bills/format";
import { pickId, pickOption, pickPage, query, type Translate } from "@/components/reports/format";
import { AsOfNote, Pager, TotalsRow } from "@/components/reports/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { RunItemsTable, RunSummary, runTotalItems } from "./_components/run-view";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_billing_runs") };
}

export default async function BillingRunsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("reports.view")) notFound();
  const runtime = getServerRuntime();
  const params = await searchParams;
  const period: Period | undefined = monthParam(params.month);
  const outcome = pickOption(params.outcome, BILLING_RUN_ITEM_OUTCOMES);
  let areaId = pickId(params.area);
  const page = pickPage(params.page);

  let result = await billingRunReport.call(runtime, ctx, { period, outcome, areaId, page });
  if (!result.ok && result.error.code === "NOT_FOUND" && areaId) {
    areaId = undefined;
    result = await billingRunReport.call(runtime, ctx, { period, outcome, page });
  }
  if (!result.ok) throw new Error(`billing run report: ${result.error.code}`);
  const report = result.value;

  const [shell, tr, br, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("reports"),
    getTranslations("bills"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const bt = br as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const pages = Math.max(1, Math.ceil(report.totals.customers / report.pageSize));
  const field = "flex min-w-0 flex-col gap-1 text-base text-text";
  const href = (nextPage: number) =>
    `/reports/billing-runs${query({ month: report.period, outcome, area: areaId, page: nextPage })}`;
  const months = report.runs.some((run) => run.period === report.period)
    ? report.runs
    : [{ id: "none", period: report.period, status: null }, ...report.runs];

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.reports_billing_runs")}
        description={t("billing_runs.description")}
      />
      <AsOfNote asOf={report.asOf} locale={displayLocale} t={t} />
      <DownloadListLink kind="billing_runs" params={params} role={ctx.role} />

      <form
        method="get"
        action="/reports/billing-runs"
        aria-label={t("billing_runs.filters")}
        className="grid grid-cols-2 items-end gap-3 lg:grid-cols-4"
      >
        <label htmlFor="report-runs-month" className={field}>
          {t("billing_runs.month")}
          <Select id="report-runs-month" name="month" defaultValue={report.period}>
            {months.map((run) => (
              <option key={run.period} value={run.period}>
                {run.status
                  ? `${monthText(run.period, displayLocale)} · ${bt(`run_status.${run.status}`)}`
                  : `${monthText(run.period, displayLocale)} · ${bt("run_status.none")}`}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="report-runs-outcome" className={field}>
          {t("billing_runs.outcome_label")}
          <Select id="report-runs-outcome" name="outcome" defaultValue={outcome ?? ""}>
            <option value="">{t("billing_runs.any_outcome")}</option>
            {BILLING_RUN_ITEM_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {t(`billing_runs.outcome.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="report-runs-area" className={field}>
          {t("area")}
          <Select id="report-runs-area" name="area" defaultValue={areaId ?? ""}>
            <option value="">{t("all_areas")}</option>
            {report.areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("show")}
        </Button>
      </form>

      {report.run ? (
        <>
          <RunSummary run={report.run} t={t} bt={bt} locale={displayLocale} />
          <TotalsRow
            label={t("totals_label")}
            testId="runs-totals"
            items={runTotalItems(report.totals, t)}
          />
          <RunItemsTable rows={report.rows} t={t} bt={bt} />
          <Pager page={page} pages={pages} t={t} hrefFor={href} />
        </>
      ) : (
        <p className="text-base text-text" data-testid="no-run">
          {bt("status.none", { month: monthText(report.period, displayLocale) })}
        </p>
      )}
      <p className="text-base">
        <Link href={runsHref(report.period)} className="text-text underline underline-offset-4">
          {bt("this_month.open", { month: monthText(report.period, displayLocale) })}
        </Link>
      </p>
    </div>
  );
}

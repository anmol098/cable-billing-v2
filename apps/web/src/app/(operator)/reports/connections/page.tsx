/**
 * `/reports/connections?date=&area=&status=&plan=&page=` (T-081, BRD §12 "VC status / rental
 * report: which connections are active, suspended or disconnected and what rental applies? Area,
 * status, plan, effective date").
 *
 * Every connection that had started by the chosen IST day (default today): its status during that
 * day and since when (a stop or removal counts from the next day, like the bills), its plan and the
 * monthly rent of that month; the totals row (active, their monthly rent, stopped, removed). A row
 * opens the customer's Connections tab. Words come from T-034's `connections` namespace where they
 * exist. A plain GET form. Owner and Staff (`reports.view`).
 */
import { connectionsReport, OWN_AMOUNT } from "@cb/core";
import { ASSIGNMENT_STATUSES } from "@cb/db";
import {
  type BusinessDate,
  businessDateOf,
  type DisplayLocale,
  formatBusinessDate,
} from "@cb/domain";
import { Button, Input, Select } from "@cb/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  firstParam,
  pickId,
  pickOption,
  pickPage,
  pickPastDate,
  query,
  type Translate,
} from "@/components/reports/format";
import { AsOfNote, Pager, TotalsRow } from "@/components/reports/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { ConnectionsTable, connectionTotalItems } from "./_components/connections-view";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_connections") };
}

export default async function ConnectionsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("reports.view")) notFound();
  const runtime = getServerRuntime();
  const now = runtime.now();
  const params = await searchParams;
  const today = businessDateOf(now);
  const date: BusinessDate = pickPastDate(params.date, today) ?? today;
  let areaId = pickId(params.area);
  const status = pickOption(params.status, ASSIGNMENT_STATUSES);
  let plan: string | undefined =
    firstParam(params.plan) === OWN_AMOUNT ? OWN_AMOUNT : pickId(params.plan);
  const page = pickPage(params.page);

  let result = await connectionsReport.call(runtime, ctx, { date, areaId, status, plan, page });
  if (!result.ok && result.error.code === "NOT_FOUND") {
    // Another business's or a made-up area / plan: show all of them.
    areaId = undefined;
    plan = undefined;
    result = await connectionsReport.call(runtime, ctx, { date, status, page });
  }
  if (!result.ok) throw new Error(`connections report: ${result.error.code}`);
  const report = result.value;

  const [shell, tr, cr, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("reports"),
    getTranslations("connections"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const ct = cr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const pages = Math.max(1, Math.ceil(report.totals.connections / report.pageSize));
  const field = "flex min-w-0 flex-col gap-1 text-base text-text";
  const href = (nextPage: number) =>
    `/reports/connections${query({
      date: date === today ? undefined : date,
      area: areaId,
      status,
      plan,
      page: nextPage,
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.reports_connections")}
        description={t("connections.description")}
      />
      <AsOfNote asOf={report.asOf} locale={displayLocale} t={t} />

      <form
        method="get"
        action="/reports/connections"
        aria-label={t("connections.filters")}
        className="grid grid-cols-2 items-end gap-3 lg:grid-cols-5"
      >
        <label htmlFor="report-connections-date" className={field}>
          {t("connections.date")}
          <Input
            id="report-connections-date"
            type="date"
            name="date"
            defaultValue={date}
            max={today}
            aria-describedby="report-connections-date-help"
          />
        </label>
        <label htmlFor="report-connections-area" className={field}>
          {t("area")}
          <Select id="report-connections-area" name="area" defaultValue={areaId ?? ""}>
            <option value="">{t("all_areas")}</option>
            {report.areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="report-connections-status" className={field}>
          {t("connections.status")}
          <Select id="report-connections-status" name="status" defaultValue={status ?? ""}>
            <option value="">{t("connections.any_status")}</option>
            {ASSIGNMENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {ct(`status.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="report-connections-plan" className={field}>
          {t("connections.plan")}
          <Select id="report-connections-plan" name="plan" defaultValue={plan ?? ""}>
            <option value="">{t("connections.any_plan")}</option>
            {report.plans.map((option) => (
              <option key={option.id} value={option.id}>
                {option.retired
                  ? t("connections.retired_plan", { name: option.name })
                  : option.name}
              </option>
            ))}
            <option value={OWN_AMOUNT}>{ct("tab.own_amount")}</option>
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("show")}
        </Button>
      </form>
      <p id="report-connections-date-help" className="text-sm text-text-muted">
        {t("connections.date_help")}
      </p>

      <h2 className="font-strong text-lg text-text" data-testid="connections-day">
        {t("connections.on_day", { date: formatBusinessDate(report.date, displayLocale) })}
      </h2>
      <TotalsRow
        label={t("totals_label")}
        testId="connections-totals"
        items={connectionTotalItems(report.totals, t, ct)}
      />
      <ConnectionsTable rows={report.rows} t={t} ct={ct} locale={displayLocale} />
      <Pager page={page} pages={pages} t={t} hrefFor={href} />
    </div>
  );
}

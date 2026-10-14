/**
 * `/reports/handover?from=&to=&lineman=&status=&difference=&page=` (T-081, BRD §12 "Cash handover
 * reconciliation: does the cash handed over match expected cash? Lineman, session,
 * expected/actual cash, discrepancy"; FR-022).
 *
 * The chosen IST days (default the last 7, at most 31): the totals row (cash expected, cash handed
 * over, short / extra, not handed over yet; UPI apart) and one row per lineman's day with cash
 * expected, cash handed over, the difference and the lineman's reason, the status and what
 * happened (every handover, send-back and acceptance with who, when and notes). A row opens
 * T-062's review screen for that day. Words come from T-062's `linemen` namespace where they
 * exist. A plain GET form. Owner and Staff (`reports.view`).
 */
import { HANDOVER_DEFAULT_DAYS, HANDOVER_DIFFERENCES, handoverReport } from "@cb/core";
import { COLLECTION_SESSION_STATUSES } from "@cb/db";
import { businessDateOf, type DisplayLocale } from "@cb/domain";
import { Button, Input, Select } from "@cb/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DownloadListLink } from "@/app/(operator)/reports/_export/download-link";
import { pickId, pickOption, pickPage, query, type Translate } from "@/components/reports/format";
import { AsOfNote, Pager, TotalsRow } from "@/components/reports/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { pickDays } from "../collections/_lib/days";
import { HandoverTable, handoverTotalItems } from "./_components/handover-view";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_handover") };
}

export default async function HandoverReportPage({
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
  const { from, to, bad } = pickDays(params.from, params.to, today, HANDOVER_DEFAULT_DAYS);
  let linemanId = pickId(params.lineman);
  const status = pickOption(params.status, COLLECTION_SESSION_STATUSES);
  const difference = pickOption(params.difference, HANDOVER_DIFFERENCES);
  const page = pickPage(params.page);
  const input = { from, to, status, difference, page };

  let result = await handoverReport.call(runtime, ctx, { ...input, linemanId });
  if (!result.ok && result.error.code === "NOT_FOUND" && linemanId) {
    linemanId = undefined;
    result = await handoverReport.call(runtime, ctx, input);
  }
  if (!result.ok) throw new Error(`handover report: ${result.error.code}`);
  const report = result.value;

  const [shell, tr, lr, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("reports"),
    getTranslations("linemen"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const lt = lr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const pages = Math.max(1, Math.ceil(report.totals.days / report.pageSize));
  const field = "flex min-w-0 flex-col gap-1 text-base text-text";
  const href = (nextPage: number) =>
    `/reports/handover${query({ from, to, lineman: linemanId, status, difference, page: nextPage })}`;
  const { byStatus } = report.totals;

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.reports_handover")}
        description={t("handover.description")}
      />
      <AsOfNote asOf={report.asOf} locale={displayLocale} t={t} />
      <DownloadListLink kind="handover" params={params} role={ctx.role} />

      <form
        method="get"
        action="/reports/handover"
        aria-label={t("handover.filters")}
        className="grid grid-cols-2 items-end gap-3 lg:grid-cols-6"
      >
        <label htmlFor="report-handover-from" className={field}>
          {t("days.from")}
          <Input
            id="report-handover-from"
            type="date"
            name="from"
            defaultValue={from}
            max={today}
          />
        </label>
        <label htmlFor="report-handover-to" className={field}>
          {t("days.to")}
          <Input id="report-handover-to" type="date" name="to" defaultValue={to} max={today} />
        </label>
        <label htmlFor="report-handover-lineman" className={field}>
          {t("handover.lineman")}
          <Select id="report-handover-lineman" name="lineman" defaultValue={linemanId ?? ""}>
            <option value="">{t("handover.all_linemen")}</option>
            {report.linemen.map((user) => (
              <option key={user.id} value={user.id}>
                {user.active ? user.name : `${user.name} (${lt("card.switched_off")})`}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="report-handover-status" className={field}>
          {t("handover.status")}
          <Select id="report-handover-status" name="status" defaultValue={status ?? ""}>
            <option value="">{t("handover.any_status")}</option>
            {COLLECTION_SESSION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {lt(`status.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="report-handover-difference" className={field}>
          {t("handover.difference")}
          <Select id="report-handover-difference" name="difference" defaultValue={difference ?? ""}>
            <option value="">{t("handover.any_difference")}</option>
            {HANDOVER_DIFFERENCES.map((value) => (
              <option key={value} value={value}>
                {lt(`reason.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("show")}
        </Button>
      </form>
      {bad ? (
        <p role="status" className="text-base text-danger">
          {t("days.bad_week")}
        </p>
      ) : null}

      <TotalsRow
        label={t("totals_label")}
        testId="handover-totals"
        items={handoverTotalItems(report.totals, t)}
      />
      <p className="text-base text-text" data-testid="handover-status-line">
        {t("handover.totals.status_line", {
          submitted: byStatus.submitted,
          returned: byStatus.returned,
          accepted: byStatus.accepted,
          open: byStatus.open,
        })}
      </p>

      <HandoverTable rows={report.rows} t={t} lt={lt} locale={displayLocale} />
      <Pager page={page} pages={pages} t={t} hrefFor={href} />
    </div>
  );
}

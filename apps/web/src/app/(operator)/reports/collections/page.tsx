/**
 * `/reports/collections?from=&to=&collector=&page=` (T-081, BRD §12 "Daily lineman collections:
 * how much cash and UPI did each lineman collect? Lineman, business date, payment method"; B-014).
 *
 * The chosen IST days (default today, at most 31): the totals row (cash, UPI, payments, people),
 * who took how much over the days, and day by day. **Cash and UPI are always two columns**, never
 * added together. Payments the owner cancelled are listed apart and never counted. A row opens the
 * payments report for that person and those days, which lists the payments behind the numbers (its
 * totals are the same: tested in `@cb/core`). A plain GET form. Owner and Staff (`reports.view`).
 */
import { collectionsReport } from "@cb/core";
import { businessDateOf, type DisplayLocale } from "@cb/domain";
import { Button, Input, Select } from "@cb/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DownloadListLink } from "@/app/(operator)/reports/_export/download-link";
import { pickId, pickPage, query, type Translate } from "@/components/reports/format";
import { AsOfNote, Pager, TotalsRow } from "@/components/reports/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import {
  CollectionsByDay,
  CollectionsByPerson,
  collectionTotalItems,
} from "./_components/collections-view";
import { pickDays } from "./_lib/days";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_collections") };
}

export default async function CollectionsReportPage({
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
  const { from, to, bad } = pickDays(params.from, params.to, today);
  let collectorId = pickId(params.collector);
  const page = pickPage(params.page);

  let result = await collectionsReport.call(runtime, ctx, { from, to, collectorId, page });
  if (!result.ok && result.error.code === "NOT_FOUND" && collectorId) {
    // Another business's or a made-up person: show everybody.
    collectorId = undefined;
    result = await collectionsReport.call(runtime, ctx, { from, to, page });
  }
  if (!result.ok) throw new Error(`collections report: ${result.error.code}`);
  const report = result.value;

  const [shell, tr, pr, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("reports"),
    getTranslations("payments"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const pt = pr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const pages = Math.max(1, Math.ceil(report.rowCount / report.pageSize));
  const field = "flex min-w-0 flex-col gap-1 text-base text-text";
  const href = (nextPage: number) =>
    `/reports/collections${query({ from, to, collector: collectorId, page: nextPage })}`;

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.reports_collections")}
        description={t("collections.description")}
      />
      <AsOfNote asOf={report.asOf} locale={displayLocale} t={t} />
      <DownloadListLink kind="collections" params={params} role={ctx.role} />

      <form
        method="get"
        action="/reports/collections"
        aria-label={t("collections.filters")}
        className="grid grid-cols-2 items-end gap-3 lg:grid-cols-4"
      >
        <label htmlFor="report-collections-from" className={field}>
          {t("days.from")}
          <Input
            id="report-collections-from"
            type="date"
            name="from"
            defaultValue={from}
            max={today}
          />
        </label>
        <label htmlFor="report-collections-to" className={field}>
          {t("days.to")}
          <Input id="report-collections-to" type="date" name="to" defaultValue={to} max={today} />
        </label>
        <label htmlFor="report-collections-collector" className={field}>
          {pt("register.taken_by")}
          <Select
            id="report-collections-collector"
            name="collector"
            defaultValue={collectorId ?? ""}
          >
            <option value="">{pt("register.anyone")}</option>
            {report.collectors.map((user) => (
              <option key={user.id} value={user.id}>
                {user.active ? user.name : pt("register.switched_off", { name: user.name })}
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
          {t("days.bad_today")}
        </p>
      ) : null}

      <TotalsRow
        label={t("totals_label")}
        testId="collections-totals"
        items={collectionTotalItems(report.totals, t)}
      />

      <CollectionsByPerson rows={report.byCollector} from={from} to={to} t={t} />
      <CollectionsByDay rows={report.rows} t={t} locale={displayLocale} />
      <Pager page={page} pages={pages} t={t} hrefFor={href} />
    </div>
  );
}

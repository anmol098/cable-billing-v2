/**
 * `/reports/dues?date=&area=&show=&age=&page=` (T-080, FR-023, BRD §12 "Outstanding dues /
 * ageing", PLAN §12.1 "Due list + ageing (0–30/31–60/61–90/90+)"): who owes money, how much and
 * since when, by area, now or as of the end of a past day. A plain GET form, so filters work
 * without JavaScript and can be bookmarked. Totals always equal the customers' accounts (the
 * ledger) for the same filters and moment. Owner and Staff (`reports.view`).
 */
import { DUES_LIST_KINDS, duesReport } from "@cb/core";
import { businessDateOf, type DisplayLocale } from "@cb/domain";
import { Amount, Button, Input, Select } from "@cb/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DownloadListLink } from "@/app/(operator)/reports/_export/download-link";
import {
  BUCKETS,
  duesHref,
  pickId,
  pickOption,
  pickPage,
  pickPastDate,
  type Translate,
} from "@/components/reports/format";
import {
  AgeingCards,
  AsOfNote,
  DuesByAreaTable,
  DuesList,
  Pager,
  TotalsRow,
} from "@/components/reports/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_dues") };
}

export default async function DuesReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("reports.view")) notFound();
  const runtime = getServerRuntime();
  const params = await searchParams;
  const today = businessDateOf(runtime.now());
  const asOfDate = pickPastDate(params.date, today);
  const kind = pickOption(params.show, DUES_LIST_KINDS) ?? "due";
  const bucket = kind === "due" ? pickOption(params.age, BUCKETS) : undefined;
  const page = pickPage(params.page);
  let areaId = pickId(params.area);

  let result = await duesReport.call(runtime, ctx, { asOfDate, areaId, kind, bucket, page });
  if (!result.ok && result.error.code === "NOT_FOUND" && areaId) {
    // An area that isn't this tenant's (or was mistyped): show every area.
    areaId = undefined;
    result = await duesReport.call(runtime, ctx, { asOfDate, kind, bucket, page });
  }
  if (!result.ok) throw new Error(`dues report: ${result.error.code}`);
  const report = result.value;

  const [shell, tr, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("reports"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const date = asOfDate;
  const { totals, listTotals } = report;
  const listCount = kind === "due" ? listTotals.dueCustomers : listTotals.advanceCustomers;
  const pages = Math.max(1, Math.ceil(listCount / report.pageSize));

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader title={shell("routes.reports_dues")} description={t("dues.description")} />
      <AsOfNote asOf={report.asOf} locale={displayLocale} t={t} />
      <DownloadListLink kind="dues" params={params} role={ctx.role} />

      <form
        method="get"
        action="/reports/dues"
        aria-label={t("dues.filters")}
        className="flex flex-wrap items-end gap-3"
      >
        <label htmlFor="dues-date" className="flex flex-col gap-1 text-base text-text">
          {t("dues.date")}
          <Input
            id="dues-date"
            name="date"
            type="date"
            max={today}
            defaultValue={date ?? today}
            aria-describedby="dues-date-help"
            className="w-auto"
          />
        </label>
        <label htmlFor="dues-area" className="flex flex-col gap-1 text-base text-text">
          {t("area")}
          <Select id="dues-area" name="area" defaultValue={areaId ?? ""} className="w-auto">
            <option value="">{t("all_areas")}</option>
            {report.areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="dues-show" className="flex flex-col gap-1 text-base text-text">
          {t("dues.kind_label")}
          <Select id="dues-show" name="show" defaultValue={kind} className="w-auto">
            {DUES_LIST_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`dues.kind.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="dues-age" className="flex flex-col gap-1 text-base text-text">
          {t("dues.bucket_label")}
          <Select id="dues-age" name="age" defaultValue={bucket ?? ""} className="w-auto">
            <option value="">{t("dues.bucket_all")}</option>
            {BUCKETS.map((value) => (
              <option key={value} value={value}>
                {t(`dues.bucket.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("show")}
        </Button>
        <p id="dues-date-help" className="w-full text-sm text-text-muted">
          {t("dues.date_help")}
        </p>
      </form>

      <TotalsRow
        label={t("totals_label")}
        testId="dues-totals"
        items={[
          {
            id: "due",
            label: t("dues.total_due"),
            value: <Amount paise={totals.duePaise} tone="due" size="xl" />,
            note: t("customers", { count: totals.dueCustomers }),
          },
          {
            id: "credit",
            label: t("dues.credit"),
            value: <Amount paise={totals.advancePaise} tone="credit" size="xl" />,
            note: t("customers", { count: totals.advanceCustomers }),
          },
          {
            id: "net",
            label: t("dues.net"),
            value: (
              <Amount
                paise={totals.netPaise}
                tone="balance"
                size="xl"
                creditLabel={t("dues.credit")}
              />
            ),
            note: t("dues.net_help"),
          },
        ]}
      />

      <AgeingCards
        totals={totals}
        t={t}
        active={bucket}
        hrefFor={(value) => `${duesHref({ date, area: areaId, age: value })}#dues-list`}
      />

      <DuesByAreaTable
        byArea={report.byArea}
        totals={totals}
        t={t}
        hrefFor={(id, isTotal) =>
          isTotal || id === null
            ? `${duesHref({ date, show: kind, age: bucket })}#dues-list`
            : `${duesHref({ date, area: id, show: kind, age: bucket })}#dues-list`
        }
      />

      <section id="dues-list" aria-labelledby="dues-list-title" className="flex flex-col gap-3">
        <h2 id="dues-list-title" className="font-strong text-lg text-text">
          {kind === "due" ? t("dues.list_due") : t("dues.list_advance")}
          {bucket ? ` · ${t(`dues.bucket.${bucket}`)}` : ""}
        </h2>
        <DuesList
          rows={report.rows}
          kind={kind}
          t={t}
          locale={displayLocale}
          empty={kind === "due" ? t("dues.empty_due") : t("dues.empty_advance")}
          bucket={bucket}
        />
        <TotalsRow
          label={t("total")}
          testId="dues-list-totals"
          items={[
            { id: "count", label: t("total"), value: t("customers", { count: listCount }) },
            kind === "due"
              ? {
                  id: "amount",
                  label: bucket
                    ? t("dues.col.due_in", { age: t(`dues.bucket.${bucket}`) })
                    : t("dues.col.due"),
                  value: (
                    <Amount
                      paise={bucket ? listTotals.buckets[bucket] : listTotals.duePaise}
                      tone="due"
                      size="xl"
                    />
                  ),
                }
              : {
                  id: "amount",
                  label: t("dues.col.credit"),
                  value: <Amount paise={listTotals.advancePaise} tone="credit" size="xl" />,
                },
          ]}
        />
        <Pager
          page={page}
          pages={pages}
          t={t}
          hrefFor={(next) => duesHref({ date, area: areaId, show: kind, age: bucket, page: next })}
        />
      </section>
    </div>
  );
}

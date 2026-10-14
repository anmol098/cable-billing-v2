/**
 * `/reports/bills?from=&to=&area=&paid=&page=` (T-080, FR-023, BRD §12 "Invoice register"): the
 * bills of up to 12 months with what is paid and still due, by area and "Paid?", with a totals row
 * over every matching bill and the moment the numbers are from. Same bills, same numbers and the
 * same words as the Bills section's one-month list (`/bills/register`, T-047); a row opens the
 * bill. A plain GET form. Owner and Staff (`reports.view`).
 */
import { BILL_PAY_STATES, type BillPayState, type BillRow, billRegisterReport } from "@cb/core";
import { type DisplayLocale, periodOfInstant } from "@cb/domain";
import {
  Amount,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Select,
  StatusPill,
} from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DownloadListLink } from "@/app/(operator)/reports/_export/download-link";
import { billHref, monthText, PAY_STATE_PILL } from "@/components/bills/format";
import {
  monthOptions,
  pickId,
  pickMonthRange,
  pickOption,
  pickPage,
  query,
  type Translate,
} from "@/components/reports/format";
import { AsOfNote, Pager, TotalsRow } from "@/components/reports/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_bills") };
}

const FILTER_STATES: readonly BillPayState[] = BILL_PAY_STATES.filter((s) => s !== "no_charge");

export default async function BillsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("reports.view")) notFound();
  const runtime = getServerRuntime();
  const params = await searchParams;
  const current = periodOfInstant(runtime.now());
  const range = pickMonthRange(params.from, params.to, current);
  const payState = pickOption(params.paid, FILTER_STATES);
  const page = pickPage(params.page);
  let areaId = pickId(params.area);
  const input = { from: range.from, to: range.to, payState, page };

  let result = await billRegisterReport.call(runtime, ctx, { ...input, areaId });
  if (!result.ok && result.error.code === "NOT_FOUND" && areaId) {
    areaId = undefined;
    result = await billRegisterReport.call(runtime, ctx, input);
  }
  if (!result.ok) throw new Error(`bill register report: ${result.error.code}`);
  const report = result.value;

  const [shell, tr, bills, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("reports"),
    getTranslations("bills"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const pages = Math.max(1, Math.ceil(report.totals.count / report.pageSize));
  const months = monthOptions(current);

  const columns: DataTableColumn<BillRow>[] = [
    {
      id: "customer",
      header: t("bills.col.customer"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.customer.name}</span>
          <span className="font-numeric text-sm text-text-muted">
            {row.customer.code}
            {row.customer.areaName ? ` · ${row.customer.areaName}` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "month",
      header: t("bills.col.month"),
      cell: (row) => (
        <span className="flex flex-col">
          <span className="text-base text-text">
            {row.kind === "opening_balance"
              ? t("bills.old_due_bill")
              : monthText(row.period, displayLocale)}
          </span>
          <span className="font-numeric text-sm text-text-muted">
            {t("bills.bill_no", { number: row.invoiceNumber })}
          </span>
        </span>
      ),
    },
    {
      id: "amount",
      header: t("bills.col.amount"),
      align: "end",
      cell: (row) => <Amount paise={row.chargesPaise} />,
    },
    {
      id: "paid",
      header: t("bills.col.paid"),
      align: "end",
      cell: (row) => <Amount paise={row.paidPaise} weight="regular" />,
    },
    {
      id: "status",
      header: t("bills.col.status"),
      cell: (row) => {
        const style = PAY_STATE_PILL[row.payState];
        return (
          <span className="flex flex-col items-start gap-1">
            <StatusPill
              variant={style.variant}
              icon={style.icon}
              label={bills(`pay_state.${row.payState}`)}
            />
            {row.outstandingPaise > 0 && row.payState !== "void" ? (
              <Amount paise={row.outstandingPaise} tone="due" size="sm" dueLabel={t("bills.due")} />
            ) : null}
          </span>
        );
      },
    },
  ];

  const href = (nextPage: number) =>
    `/reports/bills${query({
      from: range.from,
      to: range.to,
      area: areaId,
      paid: payState,
      page: nextPage,
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader title={shell("routes.reports_bills")} description={t("bills.description")} />
      <AsOfNote asOf={report.asOf} locale={displayLocale} t={t} />
      <DownloadListLink kind="bills" params={params} role={ctx.role} />

      <form
        method="get"
        action="/reports/bills"
        aria-label={t("bills.filters")}
        className="flex flex-wrap items-end gap-3"
      >
        <label htmlFor="bills-from" className="flex flex-col gap-1 text-base text-text">
          {t("bills.from")}
          <Select id="bills-from" name="from" defaultValue={range.from} className="w-auto">
            {months.map((p) => (
              <option key={p} value={p}>
                {monthText(p, displayLocale)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="bills-to" className="flex flex-col gap-1 text-base text-text">
          {t("bills.to")}
          <Select id="bills-to" name="to" defaultValue={range.to} className="w-auto">
            {months.map((p) => (
              <option key={p} value={p}>
                {monthText(p, displayLocale)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="bills-area" className="flex flex-col gap-1 text-base text-text">
          {t("area")}
          <Select id="bills-area" name="area" defaultValue={areaId ?? ""} className="w-auto">
            <option value="">{t("all_areas")}</option>
            {report.areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="bills-paid" className="flex flex-col gap-1 text-base text-text">
          {t("bills.pay_state")}
          <Select id="bills-paid" name="paid" defaultValue={payState ?? ""} className="w-auto">
            <option value="">{t("bills.all_pay_states")}</option>
            {FILTER_STATES.map((state) => (
              <option key={state} value={state}>
                {bills(`pay_state.${state}`)}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("show")}
        </Button>
      </form>
      {range.fixed ? (
        <p role="status" className="text-base text-danger">
          {t("bills.bad_range")}
        </p>
      ) : null}

      <DataTable
        caption={t("bills.caption")}
        columns={columns}
        rows={report.rows}
        rowKey={(row) => row.id}
        rowHref={(row) => billHref(row.id)}
        linkAs={Link}
        empty={<EmptyState icon="bill" message={t("bills.empty")} />}
      />

      <TotalsRow
        label={t("totals_label")}
        testId="bills-totals"
        items={[
          {
            id: "count",
            label: t("total"),
            value: t("bills.count", { count: report.totals.count }),
          },
          {
            id: "billed",
            label: t("bills.billed"),
            value: <Amount paise={report.totals.chargesPaise} size="xl" />,
          },
          {
            id: "paid",
            label: t("bills.paid"),
            value: <Amount paise={report.totals.paidPaise} size="xl" />,
          },
          {
            id: "due",
            label: t("bills.due"),
            value: <Amount paise={report.totals.outstandingPaise} tone="balance" size="xl" />,
          },
        ]}
      />

      <Pager page={page} pages={pages} t={t} hrefFor={href} />
    </div>
  );
}

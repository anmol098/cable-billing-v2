/**
 * `/reports/payments?from=&to=&collector=&method=&status=&page=` (T-080, FR-023, BRD §12
 * "Payment register: date, collector, method, reference, sync/posting status"): every payment of
 * the chosen IST days (default this month) with who took it, cash or UPI, when the money was
 * taken and when it reached the office, and its status (counted / cancelled / to check). The
 * totals row (cash, UPI, cash + UPI) leaves cancelled payments out and equals the ledger for the
 * same filters (tested in `@cb/core` reports/registers/payments.test.ts).
 *
 * It reuses T-048's register service (`listPayments`) and words (`payments` namespace), so the
 * Payments section and this report never disagree. A row opens the payment. A plain GET form.
 * Owner and Staff (`reports.view` for the page, `dashboard.view` for the read).
 */
import { listPayments, PAYMENT_LIST_STATUSES, type PaymentRegisterRow } from "@cb/core";
import { type BusinessDate, businessDateOf, type DisplayLocale } from "@cb/domain";
import { Amount, Button, DataTable, type DataTableColumn, EmptyState, Input, Select } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DownloadListLink } from "@/app/(operator)/reports/_export/download-link";
import { dayParam, monthStart, paymentHref, whenText } from "@/components/payments/format";
import { MethodPill, PaymentStatusPill } from "@/components/payments/payment-parts";
import { pickId, pickOption, pickPage, query, type Translate } from "@/components/reports/format";
import { AsOfNote, Pager, TotalsRow } from "@/components/reports/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
/** A phone payment that reached the office this long after it was taken shows both times. */
const LATE_MS = 10 * 60_000;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_payments") };
}

export default async function PaymentsReportPage({
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
  let from: BusinessDate = dayParam(params.from) ?? monthStart(today);
  let to: BusinessDate = dayParam(params.to) ?? today;
  const badDates = from > to;
  if (badDates) {
    from = monthStart(today);
    to = today;
  }
  let collectorId = pickId(params.collector);
  const method = pickOption(params.method, ["cash", "upi"] as const);
  const status = pickOption(params.status, PAYMENT_LIST_STATUSES) ?? "all";
  const page = pickPage(params.page);
  const offset = Math.min((page - 1) * PAGE_SIZE, 10_000);
  const input = { from, to, method, status, limit: PAGE_SIZE, offset };

  let result = await listPayments.call(runtime, ctx, { ...input, collectorId });
  if (!result.ok && result.error.code === "NOT_FOUND" && collectorId) {
    collectorId = undefined;
    result = await listPayments.call(runtime, ctx, input);
  }
  if (!result.ok) throw new Error(`payments report: ${result.error.code}`);
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
  const pages = report.hasMore ? page + 1 : page;
  const { totals } = report;

  const columns: DataTableColumn<PaymentRegisterRow>[] = [
    {
      id: "customer",
      header: t("payments.col.customer"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.customerName}</span>
          <span className="font-numeric text-sm text-text-muted">
            {row.customerCode}
            {row.receiptNumber
              ? ` · ${pt("register.receipt_no", { number: row.receiptNumber })}`
              : ""}
          </span>
        </span>
      ),
    },
    {
      id: "amount",
      header: t("payments.col.amount"),
      align: "end",
      cell: (row) => (
        <span className="flex flex-col items-end gap-1">
          <Amount
            paise={row.amountPaise}
            weight={row.cancelled ? "regular" : "strong"}
            className={row.cancelled ? "line-through" : undefined}
          />
          <MethodPill t={pt} method={row.method} />
        </span>
      ),
    },
    {
      id: "taken_by",
      header: t("payments.col.taken_by"),
      cell: (row) => (
        <span className="flex flex-col">
          <span className="text-base text-text">{row.collectorName ?? t("payments.nobody")}</span>
          <span className="text-sm text-text-muted">{pt(`source.${row.source}`)}</span>
        </span>
      ),
    },
    {
      id: "when",
      header: t("payments.col.when"),
      cell: (row) => {
        const late = row.postedAt.getTime() - row.recordedAt.getTime() > LATE_MS;
        return (
          <span className="flex flex-col">
            <span className="text-base text-text">
              {t("payments.taken_at", { when: whenText(pt, row.recordedAt, displayLocale) })}
            </span>
            {late ? (
              <span className="text-sm text-text-muted" data-testid="reached-late">
                {t("payments.reached_at", { when: whenText(pt, row.postedAt, displayLocale) })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "status",
      header: t("payments.col.status"),
      cell: (row) => (
        <PaymentStatusPill t={pt} cancelled={row.cancelled} reviewStatus={row.reviewStatus} />
      ),
    },
  ];

  const field = "flex min-w-0 flex-col gap-1 text-base text-text";
  const href = (nextPage: number) =>
    `/reports/payments${query({
      from,
      to,
      collector: collectorId,
      method,
      status: status === "all" ? undefined : status,
      page: nextPage,
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.reports_payments")}
        description={t("payments.description")}
      />
      <AsOfNote asOf={{ at: now, date: today, endOfDay: false }} locale={displayLocale} t={t} />
      <DownloadListLink kind="payments" params={params} role={ctx.role} />

      <form
        method="get"
        action="/reports/payments"
        aria-label={t("payments.filters")}
        className="grid grid-cols-2 items-end gap-3 lg:grid-cols-6"
      >
        <label htmlFor="report-payments-from" className={field}>
          {pt("register.from")}
          <Input
            id="report-payments-from"
            type="date"
            name="from"
            defaultValue={from}
            max={today}
          />
        </label>
        <label htmlFor="report-payments-to" className={field}>
          {pt("register.to")}
          <Input id="report-payments-to" type="date" name="to" defaultValue={to} max={today} />
        </label>
        <label htmlFor="report-payments-collector" className={field}>
          {pt("register.taken_by")}
          <Select id="report-payments-collector" name="collector" defaultValue={collectorId ?? ""}>
            <option value="">{pt("register.anyone")}</option>
            {report.collectors.map((user) => (
              <option key={user.id} value={user.id}>
                {user.active ? user.name : pt("register.switched_off", { name: user.name })}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="report-payments-method" className={field}>
          {pt("register.method_label")}
          <Select id="report-payments-method" name="method" defaultValue={method ?? ""}>
            <option value="">{pt("register.method_any")}</option>
            <option value="cash">{pt("method.cash")}</option>
            <option value="upi">{pt("method.upi")}</option>
          </Select>
        </label>
        <label htmlFor="report-payments-status" className={field}>
          {pt("register.status_label")}
          <Select id="report-payments-status" name="status" defaultValue={status}>
            <option value="all">{pt("register.status_all")}</option>
            <option value="counted">{pt("status.counted")}</option>
            <option value="cancelled">{pt("status.cancelled")}</option>
            <option value="to_check">{pt("status.to_check")}</option>
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("show")}
        </Button>
      </form>
      {badDates ? (
        <p role="status" className="text-base text-danger">
          {t("payments.bad_dates")}
        </p>
      ) : null}

      <DataTable
        caption={t("payments.caption")}
        columns={columns}
        rows={report.rows}
        rowKey={(row) => row.id}
        rowHref={(row) => paymentHref(row.id)}
        linkAs={Link}
        empty={<EmptyState icon="collect" message={t("payments.empty")} />}
      />

      <TotalsRow
        label={t("totals_label")}
        testId="payments-totals"
        items={[
          {
            id: "count",
            label: t("total"),
            value: t("payments.count", { count: totals.count }),
            note: t("payments.cancelled_count", { count: totals.cancelledCount }),
          },
          {
            id: "cash",
            label: t("payments.cash"),
            value: <Amount paise={totals.cashPaise} size="xl" />,
          },
          {
            id: "upi",
            label: t("payments.upi"),
            value: <Amount paise={totals.upiPaise} size="xl" />,
          },
          {
            id: "all",
            label: t("payments.cash_and_upi"),
            value: <Amount paise={totals.cashPaise + totals.upiPaise} size="xl" />,
            note: t("payments.to_check_count", { count: totals.toCheckCount }),
          },
        ]}
      />

      <Pager page={page} pages={pages} t={t} hrefFor={href} />
    </div>
  );
}

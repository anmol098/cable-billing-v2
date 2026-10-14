/**
 * Pieces of the daily collections report (T-081): who took how much, day by day, and the totals.
 * Server-renderable (no hooks); words come in through the `reports` translator, amounts as paise.
 * **Cash and UPI are always two columns** (B-014), each headed by its icon, colour and word.
 */
import type { CollectionAmounts, CollectionDayRow, CollectionPersonRow } from "@cb/core";
import { type BusinessDate, type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Amount, DataTable, type DataTableColumn, EmptyState, Icon } from "@cb/ui";
import Link from "next/link";
import { rupees } from "@/components/bills/format";
import type { Translate } from "@/components/reports/format";
import type { TotalItem } from "@/components/reports/parts";
import { paymentsReportHref } from "../_lib/days";

/** The column heading of a payment method: icon + colour + word (PLAN §2.2). */
export function MethodHeader({ method, t }: { method: "cash" | "upi"; t: Translate }) {
  return (
    <span
      className={`inline-flex items-center gap-1 ${method === "cash" ? "text-cash" : "text-upi"}`}
    >
      <Icon name={method} aria-hidden />
      <span>{t(`collections.${method}`)}</span>
    </span>
  );
}

/** "Ravi Kumar" + "Lineman", or "From the old app" for payments without a collector. */
function Who({
  row,
  t,
  extra,
}: {
  row: { name: string | null; role: string | null; collectorId: string | null };
  t: Translate;
  extra?: string | undefined;
}) {
  const role = row.role === null ? null : t(`collections.role.${row.role}`);
  return (
    <span className="flex flex-col">
      <span>{row.collectorId === null ? t("collections.old_app") : (row.name ?? "")}</span>
      <span className="text-sm font-regular text-text-muted">
        {[extra, role].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

/** The payments count, with the cancelled ones (never counted) under it. */
function PaymentsCell({ row, t }: { row: CollectionAmounts; t: Translate }) {
  return (
    <span className="flex flex-col items-end">
      <span className="font-numeric text-base text-text">{row.count}</span>
      {row.cancelledCount > 0 ? (
        <span className="text-sm text-danger">
          {t("collections.cancelled", {
            count: row.cancelledCount,
            amount: rupees(row.cancelledPaise),
          })}
        </span>
      ) : null}
    </span>
  );
}

function amountColumns<Row extends CollectionAmounts>(t: Translate): DataTableColumn<Row>[] {
  return [
    {
      id: "cash",
      header: <MethodHeader method="cash" t={t} />,
      align: "end",
      cell: (row) => <Amount paise={row.cashPaise} />,
    },
    {
      id: "upi",
      header: <MethodHeader method="upi" t={t} />,
      align: "end",
      cell: (row) => <Amount paise={row.upiPaise} />,
    },
    {
      id: "payments",
      header: t("collections.col.payments"),
      align: "end",
      cell: (row) => <PaymentsCell row={row} t={t} />,
    },
  ];
}

/** One row per person over the chosen days; a row opens their payments. */
export function CollectionsByPerson({
  rows,
  from,
  to,
  t,
}: {
  rows: readonly CollectionPersonRow[];
  from: BusinessDate;
  to: BusinessDate;
  t: Translate;
}) {
  const columns: DataTableColumn<CollectionPersonRow>[] = [
    {
      id: "who",
      header: t("collections.who"),
      primary: true,
      cell: (row) => <Who row={row} t={t} extra={t("collections.days", { count: row.days })} />,
    },
    ...amountColumns<CollectionPersonRow>(t),
  ];
  return (
    <section aria-labelledby="by-person-title" className="flex flex-col gap-3">
      <h2 id="by-person-title" className="font-strong text-lg text-text">
        {t("collections.by_person")}
      </h2>
      <DataTable
        caption={t("collections.by_person")}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.collectorId ?? "old-app"}
        rowHref={(row) => paymentsReportHref(from, to, row.collectorId)}
        linkAs={Link}
        empty={<EmptyState icon="collect" message={t("collections.empty")} />}
      />
    </section>
  );
}

/** One row per person per day, newest day first; a row opens that day's payments. */
export function CollectionsByDay({
  rows,
  t,
  locale,
}: {
  rows: readonly CollectionDayRow[];
  t: Translate;
  locale: DisplayLocale;
}) {
  const columns: DataTableColumn<CollectionDayRow>[] = [
    {
      id: "who_day",
      header: t("collections.col.who_day"),
      primary: true,
      cell: (row) => <Who row={row} t={t} extra={formatBusinessDate(row.businessDate, locale)} />,
    },
    ...amountColumns<CollectionDayRow>(t),
  ];
  return (
    <section aria-labelledby="by-day-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="by-day-title" className="font-strong text-lg text-text">
          {t("collections.by_day")}
        </h2>
        <p className="text-sm text-text-muted">{t("collections.by_day_help")}</p>
      </div>
      <DataTable
        caption={t("collections.by_day")}
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.businessDate}:${row.collectorId ?? "old-app"}`}
        rowHref={(row) => paymentsReportHref(row.businessDate, row.businessDate, row.collectorId)}
        linkAs={Link}
        empty={<EmptyState icon="collect" message={t("collections.empty")} />}
      />
    </section>
  );
}

/** The totals row: cash, UPI (never added together), payments and people. */
export function collectionTotalItems(
  totals: CollectionAmounts & { people: number },
  t: Translate,
): TotalItem[] {
  return [
    {
      id: "cash",
      label: t("collections.cash"),
      value: <Amount paise={totals.cashPaise} size="xl" />,
    },
    {
      id: "upi",
      label: t("collections.upi"),
      value: <Amount paise={totals.upiPaise} size="xl" />,
      note: t("collections.upi_note"),
    },
    {
      id: "count",
      label: t("collections.payments"),
      value: t("collections.count", { count: totals.count }),
      note:
        totals.cancelledCount > 0
          ? t("collections.cancelled", {
              count: totals.cancelledCount,
              amount: rupees(totals.cancelledPaise),
            })
          : undefined,
    },
    {
      id: "people",
      label: t("collections.who"),
      value: t("collections.people", { count: totals.people }),
    },
  ];
}

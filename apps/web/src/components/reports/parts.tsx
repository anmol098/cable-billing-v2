/**
 * Building blocks of the money reports (T-080): the "as of" line, the totals row, the ageing
 * cards, the dues-by-area table and the dues list. Server-renderable (no hooks); every word comes
 * in through the `reports` translator `t` (and `bills` for pay states), amounts as paise.
 */
import type { DuesAreaTotals, DuesRow, DuesTotals, ReportAsOf } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import {
  Amount,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Icon,
  StatusPill,
} from "@cb/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { monthText, rupees } from "@/components/bills/format";
import {
  asOfText,
  BUCKET_PILL,
  BUCKETS,
  type Bucket,
  customerHref,
  type Translate,
} from "./format";

/** "Numbers as of …": every report says when its numbers are from (FR-023). */
export function AsOfNote({
  asOf,
  locale,
  t,
}: {
  asOf: ReportAsOf;
  locale: DisplayLocale;
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-1" data-testid="as-of">
      <p className="flex items-center gap-2 font-strong text-base text-text">
        <Icon name="today" aria-hidden />
        <span>{asOfText(asOf, locale, t)}</span>
      </p>
      <p className="text-sm text-text-muted">{t("as_of.help")}</p>
    </div>
  );
}

export interface TotalItem {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
  /** A short second line (e.g. a count). */
  readonly note?: string | undefined;
}

/** The totals row: label + number pairs in one bordered box, numbers first (PLAN §2.2). */
export function TotalsRow({
  label,
  items,
  testId = "report-totals",
}: {
  label: string;
  items: readonly TotalItem[];
  testId?: string;
}) {
  return (
    <section aria-label={label} data-testid={testId}>
      <Card>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {items.map((item) => (
            <div key={item.id} className="flex flex-col gap-1" data-testid={`${testId}-${item.id}`}>
              <dt className="text-sm text-text-muted">{item.label}</dt>
              <dd className="flex flex-col gap-1">
                <span className="text-xl">{item.value}</span>
                {item.note ? <span className="text-sm text-text-muted">{item.note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </section>
  );
}

/** The four ageing buckets; each opens the list of customers whose oldest due is that old. */
export function AgeingCards({
  totals,
  t,
  hrefFor,
  active,
}: {
  totals: DuesTotals;
  t: Translate;
  hrefFor: (bucket: Bucket) => string;
  active?: Bucket | undefined;
}) {
  return (
    <section aria-labelledby="ageing-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="ageing-title" className="font-strong text-lg text-text">
          {t("dues.ageing_title")}
        </h2>
        <p className="text-sm text-text-muted">{t("dues.ageing_help")}</p>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {BUCKETS.map((bucket) => {
          const style = BUCKET_PILL[bucket];
          const count = totals.customersByBucket[bucket];
          return (
            <li key={bucket}>
              <Card asChild className="flex h-full flex-col gap-2 hover:bg-surface">
                <Link
                  href={hrefFor(bucket)}
                  aria-current={active === bucket ? "true" : undefined}
                  aria-label={`${t(`dues.bucket.${bucket}`)}: ₹${rupees(totals.buckets[bucket])}. ${t("dues.see_customers")}`}
                  data-testid={`bucket-${bucket}`}
                  className={active === bucket ? "border-text" : undefined}
                >
                  <StatusPill
                    variant={style.variant}
                    icon={style.icon}
                    label={t(`dues.bucket.${bucket}`)}
                  />
                  <Amount
                    paise={totals.buckets[bucket]}
                    tone={totals.buckets[bucket] > 0 ? "due" : "neutral"}
                    size="xl"
                    data-testid={`bucket-${bucket}-amount`}
                  />
                  <span className="text-sm text-text-muted">{t("customers", { count })}</span>
                </Link>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type AreaRow = DuesAreaTotals & { readonly isTotal?: boolean };

/** Due per area and bucket, with a Total row (5 columns: area + 4 buckets). */
export function DuesByAreaTable({
  byArea,
  totals,
  t,
  hrefFor,
}: {
  byArea: readonly DuesAreaTotals[];
  totals: DuesTotals;
  t: Translate;
  hrefFor: (areaId: string | null, isTotal: boolean) => string;
}) {
  const rows: AreaRow[] = [...byArea, { ...totals, areaId: null, areaName: null, isTotal: true }];
  const columns: DataTableColumn<AreaRow>[] = [
    {
      id: "area",
      header: t("area"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.isTotal ? t("total") : (row.areaName ?? t("no_area"))}</span>
          <span className="text-sm text-text-muted font-regular">
            {t("dues.area_due", {
              amount: `₹${rupees(row.duePaise)}`,
              customers: t("customers", { count: row.dueCustomers }),
            })}
            {row.advancePaise > 0
              ? ` · ${t("dues.area_credit", { amount: `₹${rupees(row.advancePaise)}` })}`
              : ""}
          </span>
        </span>
      ),
    },
    ...BUCKETS.map(
      (bucket): DataTableColumn<AreaRow> => ({
        id: bucket,
        header: t(`dues.bucket.${bucket}`),
        align: "end",
        cell: (row) => (
          <Amount
            paise={row.buckets[bucket]}
            tone={row.buckets[bucket] > 0 ? "due" : "neutral"}
            weight={row.isTotal ? "strong" : "regular"}
          />
        ),
      }),
    ),
  ];
  return (
    <section aria-labelledby="by-area-title" className="flex flex-col gap-3">
      <h2 id="by-area-title" className="font-strong text-lg text-text">
        {t("dues.by_area_title")}
      </h2>
      <DataTable
        caption={t("dues.by_area_title")}
        columns={columns}
        rows={rows}
        rowKey={(row) => (row.isTotal ? "total" : (row.areaId ?? "none"))}
        rowHref={(row) => hrefFor(row.areaId, row.isTotal === true)}
        linkAs={Link}
      />
    </section>
  );
}

/** The customers who owe (or have credit), worst first, rows open the customer. */
export function DuesList({
  rows,
  kind,
  t,
  locale,
  empty,
  bucket,
}: {
  rows: readonly DuesRow[];
  kind: "due" | "advance";
  t: Translate;
  locale: DisplayLocale;
  empty: string;
  /** A bucket filter: the Due column shows the due of that age (what the bucket card adds up). */
  bucket?: Bucket | undefined;
}) {
  const customer: DataTableColumn<DuesRow> = {
    id: "customer",
    header: t("dues.col.customer"),
    primary: true,
    cell: (row) => (
      <span className="flex flex-col">
        <span>{row.customerName}</span>
        <span className="font-numeric text-sm text-text-muted">
          {row.customerCode}
          {row.areaName ? ` · ${row.areaName}` : ""}
          {row.customerStatus === "inactive" ? ` · ${t("dues.closed")}` : ""}
        </span>
      </span>
    ),
  };
  const columns: DataTableColumn<DuesRow>[] =
    kind === "due"
      ? [
          customer,
          {
            id: "due",
            header: bucket
              ? t("dues.col.due_in", { age: t(`dues.bucket.${bucket}`) })
              : t("dues.col.due"),
            align: "end",
            cell: (row) =>
              bucket ? (
                <span className="flex flex-col items-end">
                  <Amount paise={row.buckets[bucket]} tone="due" />
                  <span className="text-sm text-text-muted">
                    {t("dues.of_total", { amount: `₹${rupees(row.duePaise)}` })}
                  </span>
                </span>
              ) : (
                <Amount paise={row.duePaise} tone="due" />
              ),
          },
          {
            id: "since",
            header: t("dues.col.since"),
            cell: (row) => (
              <span className="text-base text-text">
                {row.oldestDuePeriod
                  ? monthText(row.oldestDuePeriod, locale)
                  : t("dues.not_on_bill")}
              </span>
            ),
          },
          {
            id: "age",
            header: t("dues.col.age"),
            cell: (row) => {
              const bucket = row.oldestBucket ?? "d0_30";
              const style = BUCKET_PILL[bucket];
              return (
                <StatusPill
                  variant={style.variant}
                  icon={style.icon}
                  label={t(`dues.bucket.${bucket}`)}
                />
              );
            },
          },
        ]
      : [
          customer,
          {
            id: "credit",
            header: t("dues.col.credit"),
            align: "end",
            cell: (row) => <Amount paise={row.advancePaise} tone="credit" />,
          },
        ];
  return (
    <DataTable
      caption={kind === "due" ? t("dues.list_due") : t("dues.list_advance")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.customerId}
      rowHref={(row) => customerHref(row.customerId)}
      linkAs={Link}
      empty={<EmptyState icon="customer" message={empty} />}
    />
  );
}

/** Previous / next page links. */
export function Pager({
  page,
  pages,
  hrefFor,
  t,
}: {
  page: number;
  pages: number;
  hrefFor: (page: number) => string;
  t: Translate;
}) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={t("pages")} className="flex flex-wrap items-center gap-3">
      {page > 1 ? (
        <Button asChild variant="quiet" icon="back">
          <Link href={hrefFor(page - 1)}>{t("previous")}</Link>
        </Button>
      ) : null}
      <span className="text-base text-text">{t("page", { page })}</span>
      {page < pages ? (
        <Button asChild variant="quiet" icon="next">
          <Link href={hrefFor(page + 1)}>{t("next")}</Link>
        </Button>
      ) : null}
    </nav>
  );
}

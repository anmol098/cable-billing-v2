/**
 * `/bills/adjustments?state=&source=&page=` "Bill changes" (T-045, PLAN §12.1 Bills, D-14,
 * FR-024): every extra charge and every amount taken off after bills were made, newest first, with
 * why (plan changed, started this month, the Owner's reason), where it stands (waiting for the
 * next bill, on bill INV-…, taken off) and who made it. A plain GET form for the filters. The
 * primary action is the Owner's "New bill change". Owner only in the menu (`adjustments.manage`);
 * the list service itself is a read (`billing.preview`), so it works in read-only mode.
 */
import { type AdjustmentListRow, listAdjustments } from "@cb/core";
import { type DisplayLocale, isPeriod, periodLabel } from "@cb/domain";
import {
  Amount,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  EmptyState,
  PAGE_ACTION_CLEARANCE,
  Select,
  StatusPill,
} from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { istDate, rupees } from "@/components/bills/format";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { ADJUSTMENT_SOURCES, ADJUSTMENT_STATES } from "./_parts/results";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.bills_adjustments") };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function BillChangesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!canSeeRoute("bills_adjustments", roleCan(ctx.role))) notFound();
  const params = await searchParams;
  const state = ADJUSTMENT_STATES.find((s) => s === first(params.state));
  const source = ADJUSTMENT_SOURCES.find((s) => s === first(params.source));
  const page = Math.max(1, Math.min(10_000, Number.parseInt(first(params.page) ?? "1", 10) || 1));
  const result = await listAdjustments.call(getServerRuntime(), ctx, { state, source, page });
  if (!result.ok) throw new Error(`adjustments.list: ${result.error.code}`);
  const view = result.value;

  const [shell, t, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("adjustments"),
    getLocale(),
  ]);
  const displayLocale = locale as DisplayLocale;
  const monthOf = (period: string | null) =>
    period && isPeriod(period) ? periodLabel(period, displayLocale, "long") : null;

  const columns: DataTableColumn<AdjustmentListRow>[] = [
    {
      id: "customer",
      header: t("list.col.customer"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <Link href={`/customers/${row.customerId}`} className="underline">
            {row.customerName}
          </Link>
          <span className="font-numeric text-sm text-text-muted">
            {row.customerCode}
            {row.vcNumber ? ` · ${t("list.vc", { number: row.vcNumber })}` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "change",
      header: t("list.col.change"),
      align: "end",
      cell: (row) => (
        <span
          className={`font-numeric font-strong text-lg ${row.direction === "debit" ? "text-due" : "text-credit"}`}
          data-direction={row.direction}
        >
          {row.direction === "debit"
            ? t("list.more", { amount: rupees(row.amountPaise) })
            : t("list.less", { amount: rupees(row.amountPaise) })}
        </span>
      ),
    },
    {
      id: "why",
      header: t("list.col.why"),
      cell: (row) => (
        <span className="flex flex-col">
          <span>{t(`list.source.${row.source}`)}</span>
          {row.reason ? <span className="text-sm text-text-muted">{row.reason}</span> : null}
          {monthOf(row.period) ? (
            <span className="text-sm text-text-muted">
              {t("list.for_month", { month: monthOf(row.period) ?? "" })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "bill",
      header: t("list.col.bill"),
      cell: (row) =>
        row.state === "pending" ? (
          <StatusPill variant="pending" icon="pending" label={t("list.pill.pending")} />
        ) : row.state === "billed" && row.invoiceId ? (
          <Link href={`/bills/${row.invoiceId}`}>
            <StatusPill
              variant="success"
              icon="bill"
              label={t("list.pill.billed", { number: row.invoiceNumber ?? "" })}
            />
          </Link>
        ) : (
          <StatusPill variant="success" icon="success" label={t("list.pill.credit")} />
        ),
    },
    {
      id: "date",
      header: t("list.col.date"),
      cell: (row) => (
        <span className="flex flex-col">
          <span className="font-numeric">{istDate(row.createdAt, displayLocale)}</span>
          {row.createdByName ? (
            <span className="text-sm text-text-muted">
              {t("list.by", { name: row.createdByName })}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  const href = (nextPage: number) => {
    const query = new URLSearchParams();
    if (state) query.set("state", state);
    if (source) query.set("source", source);
    if (nextPage > 1) query.set("page", String(nextPage));
    const text = query.toString();
    return text ? `/bills/adjustments?${text}` : "/bills/adjustments";
  };
  const canCreate = roleCan(ctx.role)("adjustments.manage");

  return (
    <div className={`flex flex-col gap-6 ${canCreate ? PAGE_ACTION_CLEARANCE : ""}`}>
      <ShellPageHeader
        title={shell("routes.bills_adjustments")}
        description={t("list.description")}
        action={
          canCreate ? (
            <Button asChild size="lg" icon="add">
              <Link href="/bills/adjustments/new" data-action="new-bill-change">
                {t("list.new")}
              </Link>
            </Button>
          ) : undefined
        }
      />

      <form
        method="get"
        action="/bills/adjustments"
        aria-label={t("list.filters")}
        className="flex flex-wrap items-end gap-3"
      >
        <label htmlFor="adj-state" className="flex flex-col gap-1 text-base text-text">
          {t("list.state")}
          <Select id="adj-state" name="state" defaultValue={state ?? ""} className="w-auto">
            <option value="">{t("list.all_states")}</option>
            {ADJUSTMENT_STATES.map((value) => (
              <option key={value} value={value}>
                {t(`list.state_option.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="adj-source" className="flex flex-col gap-1 text-base text-text">
          {t("list.source_label")}
          <Select id="adj-source" name="source" defaultValue={source ?? ""} className="w-auto">
            <option value="">{t("list.all_sources")}</option>
            {ADJUSTMENT_SOURCES.map((value) => (
              <option key={value} value={value}>
                {t(`list.source.${value}`)}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("list.show")}
        </Button>
      </form>

      <Card className="flex flex-col gap-1 sm:max-w-sm">
        <span className="text-sm text-text-muted">{t("list.pending_total")}</span>
        <Amount
          paise={view.pendingDebitPaise}
          size="xl"
          tone="due"
          dueLabel={t("list.pill.pending")}
          data-testid="adjustments-pending"
        />
      </Card>

      <DataTable
        caption={t("list.label")}
        columns={columns}
        rows={view.rows}
        rowKey={(row) => row.id}
        empty={<EmptyState icon="edit" message={t("list.empty")} />}
      />

      {view.page > 1 || view.hasMore ? (
        <nav aria-label={t("list.page", { page: view.page })} className="flex items-center gap-2">
          {view.page > 1 ? (
            <Button asChild variant="quiet" icon="back">
              <Link href={href(view.page - 1)}>{t("list.previous")}</Link>
            </Button>
          ) : null}
          <span className="text-base text-text">{t("list.page", { page: view.page })}</span>
          {view.hasMore ? (
            <Button asChild variant="quiet" icon="next">
              <Link href={href(view.page + 1)}>{t("list.next")}</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

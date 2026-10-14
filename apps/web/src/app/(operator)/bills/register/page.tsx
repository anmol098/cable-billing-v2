/**
 * `/bills/register?month=&area=&paid=&page=` (T-047, PLAN §12.1 "Bill register"): every bill of a
 * month with what is paid and still due, filtered by area and by "Paid?". A plain GET form, so
 * filters work without JavaScript and a filtered list can be bookmarked. Totals cover every
 * matching bill, not only the page. A row opens the bill. Owner and Staff (`billing.preview`).
 */

import {
  BILL_PAY_STATES,
  type BillPayState,
  type BillRow,
  billingMonths,
  listBills,
} from "@cb/core";
import {
  addPeriods,
  comparePeriods,
  type DisplayLocale,
  type Period,
  periodOfInstant,
} from "@cb/domain";
import {
  Amount,
  Button,
  Card,
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
import {
  billHref,
  monthText,
  PAY_STATE_PILL,
  pickMonth,
  registerHref,
  type Translate,
} from "@/components/bills/format";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.bills_register") };
}

const FILTER_STATES: readonly BillPayState[] = BILL_PAY_STATES.filter((s) => s !== "no_charge");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function BillRegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("billing.preview")) notFound();
  const runtime = getServerRuntime();
  const params = await searchParams;
  const current = periodOfInstant(runtime.now());
  const base = await billingMonths.call(runtime, ctx, { from: current, to: current });
  if (!base.ok) throw new Error(`bills months: ${base.error.code}`);
  const firstPeriod = base.value.firstPeriod;
  const period = pickMonth(params.month, current, firstPeriod);
  const rawArea = first(params.area);
  const areaId = rawArea && UUID.test(rawArea) ? rawArea.toLowerCase() : undefined;
  const rawState = first(params.paid);
  const payState = FILTER_STATES.find((s) => s === rawState);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(first(params.page) ?? "1", 10) || 1));

  let result = await listBills.call(runtime, ctx, { period, areaId, payState, page });
  if (!result.ok && result.error.code === "NOT_FOUND" && areaId) {
    // An area that isn't this tenant's (or was mistyped): show the month without it.
    result = await listBills.call(runtime, ctx, { period, payState, page });
  }
  if (!result.ok) throw new Error(`bill register: ${result.error.code}`);
  const view = result.value;
  const activeArea = view.areas.some((a) => a.id === areaId) ? areaId : undefined;

  const [shell, tr, locale] = await Promise.all([
    getTranslations("shell"),
    getTranslations("bills"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const monthLabel = monthText(period, displayLocale);
  const pages = Math.max(1, Math.ceil(view.totals.count / view.pageSize));

  const monthOptions: Period[] = [];
  for (let p = current; comparePeriods(p, firstPeriod) >= 0 && monthOptions.length < 120; ) {
    monthOptions.push(p);
    p = addPeriods(p, -1);
  }

  const columns: DataTableColumn<BillRow>[] = [
    {
      id: "customer",
      header: t("register.col.customer"),
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
      id: "number",
      header: t("register.col.number"),
      cell: (row) => <span className="font-numeric text-base text-text">{row.invoiceNumber}</span>,
    },
    {
      id: "amount",
      header: t("register.col.amount"),
      align: "end",
      cell: (row) => <Amount paise={row.chargesPaise} />,
    },
    {
      id: "paid",
      header: t("register.col.paid"),
      align: "end",
      cell: (row) => <Amount paise={row.paidPaise} weight="regular" />,
    },
    {
      id: "status",
      header: t("register.col.status"),
      cell: (row) => {
        const style = PAY_STATE_PILL[row.payState];
        return (
          <span className="flex flex-col items-start gap-1">
            <StatusPill
              variant={style.variant}
              icon={style.icon}
              label={t(`pay_state.${row.payState}`)}
            />
            {row.outstandingPaise > 0 && row.payState !== "void" ? (
              <Amount
                paise={row.outstandingPaise}
                tone="due"
                size="sm"
                dueLabel={t("register.due")}
              />
            ) : null}
          </span>
        );
      },
    },
  ];

  const filtersHref = (nextPage: number) =>
    registerHref(period, { areaId: activeArea, payState, page: nextPage });

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.bills_register")}
        description={tr("register_description")}
      />

      <form
        method="get"
        action="/bills/register"
        aria-label={tr("register.filters")}
        className="flex flex-wrap items-end gap-3"
      >
        <label htmlFor="bills-month" className="flex flex-col gap-1 text-base text-text">
          {tr("month.label")}
          <Select id="bills-month" name="month" defaultValue={period} className="w-auto">
            {monthOptions.map((p) => (
              <option key={p} value={p}>
                {monthText(p, displayLocale)}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="bills-area" className="flex flex-col gap-1 text-base text-text">
          {tr("register.area")}
          <Select id="bills-area" name="area" defaultValue={activeArea ?? ""} className="w-auto">
            <option value="">{tr("register.all_areas")}</option>
            {view.areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="bills-paid" className="flex flex-col gap-1 text-base text-text">
          {tr("register.pay_state")}
          <Select id="bills-paid" name="paid" defaultValue={payState ?? ""} className="w-auto">
            <option value="">{tr("register.all_pay_states")}</option>
            {FILTER_STATES.map((state) => (
              <option key={state} value={state}>
                {tr(`pay_state.${state}`)}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {tr("register.show")}
        </Button>
      </form>

      <section
        aria-label={tr("register.totals_label")}
        className="grid grid-cols-2 gap-4 sm:grid-cols-4"
      >
        <Card className="flex flex-col gap-1">
          <span className="text-sm text-text-muted">{tr("register.totals_label")}</span>
          <span className="font-strong text-xl text-text" data-testid="register-count">
            {tr("register.count", { count: view.totals.count })}
          </span>
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-sm text-text-muted">{tr("register.billed")}</span>
          <Amount paise={view.totals.chargesPaise} size="xl" data-testid="register-billed" />
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-sm text-text-muted">{tr("register.paid")}</span>
          <Amount paise={view.totals.paidPaise} size="xl" data-testid="register-paid" />
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-sm text-text-muted">{tr("register.due")}</span>
          <Amount
            paise={view.totals.outstandingPaise}
            tone="balance"
            size="xl"
            data-testid="register-due"
          />
        </Card>
      </section>

      <DataTable
        caption={tr("register.list_label", { month: monthLabel })}
        columns={columns}
        rows={view.rows}
        rowKey={(row) => row.id}
        rowHref={(row) => billHref(row.id)}
        linkAs={Link}
        empty={<EmptyState icon="bill" message={tr("register.empty", { month: monthLabel })} />}
      />

      {pages > 1 ? (
        <nav
          aria-label={tr("register.page", { page, pages })}
          className="flex flex-wrap items-center gap-2"
        >
          {page > 1 ? (
            <Button asChild variant="quiet" icon="back">
              <Link href={filtersHref(page - 1)}>{tr("register.previous")}</Link>
            </Button>
          ) : null}
          <span className="text-base text-text">{tr("register.page", { page, pages })}</span>
          {page < pages ? (
            <Button asChild variant="quiet" icon="next">
              <Link href={filtersHref(page + 1)}>{tr("register.next")}</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

/**
 * Shared pieces of the payment pages (T-048), server-rendered: the method and status pills (icon +
 * colour + word, PLAN §2.2), the payments table (register, "Payments to check", Undo payment list,
 * the customer's Payments tab; at most 5 columns, cards on phones, PLAN §12.2) and the register's
 * filter form (a plain GET form: works without JavaScript, the filters stay in the URL).
 */
import type { PaymentCollectorOption, PaymentListStatus, PaymentRegisterRow } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import {
  Amount,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Input,
  Select,
  StatusPill,
} from "@cb/ui";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ComponentProps, ReactNode } from "react";
import { paymentHref, type Translate, whenText } from "./format";

/** A row's link without viewport prefetching (a page of 50 rows would prefetch 50 payments). */
function RowLink(props: ComponentProps<typeof Link>) {
  return <Link prefetch={false} {...props} />;
}

export function MethodPill({ t, method }: { t: Translate; method: "cash" | "upi" }) {
  return <StatusPill variant={method} label={t(`method.${method}`)} />;
}

/** Cancelled (red) / To check (amber) / Checked or Counted (green). */
export function PaymentStatusPill({
  t,
  cancelled,
  reviewStatus,
}: {
  t: Translate;
  cancelled: boolean;
  reviewStatus: "none" | "needs_review" | "resolved";
}) {
  if (cancelled) return <StatusPill variant="danger" icon="undo" label={t("status.cancelled")} />;
  if (reviewStatus === "needs_review") {
    return <StatusPill variant="pending" icon="danger" label={t("status.to_check")} />;
  }
  if (reviewStatus === "resolved") {
    return <StatusPill variant="success" label={t("status.checked")} />;
  }
  return <StatusPill variant="success" label={t("status.counted")} />;
}

export type PaymentsTableColumn = "customer" | "amount" | "method" | "status" | "when" | "reason";

/**
 * The payments list. `columns` picks up to 5 (default: customer, amount, method, status, when);
 * "Payments to check" swaps status for the reason.
 */
export async function PaymentsTable({
  rows,
  caption,
  empty,
  columns = ["customer", "amount", "method", "status", "when"],
}: {
  rows: readonly PaymentRegisterRow[];
  caption: string;
  empty: ReactNode;
  columns?: readonly PaymentsTableColumn[];
}) {
  const [tr, locale] = await Promise.all([getTranslations("payments"), getLocale()]);
  const t = tr as unknown as Translate;
  const all: Record<PaymentsTableColumn, DataTableColumn<PaymentRegisterRow>> = {
    customer: {
      id: "customer",
      header: t("register.col_customer"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.customerName}</span>
          <span className="font-numeric font-regular text-sm text-text-muted">
            {row.receiptNumber ? t("register.receipt_no", { number: row.receiptNumber }) : null}
          </span>
        </span>
      ),
    },
    amount: {
      id: "amount",
      header: t("register.col_amount"),
      align: "end",
      cell: (row) => (
        <Amount
          paise={row.amountPaise}
          weight="strong"
          className={row.cancelled ? "line-through" : undefined}
        />
      ),
    },
    method: {
      id: "method",
      header: t("register.col_method"),
      cell: (row) => <MethodPill t={t} method={row.method} />,
    },
    status: {
      id: "status",
      header: t("register.col_status"),
      cell: (row) => (
        <PaymentStatusPill t={t} cancelled={row.cancelled} reviewStatus={row.reviewStatus} />
      ),
    },
    reason: {
      id: "reason",
      header: t("check.col_reason"),
      cell: (row) => (row.reviewReason ? t(`review_reason.${row.reviewReason}`) : null),
    },
    when: {
      id: "when",
      header: t("register.col_when"),
      cell: (row) => (
        <span className="flex flex-col">
          <span>{whenText(t, row.recordedAt, locale as DisplayLocale)}</span>
          {row.collectorName ? (
            <span className="text-sm text-text-muted">
              {t("register.by", { name: row.collectorName })}
            </span>
          ) : null}
        </span>
      ),
    },
  };
  return (
    <DataTable
      columns={columns.map((id) => all[id])}
      rows={rows}
      rowKey={(row) => row.id}
      caption={caption}
      rowHref={(row) => paymentHref(row.id)}
      linkAs={RowLink}
      empty={empty}
    />
  );
}

/** Previous / Page n / Next. */
export async function Pager({
  page,
  hasMore,
  href,
}: {
  page: number;
  hasMore: boolean;
  href: (page: number) => string;
}) {
  if (page <= 1 && !hasMore) return null;
  const t = await getTranslations("payments.register");
  return (
    <nav aria-label={t("pages")} className="flex items-center justify-between gap-3">
      {page > 1 ? (
        <Button asChild variant="secondary" icon="back">
          <Link href={href(page - 1)}>{t("previous")}</Link>
        </Button>
      ) : (
        <span />
      )}
      <span className="font-numeric text-text-muted">{t("page", { page })}</span>
      {hasMore ? (
        <Button asChild variant="secondary" icon="next">
          <Link href={href(page + 1)}>{t("next")}</Link>
        </Button>
      ) : (
        <span />
      )}
    </nav>
  );
}

export interface RegisterFilterValues {
  readonly from: string;
  readonly to: string;
  readonly collector: string;
  readonly method: string;
  readonly status: PaymentListStatus;
}

/** The register's filters: From / To (IST days), Taken by, Cash or UPI, Status → Show. */
export async function RegisterFilters({
  values,
  collectors,
  quick,
}: {
  values: RegisterFilterValues;
  collectors: readonly PaymentCollectorOption[];
  /** "Today" / "This month" links. */
  quick: { today: string; month: string };
}) {
  const t = await getTranslations("payments");
  const field = "flex min-w-0 flex-col gap-1 text-base text-text";
  return (
    <search>
      <form
        method="get"
        action="/payments"
        aria-label={t("register.filters_label")}
        className="flex flex-col gap-4"
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <label htmlFor="payments-from" className={field}>
            {t("register.from")}
            <Input id="payments-from" type="date" name="from" defaultValue={values.from} />
          </label>
          <label htmlFor="payments-to" className={field}>
            {t("register.to")}
            <Input id="payments-to" type="date" name="to" defaultValue={values.to} />
          </label>
          <label htmlFor="payments-collector" className={field}>
            {t("register.taken_by")}
            <Select id="payments-collector" name="collector" defaultValue={values.collector}>
              <option value="">{t("register.anyone")}</option>
              {collectors.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.active ? user.name : t("register.switched_off", { name: user.name })}
                </option>
              ))}
            </Select>
          </label>
          <label htmlFor="payments-method" className={field}>
            {t("register.method_label")}
            <Select id="payments-method" name="method" defaultValue={values.method}>
              <option value="">{t("register.method_any")}</option>
              <option value="cash">{t("method.cash")}</option>
              <option value="upi">{t("method.upi")}</option>
            </Select>
          </label>
          <label htmlFor="payments-status" className={`${field} col-span-2 lg:col-span-1`}>
            {t("register.status_label")}
            <Select id="payments-status" name="status" defaultValue={values.status}>
              <option value="all">{t("register.status_all")}</option>
              <option value="counted">{t("status.counted")}</option>
              <option value="cancelled">{t("status.cancelled")}</option>
              <option value="to_check">{t("status.to_check")}</option>
            </Select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" icon="search">
            {t("register.show")}
          </Button>
          <Button asChild variant="quiet" icon="today">
            <Link href={quick.today}>{t("register.today")}</Link>
          </Button>
          <Button asChild variant="quiet">
            <Link href={quick.month}>{t("register.this_month")}</Link>
          </Button>
        </div>
      </form>
    </search>
  );
}

export function NoPayments({ message }: { message: string }) {
  return <EmptyState icon="collect" message={message} />;
}

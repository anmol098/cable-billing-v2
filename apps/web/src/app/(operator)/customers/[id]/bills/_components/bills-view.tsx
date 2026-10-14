/**
 * The customer's Bills tab body (T-049; PLAN §12.1 Customers → Bills; FR-011): still due on the
 * bills first and biggest (PLAN §2.2), credit not used yet, an extra charge waiting for the next
 * bill, then every bill (month, bill no., amount, paid, status + still due), newest first. A row
 * opens T-047's bill page (lines, payments, Print bill). Same pay-state pills and words as the
 * bill register (`bills` namespace). Server-rendered; words come in through `t` / `tb`.
 */
import type { CustomerBillRow, CustomerBillsView } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import {
  Amount,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  EmptyState,
  StatusPill,
} from "@cb/ui";
import Link from "next/link";
import {
  billHref,
  monthText,
  PAY_STATE_PILL,
  rupees,
  type Translate,
} from "@/components/bills/format";

export function CustomerBills({
  view,
  t,
  tb,
  locale,
  historyHref,
}: {
  view: CustomerBillsView;
  t: Translate;
  tb: Translate;
  locale: DisplayLocale;
  historyHref: string;
}) {
  const columns: DataTableColumn<CustomerBillRow>[] = [
    {
      id: "month",
      header: t("bills.col_month"),
      primary: true,
      cell: (row) =>
        row.kind === "opening_balance" ? t("bills.old_dues") : monthText(row.period, locale),
    },
    {
      id: "number",
      header: t("bills.col_number"),
      cell: (row) => <span className="font-numeric text-base text-text">{row.invoiceNumber}</span>,
    },
    {
      id: "amount",
      header: t("bills.col_amount"),
      align: "end",
      cell: (row) => <Amount paise={row.chargesPaise} />,
    },
    {
      id: "paid",
      header: t("bills.col_paid"),
      align: "end",
      cell: (row) => <Amount paise={row.paidPaise} weight="regular" />,
    },
    {
      id: "status",
      header: t("bills.col_status"),
      cell: (row) => {
        const style = PAY_STATE_PILL[row.payState];
        return (
          <span className="flex flex-col items-start gap-1">
            <StatusPill
              variant={style.variant}
              icon={style.icon}
              label={tb(`pay_state.${row.payState}`)}
              data-testid="bill-pay-state"
            />
            {row.outstandingPaise > 0 && row.payState !== "void" ? (
              <Amount
                paise={row.outstandingPaise}
                tone="due"
                size="sm"
                dueLabel={t("bills.still_due")}
              />
            ) : null}
          </span>
        );
      },
    },
  ];

  const { totals } = view;
  return (
    <div className="flex flex-col gap-6" data-customer-bills={view.customerId}>
      <section aria-label={t("bills.title")} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="flex flex-col gap-1 p-4 sm:col-span-3 sm:p-6">
          <span className="text-base text-text-muted">{t("bills.total_due")}</span>
          <Amount
            paise={totals.outstandingPaise}
            tone="balance"
            size="amount"
            dueLabel={t("bills.still_due")}
            data-testid="bills-due"
          />
          <span className="text-sm text-text-muted">
            {t("bills.count", { count: totals.count })}
          </span>
          {view.creditPaise > 0 ? (
            <span className="flex flex-wrap items-baseline gap-2 text-base text-text">
              {t("bills.credit_unused")}
              <Amount paise={view.creditPaise} tone="credit" data-testid="bills-credit" />
            </span>
          ) : null}
          {view.pendingChargesPaise > 0 ? (
            <span className="text-base text-text" data-testid="bills-pending">
              {t("bills.pending", { amount: rupees(view.pendingChargesPaise) })}
            </span>
          ) : null}
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-sm text-text-muted">{t("bills.total_billed")}</span>
          <Amount paise={totals.chargesPaise} size="xl" data-testid="bills-billed" />
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-sm text-text-muted">{t("bills.total_paid")}</span>
          <Amount paise={totals.paidPaise} size="xl" data-testid="bills-paid" />
        </Card>
        <div className="flex items-center">
          <Button asChild variant="secondary" icon="audit">
            <Link href={historyHref}>{t("bills.see_history")}</Link>
          </Button>
        </div>
      </section>

      <DataTable
        caption={t("bills.caption")}
        columns={columns}
        rows={view.rows}
        rowKey={(row) => row.id}
        rowHref={(row) => billHref(row.id)}
        linkAs={Link}
        empty={<EmptyState icon="bill" message={t("bills.empty")} />}
      />
    </div>
  );
}

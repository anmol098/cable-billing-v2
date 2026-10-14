/**
 * Pieces of the bill run report (T-081): the run's summary (status, how it was made, when), the
 * customers it looked at with the result and why, and the totals. Server-renderable; words come in
 * through the `reports` translator `t` and T-047's `bills` translator `bt` (run states, problem
 * reasons, tries: one vocabulary), amounts as paise. Machine reason codes are never shown.
 */
import type { BillingRunReport, BillingRunReportRow, BillingRunReportRun } from "@cb/core";
import type { BillingRunItemOutcome } from "@cb/db";
import type { DisplayLocale } from "@cb/domain";
import {
  Amount,
  Card,
  DataTable,
  type DataTableColumn,
  EmptyState,
  type IconName,
  StatusPill,
  type StatusPillVariant,
} from "@cb/ui";
import Link from "next/link";
import {
  billHref,
  istDateTime,
  monthText,
  problemReasonKey,
  RUN_STATE_PILL,
  rupees,
} from "@/components/bills/format";
import type { Translate } from "@/components/reports/format";
import type { TotalItem } from "@/components/reports/parts";

/** Icon + colour + word per result: problems red, nothing to bill amber, bills green. */
export const OUTCOME_PILL: Record<
  BillingRunItemOutcome,
  { variant: StatusPillVariant; icon: IconName }
> = {
  created: { variant: "success", icon: "bill" },
  already_exists: { variant: "success", icon: "success" },
  skipped: { variant: "pending", icon: "pause" },
  failed: { variant: "danger", icon: "danger" },
};

export function OutcomePill({ outcome, t }: { outcome: BillingRunItemOutcome; t: Translate }) {
  const style = OUTCOME_PILL[outcome];
  return (
    <StatusPill
      variant={style.variant}
      icon={style.icon}
      label={t(`billing_runs.outcome.${outcome}`)}
    />
  );
}

/** Why a customer got this result, in plain words. */
export function whyText(row: BillingRunReportRow, t: Translate, bt: Translate): string {
  switch (row.outcome) {
    case "created":
      return t("billing_runs.why.created");
    case "already_exists":
      return t("billing_runs.why.already_exists");
    case "skipped":
      return row.reason === "nothing_to_bill"
        ? t("billing_runs.why.nothing_to_bill")
        : t("billing_runs.why.skipped");
    case "failed":
      return bt(`problems.reason.${problemReasonKey(row.reason ?? "")}`);
  }
}

/** The run: its state, how it was made, when it started and finished. */
export function RunSummary({
  run,
  t,
  bt,
  locale,
}: {
  run: BillingRunReportRun;
  t: Translate;
  bt: Translate;
  locale: DisplayLocale;
}) {
  const style = RUN_STATE_PILL[run.status];
  const trigger =
    run.trigger === "manual"
      ? t("billing_runs.trigger.manual", { name: run.startedByName ?? "" })
      : t(`billing_runs.trigger.${run.trigger}`);
  const month = monthText(run.period, locale);
  return (
    <Card className="flex flex-col gap-2" data-testid="run-summary">
      <StatusPill
        variant={style.variant}
        icon={style.icon}
        label={bt(`run_status.${run.status}`)}
      />
      <p className="text-base text-text">{bt(`status.${statusKey(run.status)}`, { month })}</p>
      <p className="text-sm text-text-muted">
        {[
          trigger,
          run.startedAt
            ? t("billing_runs.started", { when: istDateTime(run.startedAt, locale) })
            : null,
          run.finishedAt
            ? bt("status.finished_at", { when: istDateTime(run.finishedAt, locale) })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </Card>
  );
}

/** `bills.status.<key>` sentence for a run state. */
function statusKey(status: BillingRunReportRun["status"]): string {
  return status === "pending" || status === "running" ? "in_progress" : status;
}

/** The customers the run looked at; a row opens the bill (or the customer when there is none). */
export function RunItemsTable({
  rows,
  t,
  bt,
}: {
  rows: readonly BillingRunReportRow[];
  t: Translate;
  bt: Translate;
}) {
  const columns: DataTableColumn<BillingRunReportRow>[] = [
    {
      id: "customer",
      header: t("billing_runs.col.customer"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.customerName}</span>
          <span className="font-numeric text-sm font-regular text-text-muted">
            {row.customerCode}
            {row.areaName ? ` · ${row.areaName}` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "outcome",
      header: t("billing_runs.col.outcome"),
      cell: (row) => <OutcomePill outcome={row.outcome} t={t} />,
    },
    {
      id: "bill",
      header: t("billing_runs.col.bill"),
      align: "end",
      cell: (row) =>
        row.chargesPaise !== null && row.invoiceNumber ? (
          <span className="flex flex-col items-end">
            <Amount paise={row.chargesPaise} />
            <span className="font-numeric text-sm text-text-muted">
              {t("billing_runs.bill_no", { number: row.invoiceNumber })}
            </span>
          </span>
        ) : (
          <span className="text-sm text-text-muted">—</span>
        ),
    },
    {
      id: "why",
      header: t("billing_runs.col.why"),
      cell: (row) => (
        <span className="flex flex-col">
          <span className={`text-base ${row.outcome === "failed" ? "text-danger" : "text-text"}`}>
            {whyText(row, t, bt)}
          </span>
          {row.outcome === "failed" ? (
            <span className="text-sm text-text-muted">
              {bt("problems.tries", { count: row.attempts })}
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption={t("billing_runs.caption")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.itemId}
      rowHref={(row) => (row.invoiceId ? billHref(row.invoiceId) : `/customers/${row.customerId}`)}
      linkAs={Link}
      empty={<EmptyState icon="bill" message={t("billing_runs.empty")} />}
    />
  );
}

/** The totals row: customers checked, new bills (and their total), nothing to bill, problems. */
export function runTotalItems(totals: BillingRunReport["totals"], t: Translate): TotalItem[] {
  return [
    {
      id: "customers",
      label: t("billing_runs.totals.customers"),
      value: t("customers", { count: totals.customers }),
      note:
        totals.byOutcome.already_exists > 0
          ? `${t("billing_runs.totals.already")}: ${totals.byOutcome.already_exists}`
          : undefined,
    },
    {
      id: "created",
      label: t("billing_runs.totals.created"),
      value: <span className="font-numeric">{totals.byOutcome.created}</span>,
      note: t("billing_runs.totals.created_note", { amount: rupees(totals.createdChargesPaise) }),
    },
    {
      id: "skipped",
      label: t("billing_runs.totals.skipped"),
      value: <span className="font-numeric">{totals.byOutcome.skipped}</span>,
    },
    {
      id: "failed",
      label: t("billing_runs.totals.failed"),
      value: (
        <span className={`font-numeric ${totals.byOutcome.failed > 0 ? "text-danger" : ""}`}>
          {totals.byOutcome.failed}
        </span>
      ),
    },
  ];
}

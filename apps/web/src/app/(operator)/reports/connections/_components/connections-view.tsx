/**
 * Pieces of the connection status report (T-081): the list of connections on a day with their
 * status (since when), plan and monthly rent, and the totals. Server-renderable; words come in
 * through the `reports` translator `t` and T-034's `connections` translator `ct` (one vocabulary:
 * Active / Stopped / Removed, Own amount), amounts as paise.
 */
import type { ConnectionReportRow, ConnectionsReport } from "@cb/core";
import type { AssignmentStatus } from "@cb/db";
import { type DisplayLocale, formatBusinessDate } from "@cb/domain";
import {
  Amount,
  DataTable,
  type DataTableColumn,
  EmptyState,
  type IconName,
  StatusPill,
  type StatusPillVariant,
} from "@cb/ui";
import Link from "next/link";
import type { Translate } from "@/components/reports/format";
import type { TotalItem } from "@/components/reports/parts";

/** Icon + colour per connection status (the icons of T-034's Stop / Remove actions). */
export const CONNECTION_STATUS_PILL: Record<
  AssignmentStatus,
  { variant: StatusPillVariant; icon: IconName }
> = {
  active: { variant: "success", icon: "success" },
  suspended: { variant: "pending", icon: "pause" },
  disconnected: { variant: "danger", icon: "disconnect" },
};

export function ConnectionStatusPill({ status, ct }: { status: AssignmentStatus; ct: Translate }) {
  const style = CONNECTION_STATUS_PILL[status];
  return <StatusPill variant={style.variant} icon={style.icon} label={ct(`status.${status}`)} />;
}

export function connectionsHref(customerId: string): string {
  return `/customers/${customerId}/connections`;
}

/** Connections by customer; a row opens the customer's Connections tab. */
export function ConnectionsTable({
  rows,
  t,
  ct,
  locale,
}: {
  rows: readonly ConnectionReportRow[];
  t: Translate;
  ct: Translate;
  locale: DisplayLocale;
}) {
  const columns: DataTableColumn<ConnectionReportRow>[] = [
    {
      id: "customer",
      header: t("connections.col.customer"),
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
      id: "vc",
      header: t("connections.col.vc"),
      cell: (row) => <span className="font-numeric text-base text-text">{row.vcNumber}</span>,
    },
    {
      id: "status",
      header: t("connections.col.status"),
      cell: (row) => (
        <span className="flex flex-col items-end gap-1 sm:items-start">
          <ConnectionStatusPill status={row.status} ct={ct} />
          <span className="text-sm text-text-muted">
            {t("connections.since", { date: formatBusinessDate(row.since, locale) })}
          </span>
        </span>
      ),
    },
    {
      id: "rent",
      header: t("connections.col.rent"),
      align: "end",
      cell: (row) => (
        <span className="flex flex-col items-end">
          <Amount paise={row.rentPaise} weight={row.status === "active" ? "strong" : "regular"} />
          <span className="text-sm text-text-muted">{row.planName ?? ct("tab.own_amount")}</span>
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption={t("connections.caption")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.assignmentId}
      rowHref={(row) => connectionsHref(row.customerId)}
      linkAs={Link}
      empty={<EmptyState icon="customer" message={t("connections.empty")} />}
    />
  );
}

/** The totals row: active, their monthly rent, stopped, removed (and all). */
export function connectionTotalItems(
  totals: ConnectionsReport["totals"],
  t: Translate,
  ct: Translate,
): TotalItem[] {
  return [
    {
      id: "active",
      label: ct("status.active"),
      value: t("connections.count", { count: totals.byStatus.active }),
      note: t("connections.active_customers", { count: totals.activeCustomers }),
    },
    {
      id: "rent",
      label: t("connections.rent_total"),
      value: <Amount paise={totals.activeRentPaise} size="xl" />,
    },
    {
      id: "suspended",
      label: ct("status.suspended"),
      value: t("connections.count", { count: totals.byStatus.suspended }),
    },
    {
      id: "disconnected",
      label: ct("status.disconnected"),
      value: t("connections.count", { count: totals.byStatus.disconnected }),
      note: `${t("connections.all")}: ${t("connections.count", { count: totals.connections })}`,
    },
  ];
}

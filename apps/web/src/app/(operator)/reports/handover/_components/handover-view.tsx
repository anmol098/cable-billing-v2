/**
 * Pieces of the cash handover report (T-081): one row per lineman's day with cash expected, cash
 * handed over, the difference and the lineman's reason, the status and what happened; and the
 * totals. Server-renderable (no hooks: "What happened" is a native `<details>`). Words come in
 * through the `reports` translator `t` and T-062's `linemen` translator `lt` (one vocabulary for
 * handover words), amounts as paise. UPI is shown apart: it is never part of the cash.
 */
import type { HandoverReport, HandoverReportRow } from "@cb/core";
import { type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Amount, DataTable, type DataTableColumn, EmptyState, Icon } from "@cb/ui";
import Link from "next/link";
import { HandoverStatus } from "@/app/(operator)/linemen/_components/day-parts";
import { differenceText, linemanHref, whenText } from "@/app/(operator)/linemen/_lib/format";
import { rupees } from "@/components/bills/format";
import type { Translate } from "@/components/reports/format";
import type { TotalItem } from "@/components/reports/parts";

/** One step of what happened, in words. */
function historyText(event: HandoverReportRow["history"][number], lt: Translate): string {
  if (event.type === "submitted") {
    return lt("review.history.submitted", {
      name: event.actorName,
      handed: `₹${rupees(event.cashHandedOverPaise ?? 0)}`,
      expected: `₹${rupees(event.cashExpectedPaise ?? 0)}`,
    });
  }
  return lt(`review.history.${event.type}`, { name: event.actorName });
}

/** "What happened (4 steps)": every submission and decision, oldest first, with notes. */
export function HandoverHistory({
  row,
  t,
  lt,
  locale,
}: {
  row: HandoverReportRow;
  t: Translate;
  lt: Translate;
  locale: DisplayLocale;
}) {
  if (row.history.length === 0) return null;
  return (
    // Above the row's stretched link, so it opens without leaving the page.
    <details className="relative z-10 text-start" data-testid="handover-history">
      <summary className="cursor-pointer text-sm text-text underline underline-offset-4">
        {t("handover.history_summary", { count: row.history.length })}
      </summary>
      <ol className="mt-2 flex flex-col gap-2">
        {row.history.map((event) => (
          <li key={event.id} className="flex flex-col text-sm text-text">
            <span>
              {t("handover.history_at", {
                when: whenText(lt, event.at, row.businessDate, locale),
                text: historyText(event, lt),
              })}
            </span>
            {event.type === "submitted" && event.discrepancyPaise !== null ? (
              <span className={event.discrepancyPaise === 0 ? "text-success" : "text-danger"}>
                {differenceText(lt, event.discrepancyPaise)}
                {event.discrepancyReason ? ` · ${lt(`reason.${event.discrepancyReason}`)}` : ""}
              </span>
            ) : null}
            {event.note ? (
              <span className="text-text-muted">
                {event.type === "submitted"
                  ? t("handover.lineman_note", { note: event.note })
                  : t("handover.office_note", { note: event.note })}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The lineman's days; a row opens T-062's review screen for that day. */
export function HandoverTable({
  rows,
  t,
  lt,
  locale,
}: {
  rows: readonly HandoverReportRow[];
  t: Translate;
  lt: Translate;
  locale: DisplayLocale;
}) {
  const columns: DataTableColumn<HandoverReportRow>[] = [
    {
      id: "day",
      header: t("handover.col.day"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.linemanName}</span>
          <span className="text-sm font-regular text-text-muted">
            {formatBusinessDate(row.businessDate, locale)}
            {row.linemanActive ? "" : ` · ${lt("card.switched_off")}`}
          </span>
        </span>
      ),
    },
    {
      id: "expected",
      header: (
        <span className="inline-flex items-center gap-1 text-cash">
          <Icon name="cash" aria-hidden />
          <span>{t("handover.col.expected")}</span>
        </span>
      ),
      align: "end",
      cell: (row) => (
        <span className="flex flex-col items-end">
          <Amount paise={row.cashExpectedPaise} weight="strong" />
          {row.upiTotalPaise > 0 ? (
            <span className="text-sm text-upi">
              {t("handover.upi_apart", { amount: rupees(row.upiTotalPaise) })}
            </span>
          ) : null}
          {row.changedSinceHandover && row.handover ? (
            <span className="text-sm text-pending" data-warning="">
              {t("handover.expected_then", {
                amount: rupees(row.handover.cashExpectedPaise),
              })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "handed",
      header: t("handover.col.handed"),
      align: "end",
      cell: (row) =>
        row.handover ? (
          <Amount paise={row.handover.cashHandedOverPaise} />
        ) : (
          <span className="text-sm text-text-muted">{t("handover.not_handed")}</span>
        ),
    },
    {
      id: "difference",
      header: t("handover.col.difference"),
      align: "end",
      cell: (row) =>
        row.handover ? (
          <span className="flex flex-col items-end">
            <span
              className={`text-base ${row.handover.discrepancyPaise === 0 ? "text-success" : "text-danger"}`}
            >
              {differenceText(lt, row.handover.discrepancyPaise)}
            </span>
            {row.handover.discrepancyReason ? (
              <span className="text-sm text-text-muted">
                {`${lt("reason.label")}: ${lt(`reason.${row.handover.discrepancyReason}`)}`}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-sm text-text-muted">—</span>
        ),
    },
    {
      id: "status",
      header: t("handover.col.status"),
      cell: (row) => (
        <span className="flex flex-col items-end gap-2 sm:items-start">
          <HandoverStatus t={lt} status={row.status} />
          <HandoverHistory row={row} t={t} lt={lt} locale={locale} />
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption={t("handover.caption")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.sessionId}
      rowHref={(row) => linemanHref(row.linemanId, row.businessDate)}
      linkAs={Link}
      empty={<EmptyState icon="handover" message={t("handover.empty")} />}
    />
  );
}

/** "₹50 short · ₹20 extra", only the parts that are there; "Cash matches" when none is. */
export function differenceTotal(
  totals: Pick<HandoverReport["totals"], "shortPaise" | "extraPaise">,
  t: Translate,
): string {
  const parts = [
    totals.shortPaise > 0 ? t("handover.totals.short", { amount: rupees(totals.shortPaise) }) : "",
    totals.extraPaise > 0 ? t("handover.totals.extra", { amount: rupees(totals.extraPaise) }) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : t("handover.totals.matches");
}

/** The totals row: cash expected (UPI apart), handed over, the differences, not handed over. */
export function handoverTotalItems(totals: HandoverReport["totals"], t: Translate): TotalItem[] {
  const handedDays =
    totals.byStatus.submitted + totals.byStatus.accepted + totals.byStatus.returned;
  return [
    {
      id: "expected",
      label: t("handover.totals.expected"),
      value: <Amount paise={totals.cashExpectedPaise} size="xl" />,
      note: t("handover.totals.expected_note", { amount: rupees(totals.upiTotalPaise) }),
    },
    {
      id: "handed",
      label: t("handover.totals.handed"),
      value: <Amount paise={totals.cashHandedOverPaise} size="xl" />,
      note: t("handover.totals.handed_note", { count: handedDays }),
    },
    {
      id: "difference",
      label: t("handover.totals.difference"),
      value: (
        <span className={totals.differenceCount > 0 ? "text-danger" : "text-success"}>
          {differenceTotal(totals, t)}
        </span>
      ),
      note: t("handover.totals.difference_note", { count: totals.differenceCount }),
    },
    {
      id: "not_handed",
      label: t("handover.totals.not_handed"),
      value: <Amount paise={totals.notHandedOverPaise} size="xl" />,
      note: t("handover.totals.not_handed_note", { count: totals.byStatus.open }),
    },
  ];
}

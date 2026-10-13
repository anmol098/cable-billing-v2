/**
 * `/linemen/[id]?date=` (T-062, PLAN §8.7 "Office: Accept or Return; unsynced payments shown as a
 * warning on the review screen"): one lineman's day: cash expected (cash payments the office has,
 * not cancelled; UPI apart), the latest handover and its difference, phone warnings, Accept /
 * Send back while it waits for the office, the day's payments and what happened. An unknown id,
 * another tenant's id or a user who isn't a lineman → 404.
 */
import { getLinemanDay } from "@cb/core";
import { type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Amount, Button, Card, DataTable, type DataTableColumn, Icon, StatusPill } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { HandoverStatus, PhoneNotes } from "../_components/day-parts";
import {
  differenceText,
  linemenHref,
  pickDay,
  rupees,
  type Translate,
  whenText,
} from "../_lib/format";
import { acceptHandoverAction, returnHandoverAction } from "./actions";
import { ReviewActions } from "./review-actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.lineman_day") };
}

type DayPayment = {
  paymentId: string;
  customerCode: string;
  customerName: string;
  amountPaise: number;
  method: "cash" | "upi";
  recordedAt: Date;
  receiptNumber: string;
  reversed: boolean;
  needsReview: boolean;
};

export default async function LinemanDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("handover.review")) notFound();
  const runtime = getServerRuntime();
  const now = runtime.now();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const date = pickDay(query.date, now);
  const today = pickDay(undefined, now);
  const result = await getLinemanDay.call(runtime, ctx, { linemanId: id, businessDate: date });
  // A malformed id is VALIDATION; another tenant's or unknown id is NOT_FOUND: both are 404.
  if (!result.ok && (result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION")) {
    notFound();
  }
  if (!result.ok) throw new Error(`lineman day: ${result.error.code}`);
  const view = result.value;
  const [tr, common, localeRaw] = await Promise.all([
    getTranslations("linemen"),
    getTranslations("common"),
    getLocale(),
  ]);
  const t = tr as unknown as Translate;
  const locale = localeRaw as DisplayLocale;
  const { day } = view;
  const handover = day.handover;
  const lastDecision = [...view.history].reverse().find((e) => e.type !== "submitted");
  const when = (at: Date) => whenText(t, at, date, locale);

  const columns: DataTableColumn<DayPayment>[] = [
    {
      id: "customer",
      header: tr("review.column.customer"),
      primary: true,
      cell: (p) => `${p.customerName} (${p.customerCode})`,
    },
    { id: "time", header: tr("review.column.time"), cell: (p) => when(p.recordedAt) },
    {
      id: "method",
      header: tr("review.column.method"),
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-2">
          <StatusPill variant={p.method} label={common(p.method)} />
          {p.reversed ? <StatusPill variant="danger" label={tr("review.cancelled")} /> : null}
          {p.needsReview ? (
            <StatusPill variant="pending" icon="danger" label={tr("review.to_check")} />
          ) : null}
        </span>
      ),
    },
    {
      id: "amount",
      header: tr("review.column.amount"),
      align: "end",
      cell: (p) => (
        <Amount
          paise={p.amountPaise}
          className={p.reversed ? "text-text-muted line-through" : undefined}
        />
      ),
    },
    { id: "receipt", header: tr("review.column.receipt"), cell: (p) => p.receiptNumber },
  ];

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={view.name}
        description={
          date === today
            ? tr("day.today_date", { date: formatBusinessDate(date, locale) })
            : formatBusinessDate(date, locale)
        }
        back={
          <Button asChild variant="quiet" icon="back">
            <Link href={linemenHref(date, today)}>{tr("review.back")}</Link>
          </Button>
        }
      />
      {view.active ? null : <p className="text-base text-text-muted">{tr("card.switched_off")}</p>}

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-label={tr("totals.label")}>
        <Card className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="flex items-center gap-2 text-base text-cash">
            <Icon name="cash" />
            {tr("review.expected")}
          </span>
          <Amount paise={day.cashExpectedPaise} size="amount" data-testid="cash-expected" />
          <span className="text-sm text-text-muted">{tr("review.expected_note")}</span>
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-base text-upi">
            <Icon name="upi" />
            {tr("review.upi")}
          </span>
          <Amount paise={day.upiTotalPaise} size="2xl" data-testid="upi-total" />
          <span className="text-sm text-text-muted">{tr("totals.upi_note")}</span>
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-base text-text">{tr("review.payments")}</span>
          <span className="font-numeric font-strong text-2xl text-text">{day.paymentCount}</span>
        </Card>
      </section>

      <Card asChild className="flex flex-col gap-4">
        <section aria-labelledby="handover-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="handover-title" className="font-strong text-xl text-text">
              {tr("review.handover_title")}
            </h2>
            <HandoverStatus t={t} status={day.status} />
          </div>
          {handover ? (
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-text-muted">{tr("review.handed_over")}</dt>
                <dd>
                  <Amount paise={handover.cashHandedOverPaise} size="2xl" data-testid="handed" />
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-text-muted">{tr("review.expected_then")}</dt>
                <dd>
                  <Amount paise={handover.cashExpectedPaise} size="2xl" />
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-text-muted">{tr("review.difference")}</dt>
                <dd
                  className={
                    handover.discrepancyPaise === 0
                      ? "font-strong text-xl text-success"
                      : "font-strong text-xl text-danger"
                  }
                  data-testid="difference"
                >
                  {differenceText(t, handover.discrepancyPaise)}
                </dd>
              </div>
              {handover.discrepancyReason ? (
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-text-muted">{tr("reason.label")}</dt>
                  <dd className="text-base text-text">
                    {tr(`reason.${handover.discrepancyReason}`)}
                  </dd>
                </div>
              ) : null}
              {handover.note ? (
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <dt className="text-sm text-text-muted">{tr("review.lineman_note")}</dt>
                  <dd className="text-base text-text">{handover.note}</dd>
                </div>
              ) : null}
              <div className="text-sm text-text-muted sm:col-span-3">
                {tr("review.handed_over_at", { when: when(handover.submittedAt) })}
              </div>
            </dl>
          ) : (
            <p className="text-base text-text">{tr("review.not_handed_over")}</p>
          )}

          <PhoneNotes
            t={t}
            locale={locale}
            date={date}
            status={day.status}
            phone={view.phone}
            changedSinceHandover={view.changedSinceHandover}
            cashExpectedPaise={day.cashExpectedPaise}
            handoverCashExpectedPaise={handover?.cashExpectedPaise ?? null}
          />

          {handover && lastDecision && day.status !== "submitted" && handover.reviewedAt ? (
            <div className="flex flex-col gap-1 text-base text-text">
              <p>
                {tr(
                  day.status === "accepted"
                    ? "review.reviewed_accepted"
                    : "review.reviewed_returned",
                  { name: lastDecision.actorName, when: when(handover.reviewedAt) },
                )}
              </p>
              {handover.reviewNote ? (
                <p>{tr("review.office_note", { note: handover.reviewNote })}</p>
              ) : null}
            </div>
          ) : null}

          {handover && day.status === "submitted" && day.sessionId ? (
            <ReviewActions
              sessionId={day.sessionId}
              submissionId={handover.submissionId}
              linemanName={view.name}
              handed={`₹${rupees(handover.cashHandedOverPaise)}`}
              expected={`₹${rupees(handover.cashExpectedPaise)}`}
              difference={differenceText(t, handover.discrepancyPaise)}
              accept={acceptHandoverAction}
              sendBack={returnHandoverAction}
            />
          ) : null}
        </section>
      </Card>

      <section aria-labelledby="payments-title" className="flex flex-col gap-3">
        <h2 id="payments-title" className="font-strong text-xl text-text">
          {tr("review.payments_title")}
        </h2>
        <DataTable
          columns={columns}
          rows={day.payments}
          rowKey={(p) => p.paymentId}
          caption={tr("review.payments_caption")}
          empty={<p className="text-base text-text-muted">{tr("review.no_payments")}</p>}
        />
      </section>

      {view.history.length > 0 ? (
        <section aria-labelledby="history-title" className="flex flex-col gap-3">
          <h2 id="history-title" className="font-strong text-xl text-text">
            {tr("review.history_title")}
          </h2>
          <ol className="flex flex-col gap-2">
            {view.history.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-1 border-b-hairline border-border pb-2"
              >
                <span className="text-sm text-text-muted">{when(event.at)}</span>
                <span className="text-base text-text">
                  {event.type === "submitted"
                    ? tr("review.history.submitted", {
                        name: event.actorName,
                        handed: `₹${rupees(event.cashHandedOverPaise ?? 0)}`,
                        expected: `₹${rupees(event.cashExpectedPaise ?? 0)}`,
                      })
                    : tr(`review.history.${event.type}`, { name: event.actorName })}
                </span>
                {event.note ? <span className="text-base text-text">{event.note}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

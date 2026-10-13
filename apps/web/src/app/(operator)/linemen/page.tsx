/**
 * `/linemen` (T-062, PLAN §12.1 "Linemen", §8.7, FR-022): one card per lineman for one IST day:
 * cash (what the office expects), UPI (kept apart, never handed over), number of payments,
 * handover status and difference, and phone warnings. Waiting handovers come first; a card opens
 * the review screen (`/linemen/[id]?date=`). Owner and Staff (`handover.review` to see the page;
 * the read service needs `dashboard.view`).
 */

import { getLinemenDay } from "@cb/core";
import { type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Amount, Button, Card, EmptyState, Icon, StatusPill } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { DayPicker, HandoverStatus, PhoneNotes } from "./_components/day-parts";
import { differenceText, linemanHref, pickDay, type Translate } from "./_lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.linemen") };
}

export default async function LinemenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  const can = roleCan(ctx.role);
  if (!can("handover.review")) notFound();
  const runtime = getServerRuntime();
  const now = runtime.now();
  const date = pickDay((await searchParams).date, now);
  const today = pickDay(undefined, now);
  const [result, shell, tr, common, locale] = await Promise.all([
    getLinemenDay.call(runtime, ctx, { businessDate: date }),
    getTranslations("shell"),
    getTranslations("linemen"),
    getTranslations("common"),
    getLocale(),
  ]);
  if (!result.ok) throw new Error(`linemen day: ${result.error.code}`);
  const view = result.value;
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const dateLabel = formatBusinessDate(date, displayLocale);

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader title={shell("routes.linemen")} description={tr("page_description")} />
      <DayPicker t={t} date={date} today={today} dateLabel={dateLabel} />

      <section aria-label={tr("totals.label")} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Card className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-base text-cash">
              <Icon name="cash" />
              {tr("totals.cash")}
            </span>
            <Amount paise={view.totals.cashExpectedPaise} size="2xl" data-testid="total-cash" />
          </Card>
          <Card className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-base text-upi">
              <Icon name="upi" />
              {tr("totals.upi")}
            </span>
            <Amount paise={view.totals.upiTotalPaise} size="2xl" data-testid="total-upi" />
          </Card>
          <Card className="col-span-2 flex flex-col justify-center gap-2 sm:col-span-1">
            {view.totals.waitingCount > 0 ? (
              <StatusPill
                variant="pending"
                icon="handover"
                label={tr("totals.waiting", { count: view.totals.waitingCount })}
              />
            ) : (
              <span className="text-base text-text-muted">{tr("totals.none_waiting")}</span>
            )}
            <span className="text-base text-text">
              {common("payment_count", { count: view.totals.paymentCount })}
            </span>
          </Card>
        </div>
        <p className="text-sm text-text-muted">{tr("totals.upi_note")}</p>
      </section>

      {view.linemen.length === 0 ? (
        <EmptyState
          icon="lineman"
          message={tr("empty")}
          {...(can("team.manage")
            ? {
                action: (
                  <Button asChild icon="add">
                    <Link href="/settings/team">{tr("add_linemen")}</Link>
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <ul aria-label={tr("card.list_label")} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {view.linemen.map((card) => (
            <li key={card.linemanId}>
              <Card asChild className="flex h-full flex-col gap-3 hover:bg-surface">
                <Link href={linemanHref(card.linemanId, date)} data-testid="lineman-card">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-strong text-lg text-text">
                      <Icon name="lineman" className="shrink-0" />
                      {card.name}
                    </span>
                    <HandoverStatus t={t} status={card.status} />
                  </div>
                  {card.active ? null : (
                    <span className="text-sm text-text-muted">{tr("card.switched_off")}</span>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="flex items-center gap-1 text-sm text-cash">
                        <Icon name="cash" />
                        {tr("totals.cash")}
                      </span>
                      <Amount paise={card.cashExpectedPaise} size="xl" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="flex items-center gap-1 text-sm text-upi">
                        <Icon name="upi" />
                        {tr("totals.upi")}
                      </span>
                      <Amount paise={card.upiTotalPaise} size="xl" />
                    </div>
                  </div>
                  <span className="text-base text-text">
                    {common("payment_count", { count: card.paymentCount })}
                  </span>
                  {card.handover ? (
                    <span
                      className={
                        card.handover.discrepancyPaise === 0
                          ? "text-base text-success"
                          : "text-base font-strong text-danger"
                      }
                    >
                      {differenceText(t, card.handover.discrepancyPaise)}
                    </span>
                  ) : null}
                  <PhoneNotes
                    t={t}
                    locale={displayLocale}
                    date={date}
                    status={card.status}
                    phone={card.phone}
                    changedSinceHandover={card.changedSinceHandover}
                    cashExpectedPaise={card.cashExpectedPaise}
                    handoverCashExpectedPaise={card.handover?.cashExpectedPaise ?? null}
                  />
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * `/bills` (T-047, PLAN §12.1 "Bills"): the month calendar with each month's run status and bill
 * total, the "Missed bill runs" card after a view-only period (D-25: made by hand only), and the
 * way into this month's preview and the bill register. Owner and Staff (`billing.preview`).
 */

import { billingMonths, missedRuns } from "@cb/core";
import { type DisplayLocale, periodOfInstant } from "@cb/domain";
import { Button, Card, Icon, PAGE_ACTION_CLEARANCE } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  monthText,
  pickYear,
  registerHref,
  runsHref,
  type Translate,
  yearPeriods,
} from "@/components/bills/format";
import { MissedRunsCard, MonthCalendar, PausedNotice } from "@/components/bills/parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.bills") };
}

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("billing.preview")) notFound();
  const runtime = getServerRuntime();
  const current = periodOfInstant(runtime.now());
  const year = pickYear((await searchParams).year, current);
  const [months, missed, shell, tr, locale] = await Promise.all([
    billingMonths.call(runtime, ctx, yearPeriods(year)),
    missedRuns.call(runtime, ctx, {}),
    getTranslations("shell"),
    getTranslations("bills"),
    getLocale(),
  ]);
  if (!months.ok) throw new Error(`bills months: ${months.error.code}`);
  if (!missed.ok) throw new Error(`missed runs: ${missed.error.code}`);
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const view = months.value;
  const thisMonth = monthText(view.currentPeriod, displayLocale);
  const firstYear = Number(view.firstPeriod.slice(0, 4));
  const currentYear = Number(view.currentPeriod.slice(0, 4));

  return (
    <div className={`flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}`}>
      <ShellPageHeader
        title={shell("routes.bills")}
        description={tr("page_description")}
        action={
          <Button asChild size="lg" icon="show">
            <Link href={runsHref(view.currentPeriod, { preview: true })}>
              {tr("this_month.preview")}
            </Link>
          </Button>
        }
      />
      {view.tenantMode === "read_only" ? (
        <PausedNotice t={t} isOwner={ctx.role === "owner"} />
      ) : null}
      <MissedRunsCard t={t} missed={missed.value} locale={displayLocale} />

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-strong text-lg text-text">
          <Icon name="today" />
          {tr("this_month.title", { month: thisMonth })}
        </span>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" icon="next">
            <Link href={runsHref(view.currentPeriod)}>
              {tr("this_month.open", { month: thisMonth })}
            </Link>
          </Button>
          <Button asChild variant="secondary" icon="bill">
            <Link href={registerHref(view.currentPeriod)}>{shell("routes.bills_register")}</Link>
          </Button>
        </div>
      </Card>

      <section aria-labelledby="calendar-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="calendar-title" className="font-strong text-xl text-text">
            {tr("year.label", { year })}
          </h2>
          <nav aria-label={tr("calendar.label")} className="flex gap-2">
            {year > firstYear ? (
              <Button asChild variant="quiet" icon="back">
                <Link href={`/bills?year=${year - 1}`}>{tr("year.previous")}</Link>
              </Button>
            ) : null}
            {year < currentYear ? (
              <Button asChild variant="quiet" icon="next">
                <Link href={`/bills?year=${year + 1}`}>{tr("year.next")}</Link>
              </Button>
            ) : null}
          </nav>
        </div>
        <MonthCalendar
          t={t}
          months={view.months}
          current={view.currentPeriod}
          first={view.firstPeriod}
          locale={displayLocale}
        />
      </section>
    </div>
  );
}

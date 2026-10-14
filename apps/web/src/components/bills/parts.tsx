/**
 * Server-rendered pieces of the Bills pages (T-047): run status pill, month navigation, the
 * view-only notice, the missed-runs card, the run summary, the preview summary, the problem list
 * and the month calendar. No client JavaScript; words come in through `t` (`bills` namespace).
 * Every status is icon + colour + word (PLAN §2.2 rule 3), amounts are the biggest thing.
 */
import type { BillingMonth, BillingPreview, BillingRunView, MissedRun } from "@cb/core";
import { comparePeriods, type DisplayLocale, dateParts, monthName, type Period } from "@cb/domain";
import { Amount, Button, Card, Icon, StatusPill } from "@cb/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  isRunInProgress,
  istDateTime,
  monthNeighbours,
  monthText,
  problemReasonKey,
  RUN_STATE_PILL,
  type RunState,
  runsHref,
  type Translate,
} from "./format";

export function RunStatePill({
  t,
  state,
  className,
}: {
  t: Translate;
  state: RunState;
  className?: string;
}) {
  const style = RUN_STATE_PILL[state];
  return (
    <StatusPill
      variant={style.variant}
      icon={style.icon}
      label={t(`run_status.${state}`)}
      className={className}
    />
  );
}

/** ← previous month · month · next month →, inside [first, current]. */
export function MonthNav({
  t,
  period,
  current,
  first,
  locale,
  href,
}: {
  t: Translate;
  period: Period;
  current: Period;
  first: Period;
  locale: DisplayLocale;
  href: (period: Period) => string;
}) {
  const { previous, next } = monthNeighbours(period, current, first);
  return (
    <nav aria-label={t("month.label")} className="flex flex-wrap items-center gap-2">
      {previous ? (
        <Button asChild variant="quiet" icon="back">
          <Link href={href(previous)}>{t("month.previous")}</Link>
        </Button>
      ) : null}
      <span className="flex items-center gap-2 px-2 font-strong text-lg text-text">
        <Icon name="today" />
        {monthText(period, locale)}
      </span>
      {next ? (
        <Button asChild variant="quiet" icon="next">
          <Link href={href(next)}>{t("month.next")}</Link>
        </Button>
      ) : null}
    </nav>
  );
}

/** Billing is paused while the tenant is read-only (D-13). */
export function PausedNotice({ t, isOwner }: { t: Translate; isOwner: boolean }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-lg border-hairline border-danger p-4 text-base text-danger"
    >
      <Icon name="danger" className="mt-1 shrink-0" />
      {isOwner ? t("paused.owner") : t("paused.staff")}
    </p>
  );
}

/** Months whose run was skipped while read-only (D-25): checked and made by hand only. */
export function MissedRunsCard({
  t,
  missed,
  locale,
}: {
  t: Translate;
  missed: readonly MissedRun[];
  locale: DisplayLocale;
}) {
  if (missed.length === 0) return null;
  return (
    <Card asChild className="flex flex-col gap-3 border-danger">
      <section aria-labelledby="missed-runs-title" data-testid="missed-runs">
        <h2
          id="missed-runs-title"
          className="flex items-center gap-2 font-strong text-lg text-danger"
        >
          <Icon name="danger" />
          {t("missed.title")}
        </h2>
        <p className="text-base text-text">{t("missed.text")}</p>
        <ul className="flex flex-wrap gap-2">
          {missed.map((run) => (
            <li key={run.runId}>
              <Button asChild variant="secondary" icon="show">
                <Link href={runsHref(run.period, { preview: true })}>
                  {t("missed.open", { month: monthText(run.period, locale) })}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function Count({ value, testId }: { value: number; testId?: string }) {
  return (
    <span className="font-numeric font-strong text-xl text-text" data-testid={testId}>
      {value}
    </span>
  );
}

/** What the month's run did (or that there is none yet). */
export function RunSummary({
  t,
  run,
  period,
  locale,
}: {
  t: Translate;
  run: BillingRunView | null;
  period: Period;
  locale: DisplayLocale;
}) {
  const state: RunState = run?.status ?? "none";
  const month = monthText(period, locale);
  const sentence = isRunInProgress(state)
    ? t("status.in_progress", { month })
    : t(`status.${state}`, { month });
  return (
    <Card asChild className="flex flex-col gap-4">
      <section aria-label={t("status.label", { month })} data-testid="run-summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-lg text-text">{sentence}</p>
          <RunStatePill t={t} state={state} />
        </div>
        {run && state !== "skipped" ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label={t("status.new_bills")}>
              <Count value={run.createdCount} testId="run-created" />
            </Stat>
            <Stat label={t("status.total")}>
              <Amount paise={run.totalChargesPaise} size="xl" data-testid="run-total" />
            </Stat>
            <Stat label={t("status.already")}>
              <Count value={run.alreadyExistsCount} />
            </Stat>
            <Stat label={t("status.nothing")}>
              <Count value={run.skippedCount} />
            </Stat>
            <Stat label={t("status.problems")}>
              <span
                className={
                  run.failedCount > 0
                    ? "font-numeric font-strong text-xl text-danger"
                    : "font-numeric font-strong text-xl text-text"
                }
                data-testid="run-failed"
              >
                {run.failedCount}
              </span>
            </Stat>
          </div>
        ) : null}
        {run?.finishedAt && !isRunInProgress(state) ? (
          <p className="text-sm text-text-muted">
            {t("status.finished_at", { when: istDateTime(run.finishedAt, locale) })}
          </p>
        ) : null}
      </section>
    </Card>
  );
}

/** One customer the run (or the preview) could not bill. */
export interface ProblemRowData {
  readonly key: string;
  readonly name: string;
  readonly code: string;
  readonly areaName: string | null;
  readonly reason: string;
  readonly attempts?: number;
  readonly customerId: string;
}

export function ProblemList({
  t,
  id,
  rows,
  total,
}: {
  t: Translate;
  /** Unique on the page (the run's list and the preview's list can both show). */
  id: string;
  rows: readonly ProblemRowData[];
  total: number;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3" data-testid={id}>
      <h2 id={`${id}-title`} className="flex items-center gap-2 font-strong text-lg text-danger">
        <Icon name="danger" />
        {t("problems.title")}
      </h2>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.key}>
            <Card className="flex flex-col gap-1">
              <Link
                href={`/customers/${row.customerId}`}
                className="flex flex-wrap items-baseline gap-2 font-strong text-lg text-text underline-offset-4 hover:underline"
              >
                <Icon name="customer" className="shrink-0 self-center" />
                {row.name}
                <span className="font-numeric text-base text-text-muted">{row.code}</span>
                {row.areaName ? (
                  <span className="text-base text-text-muted">· {row.areaName}</span>
                ) : null}
              </Link>
              <p className="text-base text-danger">
                {t(`problems.reason.${problemReasonKey(row.reason)}`)}
              </p>
              {row.attempts && row.attempts > 1 ? (
                <p className="text-sm text-text-muted">
                  {t("problems.tries", { count: row.attempts })}
                </p>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
      {total > rows.length ? (
        <p className="text-sm text-text-muted">
          {t("problems.more", { shown: rows.length, total })}
        </p>
      ) : null}
    </section>
  );
}

/** "128 customers will get a bill, total ₹57,600. 3 problems." (PLAN §8.2). */
export function PreviewSummary({
  t,
  preview,
  locale,
  hideHref,
}: {
  t: Translate;
  preview: BillingPreview;
  locale: DisplayLocale;
  hideHref: string;
}) {
  return (
    <Card asChild className="flex flex-col gap-4">
      <section aria-labelledby="preview-title" data-testid="preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="preview-title" className="flex items-center gap-2 font-strong text-lg text-text">
            <Icon name="show" />
            {t("preview.title", { month: monthText(preview.period, locale) })}
          </h2>
          <Button asChild variant="quiet" icon="close">
            <Link href={hideHref}>{t("preview.hide")}</Link>
          </Button>
        </div>
        <p className="text-sm text-text-muted">{t("preview.note")}</p>
        <p className="font-strong text-xl text-text" data-testid="preview-will-bill">
          {t("preview.will_bill", { count: preview.willBillCount })}
        </p>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-text-muted">{t("preview.total")}</span>
          <Amount paise={preview.totalChargesPaise} size="amount" data-testid="preview-total" />
        </div>
        <ul className="flex flex-col gap-1 text-base text-text">
          {preview.alreadyBilledCount > 0 ? (
            <li>{t("preview.already", { count: preview.alreadyBilledCount })}</li>
          ) : null}
          {preview.nothingToBillCount > 0 ? (
            <li>{t("preview.nothing", { count: preview.nothingToBillCount })}</li>
          ) : null}
          <li
            className={preview.problems.length > 0 ? "font-strong text-danger" : "text-success"}
            data-testid="preview-problem-count"
          >
            {t("preview.problems", { count: preview.problems.length })}
          </li>
        </ul>
      </section>
    </Card>
  );
}

/** The month's place relative to the tenant's first month and today. */
function monthPlace(period: Period, current: Period, first: Period): "later" | "before" | "open" {
  if (comparePeriods(period, current) > 0) return "later";
  if (comparePeriods(period, first) < 0) return "before";
  return "open";
}

/** Twelve months of a year: run status and bills per month; each open month links to its page. */
export function MonthCalendar({
  t,
  months,
  current,
  first,
  locale,
}: {
  t: Translate;
  months: readonly BillingMonth[];
  current: Period;
  first: Period;
  locale: DisplayLocale;
}) {
  return (
    <ul
      aria-label={t("calendar.label")}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      data-testid="month-calendar"
    >
      {months.map((month) => {
        const name = monthName(dateParts(month.period).month, locale, "long");
        const place = month.run ? "open" : monthPlace(month.period, current, first);
        const isCurrent = month.period === current;
        const body = (
          <>
            <span className="flex items-center justify-between gap-2 font-strong text-lg text-text">
              {name}
              {isCurrent ? <Icon name="today" className="shrink-0 text-text-muted" /> : null}
            </span>
            {place === "later" ? (
              <span className="text-sm text-text-muted">{t("calendar.later")}</span>
            ) : place === "before" ? (
              <span className="text-sm text-text-muted">{t("calendar.before_start")}</span>
            ) : (
              <>
                <RunStatePill t={t} state={month.run?.status ?? "none"} className="self-start" />
                <span className="text-sm text-text">
                  {t("calendar.bills", { count: month.billCount })}
                </span>
                {month.billCount > 0 ? <Amount paise={month.billTotalPaise} size="lg" /> : null}
              </>
            )}
          </>
        );
        return (
          <li key={month.period} data-period={month.period}>
            {place === "open" ? (
              <Card
                asChild
                className={
                  isCurrent
                    ? "flex h-full flex-col gap-2 border-strong border-accent hover:bg-surface"
                    : "flex h-full flex-col gap-2 hover:bg-surface"
                }
              >
                <Link
                  href={runsHref(month.period)}
                  aria-current={isCurrent ? "date" : undefined}
                  aria-label={`${monthText(month.period, locale)}: ${t(
                    `run_status.${month.run?.status ?? "none"}`,
                  )}`}
                >
                  {body}
                </Link>
              </Card>
            ) : (
              <Card className="flex h-full flex-col gap-2 bg-surface">{body}</Card>
            )}
          </li>
        );
      })}
    </ul>
  );
}

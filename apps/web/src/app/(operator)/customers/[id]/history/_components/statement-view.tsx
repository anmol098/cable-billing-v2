/**
 * The History tab's body (T-049; BRD §12 "what was charged, paid, adjusted and remains due?";
 * PLAN §2.2 numbers first): the time choice, the account in short (the balance at the end, biggest;
 * then before, bills, paid, cancelled, discounts), and every account line in posting order with
 * the balance after it. Server-rendered; words come in through `t` (`statements`) and `tb`
 * (`bills`).
 */
import type { CustomerStatementView } from "@cb/core";
import { type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Amount, Button, Card, EmptyState, Icon, Input, StatusPill } from "@cb/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { billHref, rupees, type Translate } from "@/components/bills/format";
import { describeLine, type LineTone, signedRupees } from "./lines";
import {
  historyHref,
  rangeText,
  STATEMENT_PRESETS,
  type StatementChoice,
  type StatementPreset,
} from "./range";

const PRESET_KEY: Record<StatementPreset, string> = {
  month: "range.month",
  "3m": "range.three_months",
  "12m": "range.year",
  all: "range.all",
};

const TONE_CLASS: Record<LineTone, string> = {
  cash: "text-cash",
  upi: "text-upi",
  danger: "text-danger",
  plain: "text-text-muted",
};

/** Preset links and a from/to form (a plain GET form: works without JavaScript). */
export function StatementRangePicker({
  customerId,
  choice,
  range,
  t,
}: {
  customerId: string;
  choice: StatementChoice;
  range: CustomerStatementView["range"];
  t: Translate;
}) {
  return (
    <section aria-label={t("range.label")} className="flex flex-col gap-3">
      <nav aria-label={t("range.label")} className="flex flex-wrap gap-2">
        {STATEMENT_PRESETS.map((preset) => {
          const current = choice.preset === preset;
          return (
            <Button
              key={preset}
              asChild
              variant={current ? "primary" : "secondary"}
              icon={current ? "success" : "today"}
            >
              <Link
                href={historyHref(customerId, { preset, from: undefined, to: undefined })}
                aria-current={current ? "true" : undefined}
                data-range={preset}
              >
                {t(PRESET_KEY[preset])}
              </Link>
            </Button>
          );
        })}
      </nav>
      <form
        method="get"
        action={`/customers/${customerId}/history`}
        className="flex flex-wrap items-end gap-3"
      >
        <label htmlFor="statement-from" className="flex flex-col gap-1 text-base text-text">
          {t("range.from")}
          <Input
            id="statement-from"
            name="from"
            type="date"
            defaultValue={range.from ?? ""}
            max={range.today}
            className="w-auto"
          />
        </label>
        <label htmlFor="statement-to" className="flex flex-col gap-1 text-base text-text">
          {t("range.to")}
          <Input
            id="statement-to"
            name="to"
            type="date"
            defaultValue={range.to}
            max={range.today}
            className="w-auto"
          />
        </label>
        <Button type="submit" variant="secondary" icon="search">
          {t("range.show")}
        </Button>
      </form>
      {choice.invalid ? (
        <p role="alert" className="flex items-center gap-2 text-base text-danger">
          <Icon name="danger" className="shrink-0" />
          {t("range.bad_dates")}
        </p>
      ) : null}
    </section>
  );
}

function SummaryRow({
  label,
  children,
  strong = false,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-4 border-b-hairline border-border py-2 last:border-b-0"
      data-testid={testId}
    >
      <dt className={strong ? "font-strong text-base text-text" : "text-base text-text-muted"}>
        {label}
      </dt>
      <dd className="m-0 text-end font-numeric text-lg">{children}</dd>
    </div>
  );
}

/** The balance at the end of the range (biggest), and how it came about. */
export function StatementSummary({
  view,
  t,
  locale,
}: {
  view: CustomerStatementView;
  t: Translate;
  locale: DisplayLocale;
}) {
  const { range, totals, now } = view;
  const closing = view.closingBalancePaise;
  const toDate = formatBusinessDate(range.to, locale);
  const headline = range.asOfNow
    ? closing > 0
      ? t("summary.due_now")
      : closing < 0
        ? t("summary.credit_now")
        : t("summary.nothing_due_now")
    : closing > 0
      ? t("summary.due_on", { date: toDate })
      : closing < 0
        ? t("summary.credit_on", { date: toDate })
        : t("summary.nothing_due_on", { date: toDate });
  const mismatch =
    now.ledgerPaise !== now.balancePaise || (range.asOfNow && closing !== now.balancePaise);
  const showOpening = range.from !== null || view.hiddenLines > 0;
  const openingDate =
    range.from === null
      ? formatBusinessDate(view.lines[0]?.date ?? range.to, locale)
      : formatBusinessDate(range.from, locale);

  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6" data-testid="statement-summary">
      <div className="flex flex-col gap-1">
        <p className="text-base text-text-muted" data-testid="statement-headline">
          {headline}
        </p>
        <Amount
          paise={closing}
          tone="balance"
          size="amount"
          dueLabel={t("summary.due")}
          creditLabel={t("summary.credit")}
          data-testid="statement-closing"
        />
        <p className="text-sm text-text-muted">{rangeText(range, t, locale)}</p>
      </div>
      {mismatch ? (
        <p role="alert" className="flex items-center gap-2 text-base text-danger">
          <Icon name="danger" className="shrink-0" />
          {t("summary.mismatch")}
        </p>
      ) : null}
      {range.asOfNow && now.creditPaise > 0 ? (
        <p className="text-base text-credit" data-testid="statement-credit-unused">
          {t("summary.credit_unused", {
            amount: rupees(now.creditPaise),
          })}
        </p>
      ) : null}
      <dl aria-label={t("summary.label")}>
        {showOpening ? (
          <SummaryRow label={t("summary.opening", { date: openingDate })} testId="sum-opening">
            <Amount
              paise={view.openingBalancePaise}
              tone="balance"
              size="lg"
              weight="regular"
              dueLabel={t("summary.due")}
              creditLabel={t("summary.credit")}
            />
          </SummaryRow>
        ) : null}
        <SummaryRow label={t("summary.billed")} testId="sum-billed">
          {signedRupees(totals.billedPaise)}
        </SummaryRow>
        <SummaryRow label={t("summary.paid")} testId="sum-paid">
          {signedRupees(-totals.paidPaise)}
        </SummaryRow>
        {totals.undonePaise > 0 ? (
          <SummaryRow label={t("summary.undone")} testId="sum-undone">
            {signedRupees(totals.undonePaise)}
          </SummaryRow>
        ) : null}
        {totals.discountPaise > 0 ? (
          <SummaryRow label={t("summary.discount")} testId="sum-discount">
            {signedRupees(-totals.discountPaise)}
          </SummaryRow>
        ) : null}
        <SummaryRow strong label={t("summary.closing", { date: toDate })} testId="sum-closing">
          <Amount
            paise={closing}
            tone="balance"
            size="lg"
            dueLabel={t("summary.due")}
            creditLabel={t("summary.credit")}
          />
        </SummaryRow>
      </dl>
    </Card>
  );
}

/** Every line of the range, oldest first, with the balance after it. */
export function StatementLines({
  view,
  t,
  tb,
  locale,
}: {
  view: CustomerStatementView;
  t: Translate;
  tb: Translate;
  locale: DisplayLocale;
}) {
  if (view.lines.length === 0) {
    return <EmptyState icon="audit" message={t("history.empty")} />;
  }
  const balance = (paise: number) => (
    <Amount
      paise={paise}
      tone="balance"
      size="sm"
      dueLabel={t("summary.due")}
      creditLabel={t("summary.credit")}
    />
  );
  return (
    <section aria-label={t("history.lines")} className="flex flex-col gap-3">
      {view.hiddenLines > 0 ? (
        <p className="text-sm text-text-muted" data-testid="statement-hidden">
          {t("history.hidden", { count: view.hiddenLines })}
        </p>
      ) : null}
      <ol className="flex flex-col rounded-md border-hairline border-border">
        {view.lines.map((line) => {
          const words = describeLine(line, t, tb, locale);
          return (
            <li
              key={line.id}
              data-testid="statement-line"
              data-type={line.type}
              className="flex flex-col gap-2 border-b-hairline border-border p-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
            >
              <div className="flex min-w-0 gap-3">
                <Icon name={words.icon} className={`mt-1 shrink-0 ${TONE_CLASS[words.tone]}`} />
                <div className="flex min-w-0 flex-col gap-1">
                  <p
                    className={`font-strong text-base ${words.tone === "danger" ? "text-danger" : "text-text"}`}
                  >
                    {words.title}
                  </p>
                  <p className="text-sm break-words text-text-muted">
                    {[formatBusinessDate(line.date, locale), ...words.details].join(" · ")}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {words.cancelledLater ? (
                      <StatusPill
                        variant="danger"
                        icon="undo"
                        label={t("line.cancelled_later")}
                        data-testid="cancelled-later"
                      />
                    ) : null}
                    {line.bill ? (
                      <Link
                        href={billHref(line.bill.id)}
                        prefetch={false}
                        className="text-sm text-text underline underline-offset-4"
                      >
                        {t("line.open_bill")}
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-baseline justify-between gap-4 sm:flex-col sm:items-end sm:gap-1">
                <span
                  className="font-numeric font-strong text-lg text-text"
                  data-testid="line-amount"
                >
                  {signedRupees(line.amountPaise)}
                </span>
                <span
                  className="flex items-baseline gap-2 text-sm text-text-muted"
                  data-testid="line-balance"
                >
                  {t("line.balance")} {balance(line.balanceAfterPaise)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

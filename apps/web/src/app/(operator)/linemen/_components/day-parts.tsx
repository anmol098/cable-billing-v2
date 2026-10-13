/**
 * Pieces shared by the Linemen page and the review screen (T-062): the handover status pill, the
 * phone warnings and the day picker. Server components; words come in through `t`.
 */
import type { CollectionSessionStatus } from "@cb/db";
import type { BusinessDate, DisplayLocale } from "@cb/domain";
import { addDays } from "@cb/domain";
import { Button, Icon, Input, StatusPill } from "@cb/ui";
import Link from "next/link";
import { linemenHref, rupees, STATUS_PILL, type Translate, whenText } from "../_lib/format";

export function HandoverStatus({ t, status }: { t: Translate; status: CollectionSessionStatus }) {
  const { variant, icon } = STATUS_PILL[status];
  return <StatusPill variant={variant} icon={icon} label={t(`status.${status}`)} />;
}

export interface PhoneNotesProps {
  t: Translate;
  locale: DisplayLocale;
  date: BusinessDate;
  status: CollectionSessionStatus;
  phone: {
    lastSeenAt: Date | null;
    lastContactAt: Date | null;
    phoneNotSeen: boolean;
    reportedUnsyncedCount: number;
    reportedUnsyncedCashPaise: number;
  };
  changedSinceHandover: boolean;
  cashExpectedPaise: number;
  handoverCashExpectedPaise: number | null;
}

/**
 * "Payments may still be on the phone" warnings (PLAN §8.7), honest wording: the phone's own
 * report at handover, the phone not being online since the day could have ended, and a total that
 * moved after the handover. An accepted day shows only the last one.
 */
export function PhoneNotes({
  t,
  locale,
  date,
  status,
  phone,
  changedSinceHandover,
  cashExpectedPaise,
  handoverCashExpectedPaise,
}: PhoneNotesProps) {
  const warnings: string[] = [];
  const open = status !== "accepted";
  if (open && phone.reportedUnsyncedCount > 0) {
    warnings.push(
      t("phone.unsynced", {
        count: phone.reportedUnsyncedCount,
        amount: rupees(phone.reportedUnsyncedCashPaise),
      }),
    );
  }
  if (open && phone.phoneNotSeen && phone.lastContactAt) {
    warnings.push(t("phone.not_seen", { when: whenText(t, phone.lastContactAt, date, locale) }));
  }
  if (changedSinceHandover && handoverCashExpectedPaise !== null) {
    warnings.push(
      t("changed", { before: rupees(handoverCashExpectedPaise), now: rupees(cashExpectedPaise) }),
    );
  }
  const info =
    phone.lastSeenAt === null
      ? t("phone.none")
      : t("phone.last_online", { when: whenText(t, phone.lastSeenAt, date, locale) });
  return (
    <div className="flex flex-col gap-2 text-sm">
      {warnings.map((text) => (
        <p key={text} className="flex items-start gap-2 text-pending" data-warning="">
          <Icon name="pending" className="mt-0.5 shrink-0" />
          <span>{text}</span>
        </p>
      ))}
      <p className="flex items-start gap-2 text-text-muted">
        <Icon name="call" className="mt-0.5 shrink-0" />
        <span>{info}</span>
      </p>
    </div>
  );
}

/** Day picker: a plain GET form (works without JavaScript) plus previous / today / next links. */
export function DayPicker({
  t,
  date,
  today,
  dateLabel,
}: {
  t: Translate;
  date: BusinessDate;
  today: BusinessDate;
  dateLabel: string;
}) {
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  return (
    <div className="flex flex-col gap-3">
      <p className="font-strong text-lg text-text">
        {date === today ? t("day.today_date", { date: dateLabel }) : dateLabel}
      </p>
      <form method="get" action="/linemen" className="flex flex-wrap items-end gap-3">
        <label htmlFor="linemen-day" className="flex flex-col gap-1 text-base text-text">
          {t("day.label")}
          <Input
            id="linemen-day"
            type="date"
            name="date"
            defaultValue={date}
            max={today}
            required
            className="w-auto"
          />
        </label>
        <Button type="submit" variant="secondary" icon="today">
          {t("day.show")}
        </Button>
      </form>
      <nav aria-label={t("day.label")} className="flex flex-wrap gap-2">
        <Button asChild variant="quiet" icon="back">
          <Link href={linemenHref(previous, today)}>{t("day.previous")}</Link>
        </Button>
        {date === today ? null : (
          <>
            <Button asChild variant="quiet" icon="today">
              <Link href={linemenHref(today, today)}>{t("day.today")}</Link>
            </Button>
            <Button asChild variant="quiet" icon="next">
              <Link href={linemenHref(next, today)}>{t("day.next")}</Link>
            </Button>
          </>
        )}
      </nav>
    </div>
  );
}

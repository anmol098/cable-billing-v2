/**
 * The Connections tab's content (PLAN §12.1 "Connections (VC): timeline, status changes"): each
 * current connection as a card (VC number, status, rent, since when, Stop / Start again / Remove)
 * with its history, then the removed ("old") connections with theirs. A removed VC that went to
 * another customer shows only here, on the old customer, with its old dates (RULE-07).
 */
import type { ConnectionDetail, ConnectionEventView, CustomerConnections } from "@cb/core";
import { businessDate, type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Card, formatRupees, Icon, type IconName, StatusPill } from "@cb/ui";
import { getTranslations } from "next-intl/server";
import { MutedPill } from "../../../_components/status-pills";
import type { StatusChangeResult } from "./form-state";
import { StatusActions, type StatusCommand } from "./status-actions";

const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

const EVENT_ICON: Record<ConnectionEventView["type"], IconName> = {
  activated: "add",
  suspended: "pause",
  reactivated: "resume",
  disconnected: "disconnect",
  plan_changed: "plan",
};

type T = Awaited<ReturnType<typeof getTranslations<"connections">>>;

function StatusWord({ connection, t }: { connection: ConnectionDetail; t: T }) {
  const label = t(`status.${connection.status}`);
  return connection.status === "active" ? (
    <StatusPill variant="success" label={label} />
  ) : (
    <MutedPill label={label} />
  );
}

function lastChangeOf(connection: ConnectionDetail): string {
  let latest = connection.startDate;
  for (const event of connection.events) {
    if (event.effectiveDate > latest) latest = event.effectiveDate;
  }
  return latest;
}

function Timeline({
  connection,
  locale,
  t,
}: {
  connection: ConnectionDetail;
  locale: DisplayLocale;
  t: T;
}) {
  const day = (value: string) => formatBusinessDate(businessDate(value), locale);
  const events = [...connection.events].reverse();
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-strong text-base text-text-muted">{t("tab.history")}</h3>
      <ol className="flex flex-col gap-2" data-timeline={connection.assignmentId}>
        {events.map((event) => (
          <li
            key={event.id}
            className="flex items-start gap-3 border-l-hairline border-border pl-3"
            data-event={event.type}
          >
            <Icon name={EVENT_ICON[event.type]} className="mt-1 shrink-0 text-text-muted" />
            <div className="flex flex-col gap-1">
              <span className="text-base">
                <span className="font-numeric">{day(event.effectiveDate)}</span>
                {" · "}
                <span className="font-strong">
                  {event.type === "plan_changed"
                    ? t("event.plan_changed", {
                        from: rupees(event.fromRentalPaise ?? 0),
                        to: rupees(event.toRentalPaise ?? 0),
                      })
                    : t(`event.${event.type}`)}
                </span>
              </span>
              {event.reason ? (
                <span className="text-sm text-text-muted">
                  {[event.reason.code ? t(`reason.${event.reason.code}`) : null, event.reason.note]
                    .filter(Boolean)
                    .join(": ")}
                </span>
              ) : null}
              {event.actorName ? (
                <span className="text-sm text-text-muted">
                  {t("event.by", { name: event.actorName })}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {connection.historyLimited ? (
        <p className="text-sm text-text-muted">{t("tab.history_limited")}</p>
      ) : null}
    </div>
  );
}

function ConnectionCard({
  connection,
  data,
  locale,
  t,
  duePaise,
  statusAction,
}: {
  connection: ConnectionDetail;
  data: CustomerConnections;
  locale: DisplayLocale;
  t: T;
  duePaise: number;
  statusAction: ((command: StatusCommand) => Promise<StatusChangeResult>) | null;
}) {
  const day = (value: string) => formatBusinessDate(businessDate(value), locale);
  const statusActions = connection.actions.filter(
    (a): a is "suspend" | "reactivate" | "disconnect" => a !== "change_plan",
  );
  const todayNote =
    connection.startDate > data.today
      ? t("tab.starts_on", { date: day(connection.startDate) })
      : connection.statusToday === "active" && connection.status !== "active"
        ? t("tab.on_until_tonight")
        : connection.statusToday === "suspended" && connection.status === "active"
          ? t("tab.starts_tomorrow")
          : null;

  return (
    <Card
      className="flex flex-col gap-4 p-4 sm:p-6"
      data-connection={connection.assignmentId}
      data-vc={connection.vcNumber}
      data-status={connection.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Icon name="plan" className="shrink-0 text-text-muted" />
          <div className="flex flex-col">
            <span className="text-sm text-text-muted">{t("tab.vc_label")}</span>
            <span className="font-numeric font-strong text-xl">{connection.vcNumber}</span>
          </div>
        </div>
        <StatusWord connection={connection} t={t} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-numeric text-lg">
          {t("tab.rent", { amount: rupees(connection.rentalPaise) })}
        </span>
        <span className="text-sm text-text-muted">
          {connection.planName ? t("tab.plan", { name: connection.planName }) : t("tab.own_amount")}
          {" · "}
          {connection.endDate
            ? t("tab.from_to", { start: day(connection.startDate), end: day(connection.endDate) })
            : t("tab.since", { date: day(connection.startDate) })}
        </span>
        {todayNote ? <span className="text-base text-pending">{todayNote}</span> : null}
      </div>
      {statusAction && statusActions.length > 0 ? (
        <StatusActions
          assignmentId={connection.assignmentId}
          vcNumber={connection.vcNumber}
          actions={statusActions}
          today={data.today}
          earliestChangeDate={connection.earliestChangeDate}
          startDate={connection.startDate}
          lastChangeDate={lastChangeOf(connection)}
          duePaise={duePaise}
          action={statusAction}
        />
      ) : null}
      <Timeline connection={connection} locale={locale} t={t} />
    </Card>
  );
}

export async function ConnectionsView({
  data,
  locale,
  duePaise,
  statusAction,
}: {
  data: CustomerConnections;
  locale: DisplayLocale;
  duePaise: number;
  /** `changeConnectionStatusAction` bound to the customer, or null when the role can't change. */
  statusAction: ((command: StatusCommand) => Promise<StatusChangeResult>) | null;
}) {
  const t = await getTranslations("connections");
  return (
    <div className="flex flex-col gap-6" data-connections={data.customerId}>
      {!data.customerActive ? (
        <p className="flex items-center gap-2 text-base text-text-muted">
          <Icon name="close" className="shrink-0" />
          {t("tab.closed_note")}
        </p>
      ) : null}
      <section className="flex flex-col gap-4" aria-labelledby="connections-current">
        <h2 id="connections-current" className="font-strong text-xl">
          {t("tab.current")}
        </h2>
        {data.current.length === 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-base">{t("tab.none")}</p>
            {data.customerActive ? (
              <p className="text-sm text-text-muted">{t("tab.none_hint")}</p>
            ) : null}
          </div>
        ) : (
          data.current.map((connection) => (
            <ConnectionCard
              key={connection.assignmentId}
              connection={connection}
              data={data}
              locale={locale}
              t={t}
              duePaise={duePaise}
              statusAction={statusAction}
            />
          ))
        )}
      </section>
      {data.past.length > 0 ? (
        <section className="flex flex-col gap-4" aria-labelledby="connections-past">
          <div className="flex flex-col gap-1">
            <h2 id="connections-past" className="font-strong text-xl">
              {t("tab.past")}
            </h2>
            <p className="text-sm text-text-muted">{t("tab.past_note")}</p>
          </div>
          {data.past.map((connection) => (
            <ConnectionCard
              key={connection.assignmentId}
              connection={connection}
              data={data}
              locale={locale}
              t={t}
              duePaise={duePaise}
              statusAction={null}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

/**
 * "Who changed what" body (T-035): the filter form (a GET form, works without JavaScript), the
 * events as plain sentences (newest first, IST time, an icon for the kind of thing), each with
 * "See what changed" (native `<details>`: before/after, hidden values say "Hidden"), and the
 * keyset pager ("Older changes" / "Back to the newest").
 *
 * A plain component with `useTranslations`, so it renders on the server and in unit tests alike.
 * The events are already redacted and masked by `listAuditEvents`.
 */
import {
  type AuditActorOption,
  type AuditChange,
  type AuditEventView,
  isAuditEntityType,
  KNOWN_AUDIT_ACTIONS,
} from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { Button, Card, EmptyState, Icon, type IconName, Input, Select } from "@cb/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AUDIT_PATH, type AuditFilterValues, auditHref, hasFilters } from "./filters";
import {
  type AuditTranslate,
  actionLabel,
  auditSentence,
  auditTime,
  fieldLabel,
  shownValueText,
} from "./sentences";

/** The icon of each kind of thing (PLAN §2.2 rule 3: icon + words). */
const ENTITY_ICON: Readonly<Record<string, IconName>> = {
  customer: "customer",
  vc_assignment: "plan",
  plan: "plan",
  adjustment: "edit",
  payment: "cash",
  receipt: "bill",
  receipt_link: "share",
  collection_session: "handover",
  billing_run: "bill",
  user: "team",
  device: "device",
  area: "area",
  operator: "business",
  subscription: "subscription",
};

/** Entity kinds offered in the "What" filter, in this order. */
const WHAT_OPTIONS = [
  "customer",
  "vc_assignment",
  "plan",
  "adjustment",
  "payment",
  "receipt",
  "collection_session",
  "billing_run",
  "user",
  "device",
  "area",
  "operator",
  "subscription",
  "receipt_link",
] as const;

export interface AuditLogProps {
  readonly events: readonly AuditEventView[];
  readonly actors: readonly AuditActorOption[];
  readonly values: AuditFilterValues;
  readonly nextCursor: string | null;
  /** True when this is not the first page. */
  readonly paged: boolean;
  readonly badDates: boolean;
  /** Today and the 1st of this month (IST), for the quick links. */
  readonly today: string;
  readonly monthStart: string;
}

export function AuditLog(props: AuditLogProps) {
  const t = useTranslations("audit") as unknown as AuditTranslate;
  const locale = useLocale() as DisplayLocale;
  const { events, values } = props;
  return (
    <div className="flex flex-col gap-6">
      <AuditFilters {...props} t={t} />
      {props.badDates ? (
        <p role="alert" className="flex items-center gap-2 text-base text-danger">
          <Icon name="danger" className="shrink-0" />
          {t("filters.bad_dates")}
        </p>
      ) : null}
      {events.length === 0 ? (
        <EmptyState
          icon="audit"
          message={t(hasFilters(values) ? "list.empty_filtered" : "list.empty")}
        />
      ) : (
        <ol aria-label={t("list.caption")} className="flex flex-col gap-3">
          {events.map((event) => (
            <AuditEventRow key={event.id} event={event} t={t} locale={locale} />
          ))}
        </ol>
      )}
      <AuditPager {...props} t={t} />
    </div>
  );
}

function AuditEventRow({
  event,
  t,
  locale,
}: {
  event: AuditEventView;
  t: AuditTranslate;
  locale: DisplayLocale;
}) {
  const kind = isAuditEntityType(event.entityType) ? event.entityType : "other";
  return (
    <li data-testid="audit-event" data-action={event.action}>
      <Card className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <Icon name={ENTITY_ICON[kind] ?? "audit"} className="mt-1 shrink-0 text-text-muted" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-lg text-text [overflow-wrap:anywhere]">
              {auditSentence(t, event, locale)}
            </p>
            <p className="text-base text-text-muted">
              <time dateTime={event.at.toISOString()}>{auditTime(t, event.at, locale)}</time>
              {" · "}
              {t(`entity.${kind}`)}
            </p>
          </div>
        </div>
        <AuditChanges changes={event.changes} t={t} locale={locale} />
      </Card>
    </li>
  );
}

function AuditChanges({
  changes,
  t,
  locale,
}: {
  changes: readonly AuditChange[];
  t: AuditTranslate;
  locale: DisplayLocale;
}) {
  if (changes.length === 0) {
    return <p className="text-base text-text-muted">{t("changes.none")}</p>;
  }
  return (
    <details className="group">
      <summary className="flex min-h-touch-min cursor-pointer items-center gap-2 text-base text-accent">
        <Icon name="next" className="shrink-0 transition-transform group-open:rotate-90" />
        {t("changes.show")}
      </summary>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-base">
          <caption className="sr-only">{t("changes.caption")}</caption>
          <thead>
            <tr className="border-border border-b-hairline text-start text-text-muted">
              <th scope="col" className="py-2 pe-3 text-start font-regular">
                {t("changes.field")}
              </th>
              <th scope="col" className="py-2 pe-3 text-start font-regular">
                {t("changes.before")}
              </th>
              <th scope="col" className="py-2 text-start font-regular">
                {t("changes.after")}
              </th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => (
              <tr key={change.field} className="border-border border-b-hairline align-top">
                <th scope="row" className="py-2 pe-3 text-start font-regular text-text-muted">
                  {fieldLabel(t, change.field)}
                </th>
                <ChangeCell value={change.before} t={t} locale={locale} />
                <ChangeCell value={change.after} t={t} locale={locale} last />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ChangeCell({
  value,
  t,
  locale,
  last = false,
}: {
  value: AuditChange["before"];
  t: AuditTranslate;
  locale: DisplayLocale;
  last?: boolean;
}) {
  const text = shownValueText(t, value, locale);
  const hidden = value?.kind === "hidden";
  return (
    <td
      className={`py-2 ${last ? "" : "pe-3"} [overflow-wrap:anywhere] ${hidden ? "text-text-muted" : "text-text"}`}
    >
      {hidden ? (
        <span className="inline-flex items-center gap-1" data-hidden="true">
          <Icon name="hide" className="shrink-0" />
          {text}
        </span>
      ) : (
        <span className={value?.kind === "paise" ? "font-numeric" : undefined}>{text}</span>
      )}
    </td>
  );
}

function AuditFilters({
  values,
  actors,
  today,
  monthStart,
  t,
}: AuditLogProps & { t: AuditTranslate }) {
  const field = "flex min-w-0 flex-col gap-1 text-base text-text";
  return (
    <search>
      <form
        method="get"
        action={AUDIT_PATH}
        aria-label={t("filters.label")}
        className="flex flex-col gap-4"
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <label htmlFor="audit-from" className={field}>
            {t("filters.from")}
            <Input id="audit-from" type="date" name="from" defaultValue={values.from} />
          </label>
          <label htmlFor="audit-to" className={field}>
            {t("filters.to")}
            <Input id="audit-to" type="date" name="to" defaultValue={values.to} />
          </label>
          <label htmlFor="audit-who" className={field}>
            {t("filters.who")}
            <Select id="audit-who" name="who" defaultValue={values.who}>
              <option value="">{t("filters.who_anyone")}</option>
              {actors.map((person) => {
                const role = t(`role.${person.role}`);
                const name = t("who.person", { name: person.name, role });
                return (
                  <option key={person.id} value={person.id}>
                    {person.active ? name : t("filters.switched_off", { name })}
                  </option>
                );
              })}
              <option value="app">{t("filters.who_app")}</option>
            </Select>
          </label>
          <label htmlFor="audit-what" className={field}>
            {t("filters.what")}
            <Select id="audit-what" name="what" defaultValue={values.what}>
              <option value="">{t("filters.what_any")}</option>
              {WHAT_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`entity.${kind}`)}
                </option>
              ))}
            </Select>
          </label>
          <label htmlFor="audit-change" className={`${field} col-span-2 lg:col-span-1`}>
            {t("filters.change")}
            <Select id="audit-change" name="change" defaultValue={values.change}>
              <option value="">{t("filters.change_any")}</option>
              {KNOWN_AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {actionLabel(t, action)}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" icon="search">
            {t("filters.show")}
          </Button>
          <Button asChild variant="quiet" icon="today">
            <Link href={auditHref({ from: today, to: today })}>{t("filters.today")}</Link>
          </Button>
          <Button asChild variant="quiet">
            <Link href={auditHref({ from: monthStart, to: today })}>{t("filters.this_month")}</Link>
          </Button>
          {hasFilters(values) ? (
            <Button asChild variant="quiet" icon="close">
              <Link href={AUDIT_PATH}>{t("filters.clear")}</Link>
            </Button>
          ) : null}
        </div>
      </form>
    </search>
  );
}

function AuditPager({ values, nextCursor, paged, t }: AuditLogProps & { t: AuditTranslate }) {
  if (!nextCursor && !paged) return null;
  return (
    <nav aria-label={t("list.page_label")} className="flex flex-wrap items-center gap-3">
      {paged ? (
        <Button asChild variant="quiet" icon="back">
          <Link href={auditHref(values)}>{t("list.newest")}</Link>
        </Button>
      ) : null}
      {nextCursor ? (
        <Button asChild variant="secondary" icon="next">
          <Link href={auditHref(values, nextCursor)} rel="next">
            {t("list.older")}
          </Link>
        </Button>
      ) : null}
    </nav>
  );
}

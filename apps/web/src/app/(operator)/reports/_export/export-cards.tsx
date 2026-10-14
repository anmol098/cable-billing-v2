/**
 * The "Download data" page's cards (T-082): one per export, each with an icon, a title, one line
 * of help, the few choices that kind needs (days or months, as on its page) and a Download button.
 * Plain GET forms to `/api/exports/<kind>`, so they work without JavaScript; the browser saves the
 * file. Server-renderable; words come in as a translator (`t` over all namespaces).
 */
import type { ExportKind } from "@cb/core";
import {
  addDays,
  type BusinessDate,
  type DisplayLocale,
  type Period,
  periodOfInstant,
} from "@cb/domain";
import { Button, Card, Icon, type IconName, Input, Select } from "@cb/ui";
import type { ReactNode } from "react";
import { monthText } from "@/components/bills/format";
import { monthStart } from "@/components/payments/format";
import { monthOptions } from "@/components/reports/format";
import type { Words } from "./columns";
import { exportHref } from "./params";

/** The cards, in the order an owner looks for them: lists first, then reports. */
export const EXPORT_CARD_ORDER: readonly ExportKind[] = [
  "customers",
  "payments",
  "bills",
  "dues",
  "collections",
  "handover",
  "connections",
  "billing_runs",
];

export const EXPORT_ICONS: Readonly<Record<ExportKind, IconName>> = {
  customers: "customer",
  payments: "collect",
  bills: "bill",
  dues: "pending",
  collections: "today",
  handover: "handover",
  connections: "plan",
  billing_runs: "report",
};

interface Props {
  readonly t: Words;
  readonly today: BusinessDate;
  readonly now: Date;
  readonly locale: DisplayLocale;
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-base text-text">
      {label}
      {children}
    </label>
  );
}

function DayField(props: { id: string; name: string; label: string; value: string; max: string }) {
  return (
    <Field id={props.id} label={props.label}>
      <Input
        id={props.id}
        name={props.name}
        type="date"
        max={props.max}
        defaultValue={props.value}
        className="w-auto"
      />
    </Field>
  );
}

function MonthField(props: {
  id: string;
  name: string;
  label: string;
  value: Period;
  months: readonly Period[];
  locale: DisplayLocale;
}) {
  return (
    <Field id={props.id} label={props.label}>
      <Select id={props.id} name={props.name} defaultValue={props.value} className="w-auto">
        {props.months.map((p) => (
          <option key={p} value={p}>
            {monthText(p, props.locale)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** The choices of one kind (names = the page's query parameters). */
function Choices({ kind, t, today, now, locale }: Props & { kind: ExportKind }) {
  const id = (name: string) => `export-${kind}-${name}`;
  const current = periodOfInstant(now);
  const months = monthOptions(current);
  switch (kind) {
    case "customers":
      return (
        <Field id={id("status")} label={t("exports.filters.who")}>
          <Select id={id("status")} name="status" defaultValue="" className="w-auto">
            <option value="">{t("exports.filters.everyone")}</option>
            <option value="active">{t("customers.status.active")}</option>
            <option value="inactive">{t("customers.status.inactive")}</option>
          </Select>
        </Field>
      );
    case "payments":
      return (
        <>
          <DayField
            id={id("from")}
            name="from"
            label={t("exports.filters.from")}
            value={monthStart(today)}
            max={today}
          />
          <DayField
            id={id("to")}
            name="to"
            label={t("exports.filters.to")}
            value={today}
            max={today}
          />
        </>
      );
    case "bills":
      return (
        <>
          <MonthField
            id={id("from")}
            name="from"
            label={t("exports.filters.from_month")}
            value={months[2] ?? current}
            months={months}
            locale={locale}
          />
          <MonthField
            id={id("to")}
            name="to"
            label={t("exports.filters.to_month")}
            value={current}
            months={months}
            locale={locale}
          />
          <p className="w-full text-sm text-text-muted">{t("exports.filters.months_help")}</p>
        </>
      );
    case "dues":
      return (
        <DayField
          id={id("date")}
          name="date"
          label={t("exports.filters.as_of")}
          value={today}
          max={today}
        />
      );
    case "collections":
    case "handover":
      return (
        <>
          <DayField
            id={id("from")}
            name="from"
            label={t("exports.filters.from")}
            value={kind === "handover" ? addDays(today, -6) : today}
            max={today}
          />
          <DayField
            id={id("to")}
            name="to"
            label={t("exports.filters.to")}
            value={today}
            max={today}
          />
          <p className="w-full text-sm text-text-muted">{t("exports.filters.days_help")}</p>
        </>
      );
    case "connections":
      return (
        <DayField
          id={id("date")}
          name="date"
          label={t("exports.filters.day")}
          value={today}
          max={today}
        />
      );
    case "billing_runs":
      return (
        <MonthField
          id={id("month")}
          name="month"
          label={t("exports.filters.month")}
          value={current}
          months={months}
          locale={locale}
        />
      );
  }
}

export function ExportCards(props: Props) {
  const { t } = props;
  return (
    <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {EXPORT_CARD_ORDER.map((kind) => {
        const title = t(`exports.kind.${kind}.title`);
        return (
          <li key={kind}>
            <Card asChild>
              <section aria-labelledby={`export-${kind}-title`} className="flex flex-col gap-3">
                <h2
                  id={`export-${kind}-title`}
                  className="flex items-center gap-2 font-strong text-lg text-text"
                >
                  <Icon name={EXPORT_ICONS[kind]} />
                  {title}
                </h2>
                <p className="text-base text-text-muted">{t(`exports.kind.${kind}.help`)}</p>
                <form
                  method="get"
                  action={exportHref(kind)}
                  aria-label={t("exports.filters.label", { name: title })}
                  className="flex flex-wrap items-end gap-3"
                >
                  <Choices kind={kind} {...props} />
                  <Button type="submit" icon="export" data-testid={`export-${kind}`}>
                    {t("exports.download")}
                  </Button>
                </form>
              </section>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

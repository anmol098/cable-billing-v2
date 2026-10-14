/**
 * Words for "Who changed what" (T-035): one plain sentence per event ("Ramesh (Staff) changed the
 * phone of customer 1045"), the time in IST, and the before/after values of the change list.
 * Pure: the translator is passed in (next-intl's `t` for the `audit` namespace, or a test one).
 *
 * The service already chose what may be shown (secrets hidden, phones and emails masked, ids
 * dropped); this file only puts it into words. Every placeholder a sentence can use gets a value
 * (a dash or `other` when the event lacks it), so an old or odd event never breaks the page.
 */
import type { AuditActor, AuditEventView, AuditShownValue, AuditValue } from "@cb/core";
import {
  businessDateOf,
  type DisplayLocale,
  formatBusinessDate,
  formatINR,
  isBusinessDate,
  isPeriod,
  periodLabel,
} from "@cb/domain";

/** next-intl's translator for the `audit` namespace (or a test double with the same shape). */
export interface AuditTranslate {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

const DASH = "—";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `1,23,456` (no ₹: the sentence has it, glossary rule). */
export function rupeeDigits(paise: number): string {
  return formatINR(paise, { sign: "minus" }).replace("₹", "");
}

/** A field's word ("Mobile no."), or the field name in plain letters when there is none. */
export function fieldLabel(t: AuditTranslate, field: string): string {
  const key = `field.${field}`;
  if (t.has(key)) return t(key);
  const leaf = field.includes(".") ? (field.split(".").pop() ?? field) : field;
  if (t.has(`field.${leaf}`)) return t(`field.${leaf}`);
  return field.replace(/[._]+/g, " ").trim();
}

/** A sentence value as text in the reader's language. */
export function valueText(t: AuditTranslate, value: AuditValue, locale: DisplayLocale): string {
  switch (value.kind) {
    case "text":
    case "code":
      return value.value;
    case "paise":
      return rupeeDigits(value.value);
    case "count":
      return String(value.value);
    case "date":
      return isBusinessDate(value.value) ? formatBusinessDate(value.value, locale) : value.value;
    case "period":
      return isPeriod(value.value) ? periodLabel(value.value, locale) : value.value;
    case "fields":
      return value.value.map((field) => fieldLabel(t, field)).join(", ");
  }
}

function roleWord(t: AuditTranslate, role: string): string {
  return t.has(`role.${role}`) ? t(`role.${role}`) : role;
}

/** "Ramesh (Staff)", "Cable Billing support", or "The app" for jobs and the system. */
export function whoText(t: AuditTranslate, actor: AuditActor): string {
  if (actor.kind === "system") return t("who.app");
  if (actor.role === "platform_admin") return t("who.support");
  const role = roleWord(t, actor.role);
  return actor.name ? t("who.person", { name: actor.name, role }) : t("who.someone", { role });
}

/** The values every sentence may use, with safe stand-ins for what the event lacks. */
const DEFAULTS: Readonly<Record<string, string | number>> = {
  customer: DASH,
  amount: DASH,
  from: DASH,
  to: DASH,
  fields: DASH,
  date: DASH,
  count: 0,
  status: "other",
  method: "other",
  channel: "other",
  field: "other",
};

/** One plain sentence for an event. */
export function auditSentence(
  t: AuditTranslate,
  event: Pick<
    AuditEventView,
    "actor" | "action" | "known" | "entityType" | "knownEntityType" | "target" | "details"
  >,
  locale: DisplayLocale,
): string {
  const who = whoText(t, event.actor);
  const fallbackTarget = event.target ?? event.details.period ?? null;
  if (!event.known) {
    const entity = t(`entity.${event.knownEntityType ? event.entityType : "other"}`);
    const target = event.target ? valueText(t, event.target, locale) : "";
    return t("generic", { who, entity, target }).trim();
  }
  const values: Record<string, string | number> = {
    ...DEFAULTS,
    who,
    target: fallbackTarget ? valueText(t, fallbackTarget, locale) : t("unknown_target"),
  };
  for (const [name, value] of Object.entries(event.details)) {
    values[name] = value.kind === "count" ? value.value : valueText(t, value, locale);
  }
  return t(`sentence.${event.action}`, values);
}

/** The short name of an action for the filter ("Customer phone changed"). */
export function actionLabel(t: AuditTranslate, action: string): string {
  return t.has(`action.${action}`) ? t(`action.${action}`) : action;
}

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** `14 Oct 2026, 4:05 PM` in IST. */
export function auditTime(t: AuditTranslate, at: Date, locale: DisplayLocale): string {
  const parts = IST_CLOCK.formatToParts(at);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const pm = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().startsWith("p");
  return t("time", {
    date: formatBusinessDate(businessDateOf(at), locale),
    time: `${hour}:${minute}`,
    ampm: pm ? "pm" : "am",
  });
}

/** One before/after cell as text ("Hidden", "Not set", "₹500", "XXXXXX3210"). */
export function shownValueText(
  t: AuditTranslate,
  shown: AuditShownValue | null,
  locale: DisplayLocale,
): string {
  if (shown === null) return DASH;
  switch (shown.kind) {
    case "hidden":
      return t("changes.hidden");
    case "empty":
      return t("changes.empty");
    case "paise":
      return formatINR(shown.value);
    case "flag":
      return t(shown.value ? "changes.yes" : "changes.no");
    case "items":
      return t("changes.items", { count: shown.value });
    case "number":
      return String(shown.value);
    case "text":
      if (isBusinessDate(shown.value)) return formatBusinessDate(shown.value, locale);
      // An instant (`2026-10-14T10:35:00.000Z`) in IST.
      if (ISO_INSTANT.test(shown.value) && !Number.isNaN(Date.parse(shown.value))) {
        return auditTime(t, new Date(shown.value), locale);
      }
      return shown.value;
  }
}

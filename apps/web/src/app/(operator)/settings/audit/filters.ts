/**
 * The "Who changed what" filters in the URL (T-035): `?from=&to=` (IST days), `who=<user id>|app`,
 * `what=<kind>`, `change=<action>` and `after=<page cursor>`. Anything that isn't a valid value is
 * ignored (the page then shows more, never an error), and the service checks everything again.
 */
import { AUDIT_ENTITY_TYPES, type ListAuditEventsCommand } from "@cb/core";
import { type BusinessDate, isBusinessDate } from "@cb/domain";

export const AUDIT_PATH = "/settings/audit";

type Param = string | string[] | undefined;
export type AuditSearchParams = Readonly<Record<string, Param>>;

/** What the filter form shows (empty = not set). */
export interface AuditFilterValues {
  readonly from: string;
  readonly to: string;
  /** A user id, `app` (the app by itself), or empty. */
  readonly who: string;
  /** An entity type, or empty. */
  readonly what: string;
  /** An action, or empty. */
  readonly change: string;
}

export interface AuditQuery {
  readonly values: AuditFilterValues;
  /** The service input (without paging). */
  readonly input: Omit<Partial<ListAuditEventsCommand>, "limit">;
  /** The page cursor, when not on the first page. */
  readonly cursor: string | null;
  /** The days were backwards; both were dropped. */
  readonly badDates: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

function one(value: Param): string {
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

/** The filters and the service input from the page's search params. */
export function readAuditQuery(params: AuditSearchParams): AuditQuery {
  let from = isBusinessDate(one(params.from)) ? one(params.from) : "";
  let to = isBusinessDate(one(params.to)) ? one(params.to) : "";
  const badDates = from !== "" && to !== "" && from > to;
  if (badDates) {
    from = "";
    to = "";
  }
  const whoParam = one(params.who).toLowerCase();
  const who = whoParam === "app" || UUID.test(whoParam) ? whoParam : "";
  const what = (AUDIT_ENTITY_TYPES as readonly string[]).includes(one(params.what))
    ? one(params.what)
    : "";
  const change = ACTION.test(one(params.change)) ? one(params.change) : "";
  const cursor = CURSOR.test(one(params.after)) ? one(params.after) : null;

  const input: AuditQuery["input"] = {
    ...(from ? { from: from as BusinessDate } : {}),
    ...(to ? { to: to as BusinessDate } : {}),
    ...(who ? { actor: who === "app" ? "system" : who } : {}),
    ...(what ? { entityType: what } : {}),
    ...(change ? { action: change } : {}),
  };
  return { values: { from, to, who, what, change }, input, cursor, badDates };
}

/** `/settings/audit?…` with the filters (and a page cursor), leaving out empty values. */
export function auditHref(values: Partial<AuditFilterValues>, after?: string | null): string {
  const query = new URLSearchParams();
  for (const key of ["from", "to", "who", "what", "change"] as const) {
    const value = values[key];
    if (value) query.set(key, value);
  }
  if (after) query.set("after", after);
  const text = query.toString();
  return text ? `${AUDIT_PATH}?${text}` : AUDIT_PATH;
}

/** True when any filter is set (the empty message then suggests fewer choices). */
export function hasFilters(values: AuditFilterValues): boolean {
  return Object.values(values).some((value) => value !== "");
}

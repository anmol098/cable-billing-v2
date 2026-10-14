/**
 * The IST days of the day-based reports (T-081: collections and cash handover). Pure and
 * client-safe (no `@cb/core` runtime import), so it is unit-tested directly.
 */
import { addDays, type BusinessDate, isBusinessDate } from "@cb/domain";
import { firstParam, query } from "@/components/reports/format";

/** Days one report may cover: the same limit as `@cb/core`'s `REPORT_MAX_DAYS`. */
export const MAX_DAYS = 31;

type Param = string | string[] | undefined;

/** Days from `from` to `to`, both counted. */
export function dayCount(from: BusinessDate, to: BusinessDate): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/**
 * `?from=&to=` as IST days. Missing → `defaultDays` days up to today. Days the service would refuse
 * (after today, `to` before `from`, more than {@link MAX_DAYS}) → the default, with `bad: true` so
 * the page says what it shows instead.
 */
export function pickDays(
  rawFrom: Param,
  rawTo: Param,
  today: BusinessDate,
  defaultDays = 1,
): { from: BusinessDate; to: BusinessDate; bad: boolean } {
  const fallback = { from: addDays(today, 1 - defaultDays), to: today };
  const from = firstParam(rawFrom);
  const to = firstParam(rawTo);
  if (!from && !to) return { ...fallback, bad: false };
  const wantedTo = to && isBusinessDate(to) ? to : to ? undefined : today;
  const wantedFrom = from && isBusinessDate(from) ? from : from ? undefined : wantedTo;
  if (
    wantedFrom === undefined ||
    wantedTo === undefined ||
    wantedTo > today ||
    wantedFrom > wantedTo ||
    dayCount(wantedFrom, wantedTo) > MAX_DAYS
  ) {
    return { ...fallback, bad: true };
  }
  return { from: wantedFrom, to: wantedTo, bad: false };
}

/** The payment register of some days and person (a collections row opens it). */
export function paymentsReportHref(
  from: BusinessDate,
  to: BusinessDate,
  collectorId: string | null,
): string {
  return `/reports/payments${query({ from, to, collector: collectorId ?? undefined })}`;
}

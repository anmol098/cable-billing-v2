/**
 * Pure rules of the Home page read (T-083). No I/O, no clock.
 */
import type { SubscriptionStatus } from "@cb/db";
import { type BusinessDate, businessDateOf, dateParts } from "@cb/domain";
import { tenantModeOf } from "../authz/writable";
import type { SubscriptionSummary } from "./types";

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to` (IST calendar days; negative when `to` is before `from`). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const a = dateParts(from);
  const b = dateParts(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
}

/**
 * The subscription as Home shows it: the mode (read-only for `read_only`, `cancelled` or no row),
 * and the trial / grace end as IST days. Days left never go below 0 (a trial that ended but whose
 * row the daily job has not moved on yet "ends today").
 */
export function subscriptionSummary(
  row: { status: SubscriptionStatus; trialEndsAt: Date | null; graceEndsAt: Date | null } | null,
  today: BusinessDate,
): SubscriptionSummary {
  const status = row?.status ?? null;
  const trialEndsOn =
    status === "trialing" && row?.trialEndsAt ? businessDateOf(row.trialEndsAt) : null;
  const graceEndsOn =
    status === "grace" && row?.graceEndsAt ? businessDateOf(row.graceEndsAt) : null;
  return {
    status,
    mode: tenantModeOf(status),
    trialEndsOn,
    trialDaysLeft: trialEndsOn === null ? null : Math.max(0, daysBetween(today, trialEndsOn)),
    graceEndsOn,
  };
}

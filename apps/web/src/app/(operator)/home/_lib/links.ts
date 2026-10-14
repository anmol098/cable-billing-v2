/**
 * Where each Home tile and alert goes (T-083). Pure (no next-intl, no server code), so it is unit
 * tested directly. A link is `null` when the role may not open the page (the same capability as
 * the menu, `canSeeRoute`); the tile then shows its number without a link.
 *
 * Every target shows the same number the tile does: the payment register for today / this month
 * (by IST day, cash or UPI), the bill register for this month, the dues report, the month's bill
 * run, the Linemen page on the oldest day with a handover to check, "Payments to check", the
 * oldest missed month with its preview open, and the Owner's subscription page.
 */
import type { HomeDashboard } from "@cb/core";
import { registerHref, runsHref } from "@/components/bills/format";
import { withQuery } from "@/components/payments/format";
import { type CanFn, canSeeRoute, findRoute, type NavRouteId } from "@/lib/nav";

export const HOME_LINK_IDS = [
  "cash_today",
  "upi_today",
  "collected",
  "billed",
  "due",
  "run",
  "handovers",
  "payments_to_check",
  "missed",
  "subscription",
] as const;
export type HomeLinkId = (typeof HOME_LINK_IDS)[number];

type LinkInput = Pick<
  HomeDashboard,
  "today" | "period" | "latestRun" | "handoversWaiting" | "missedRuns"
>;

function pathOf(route: NavRouteId): string {
  const found = findRoute(route);
  if (!found) throw new Error(`home: unknown route ${route}`);
  return found.path;
}

export function homeLinks(view: LinkInput, can: CanFn): Record<HomeLinkId, string | null> {
  const when = (route: NavRouteId, href: string) => (canSeeRoute(route, can) ? href : null);
  const payments = pathOf("payments");
  const oldestWaiting = view.handoversWaiting.oldestDate;
  const oldestMissed = view.missedRuns.oldestPeriod;
  return {
    cash_today: when("payments", withQuery(payments, { method: "cash" })),
    upi_today: when("payments", withQuery(payments, { method: "upi" })),
    collected: when("payments", withQuery(payments, { from: view.period, to: view.today })),
    billed: when("bills_register", registerHref(view.period)),
    due: when("reports_dues", pathOf("reports_dues")),
    run: view.latestRun
      ? when("bills_runs", runsHref(view.latestRun.period))
      : when("bills", pathOf("bills")),
    handovers: when("linemen", withQuery(pathOf("linemen"), { date: oldestWaiting ?? undefined })),
    payments_to_check: when("payments_check", pathOf("payments_check")),
    missed: oldestMissed
      ? when("bills_runs", runsHref(oldestMissed, { preview: true }))
      : when("bills", pathOf("bills")),
    subscription: when("settings_subscription", pathOf("settings_subscription")),
  };
}

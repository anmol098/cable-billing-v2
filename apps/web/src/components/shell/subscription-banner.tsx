/**
 * The shell's banner slot (T-029): one line under the header when the subscription needs
 * attention (PLAN §13). T-085 added the trial-ending reminder.
 *
 * | Subscription | Owner | Staff |
 * |---|---|---|
 * | `trialing`, 7 days or less left, no autopay yet (T-085) | amber: "Free trial ends on {date}" + Pay now | nothing |
 * | `trialing` (otherwise), `active` | nothing | nothing |
 * | `grace` | amber: "Pay by {date}" + Pay now | nothing (PLAN §11.9: only the Owner sees the warning) |
 * | `read_only`, `cancelled`, no row | red: "View only, collecting still works" + Pay now | red, "Ask the owner" |
 *
 * Staff do see the read-only banner: their buttons stop working then, and they must know why.
 * Dates are the last IST day with access (an end at 00:00 IST on 28 Nov reads "27 Nov").
 */
import { daysUntil, lastDayBefore, REMINDER_DAYS_BEFORE, tenantModeOf } from "@cb/core";
import type { SubscriptionStatus } from "@cb/db";
import { type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Button, Icon } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { findRoute } from "@/lib/nav";

export type BannerInput = {
  /** `null`: no subscription row (read-only, failing closed like T-025's `tenantModeOf`). */
  status: SubscriptionStatus | null;
  graceEndsAt: Date | null;
  /** T-085: when the free trial ends (00:00 IST). */
  trialEndsAt?: Date | null;
  /** T-085: autopay already set up, so the trial needs no "pay" reminder. */
  autopayOn?: boolean;
};

export type Banner =
  | { kind: "grace"; graceEndsAt: Date | null; canPay: true }
  | { kind: "trial_ending"; trialEndsAt: Date; canPay: true }
  | { kind: "read_only"; canPay: boolean };

/** Days before the trial ends when the Owner starts seeing the banner (the T-7 reminder). */
const TRIAL_BANNER_DAYS = Math.max(...REMINDER_DAYS_BEFORE);

/** Which banner (if any) to show. `canPay` = the role has `subscription.manage`. */
export function bannerFor(
  input: BannerInput,
  canPay: boolean,
  now: Date = new Date(),
): Banner | null {
  if (tenantModeOf(input.status) === "read_only") return { kind: "read_only", canPay };
  if (input.status === "grace" && canPay) {
    return { kind: "grace", graceEndsAt: input.graceEndsAt, canPay };
  }
  if (input.status === "trialing" && canPay && input.trialEndsAt && !input.autopayOn) {
    const left = daysUntil(input.trialEndsAt, now);
    if (left > 0 && left <= TRIAL_BANNER_DAYS) {
      return { kind: "trial_ending", trialEndsAt: input.trialEndsAt, canPay };
    }
  }
  return null;
}

const SUBSCRIPTION_PATH = findRoute("settings_subscription")?.path ?? "/settings/subscription";

/** Renders `banner` (or nothing). */
export function SubscriptionBanner({
  banner,
  locale,
}: {
  banner: Banner | null;
  locale: DisplayLocale;
}) {
  const t = useTranslations("shell.banner");
  const ts = useTranslations("subscription.banner");
  if (!banner) return null;
  const warning = banner.kind !== "read_only";
  const day = (end: Date) => formatBusinessDate(lastDayBefore(end), locale);
  const message =
    banner.kind === "grace"
      ? t("grace", { date: banner.graceEndsAt ? day(banner.graceEndsAt) : "" })
      : banner.kind === "trial_ending"
        ? ts("trial_ending", { date: day(banner.trialEndsAt) })
        : t("read_only");
  return (
    <div
      role="status"
      data-shell="subscription-banner"
      data-kind={banner.kind}
      className="flex flex-wrap items-center gap-3 border-b-hairline border-border bg-surface px-4 py-3"
    >
      <Icon
        name={warning ? "pending" : "danger"}
        className={warning ? "size-6 shrink-0 text-pending" : "size-6 shrink-0 text-danger"}
      />
      <p className="min-w-0 flex-1 font-strong text-base">
        {message}
        {banner.canPay ? null : <span className="block font-regular">{t("ask_owner")}</span>}
      </p>
      {banner.canPay ? (
        <Button asChild variant="secondary" icon="subscription">
          <Link href={SUBSCRIPTION_PATH}>{t("pay_now")}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The shell's banner slot (T-029): one line under the header when the subscription needs
 * attention (PLAN §13). T-085 owns the subscription state machine and may add banners here.
 *
 * | Subscription | Owner | Staff |
 * |---|---|---|
 * | `trialing`, `active` | nothing | nothing |
 * | `grace` | amber: "Pay by {date}" + Pay now | nothing (PLAN §11.9: only the Owner sees the warning) |
 * | `read_only`, `cancelled`, no row | red: "View only, collecting still works" + Pay now | red, "Ask the owner" |
 *
 * Staff do see the read-only banner: their buttons stop working then, and they must know why.
 */
import { tenantModeOf } from "@cb/core";
import type { SubscriptionStatus } from "@cb/db";
import { businessDateOf, type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Button, Icon } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { findRoute } from "@/lib/nav";

export type BannerInput = {
  /** `null`: no subscription row (read-only, failing closed like T-025's `tenantModeOf`). */
  status: SubscriptionStatus | null;
  graceEndsAt: Date | null;
};

export type Banner =
  | { kind: "grace"; graceEndsAt: Date | null; canPay: true }
  | { kind: "read_only"; canPay: boolean };

/** Which banner (if any) to show. `canPay` = the role has `subscription.manage`. */
export function bannerFor(input: BannerInput, canPay: boolean): Banner | null {
  if (tenantModeOf(input.status) === "read_only") return { kind: "read_only", canPay };
  if (input.status === "grace" && canPay) {
    return { kind: "grace", graceEndsAt: input.graceEndsAt, canPay };
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
  if (!banner) return null;
  const grace = banner.kind === "grace";
  const message = grace
    ? t("grace", {
        date: banner.graceEndsAt
          ? formatBusinessDate(businessDateOf(banner.graceEndsAt), locale)
          : "",
      })
    : t("read_only");
  return (
    <div
      role="status"
      data-shell="subscription-banner"
      data-kind={banner.kind}
      className="flex flex-wrap items-center gap-3 border-b-hairline border-border bg-surface px-4 py-3"
    >
      <Icon
        name={grace ? "pending" : "danger"}
        className={grace ? "size-6 shrink-0 text-pending" : "size-6 shrink-0 text-danger"}
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

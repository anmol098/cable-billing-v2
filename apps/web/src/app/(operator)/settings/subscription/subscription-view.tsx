/**
 * Settings → App subscription (T-085, PLAN §13): one job — keep the app paid. Numbers first, one
 * status word with icon + colour, one Pay button. Owner only (the page 404s for everyone else).
 *
 * - Status card: Free trial / Paid / Pay now / View only / Stopped, with the last day in words (IST).
 * - Price: ₹472 a month (₹400 + ₹72 GST), any number of customers.
 * - Autopay line when Razorpay has one (on, not finished, failing).
 * - Pay button unless autopay is on; "not set up yet" while Razorpay keys are missing (H-01).
 * - Missed bill runs after a reactivation (D-25), linking to Bills.
 */
import type { SubscriptionView } from "@cb/core";
import {
  businessDateOf,
  type DisplayLocale,
  formatBusinessDate,
  formatINR,
  period,
  periodLabel,
} from "@cb/domain";
import { Button, Card, StatusPill, type StatusPillVariant } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { Notice } from "../profile/field";
import type { ConfirmCheckoutState, StartCheckoutState } from "./actions";
import { PayButton } from "./pay-button";

const STATUS_PILL: Record<NonNullable<SubscriptionView["status"]> | "none", StatusPillVariant> = {
  trialing: "pending",
  active: "success",
  grace: "pending",
  read_only: "danger",
  cancelled: "danger",
  none: "danger",
};

export function SubscriptionPage({
  title,
  view,
  locale,
  paymentReady,
  start,
  confirm,
}: {
  title: string;
  view: SubscriptionView;
  locale: DisplayLocale;
  /** Razorpay keys and plan are configured (H-01). */
  paymentReady: boolean;
  start: () => Promise<StartCheckoutState>;
  confirm: (response: {
    paymentId: unknown;
    subscriptionId: unknown;
    signature: unknown;
  }) => Promise<ConfirmCheckoutState>;
}) {
  const t = useTranslations("subscription");
  const status = view.status ?? "none";
  const date = view.accessLastDay ? formatBusinessDate(view.accessLastDay, locale) : "";
  const total = formatINR(view.plan.totalPaise);
  const firstCharge =
    view.status === "trialing" && view.trialEndsAt
      ? formatBusinessDate(businessDateOf(view.trialEndsAt), locale)
      : view.status === "active" && view.currentPeriodEnd
        ? formatBusinessDate(businessDateOf(view.currentPeriodEnd), locale)
        : "";
  const autopayText =
    view.autopay === "on"
      ? view.status === "trialing"
        ? t("autopay.on_first", { date: firstCharge })
        : t("autopay.on", { total })
      : view.autopay === "not_finished"
        ? t("autopay.not_finished")
        : view.autopay === "failing"
          ? t("autopay.failing")
          : null;
  const months = view.missedRunPeriods.map((p) => periodLabel(period(p), locale)).join(", ");

  return (
    <div className="flex flex-col gap-6" data-subscription-status={status}>
      <ShellPageHeader title={title} description={t("description")} />

      <Card className="flex flex-col gap-3" data-subscription="status">
        <div>
          <StatusPill variant={STATUS_PILL[status]} label={t(`status.${status}`)} />
        </div>
        <p className="font-strong text-xl">{t(`explain.${status}`, { date })}</p>
        {autopayText ? <p className="text-base">{autopayText}</p> : null}
      </Card>

      <Card className="flex flex-col gap-2" data-subscription="price">
        <h2 className="font-strong text-lg">{t("price.title")}</h2>
        <p className="font-numeric font-strong text-amount">{t("price.total", { total })}</p>
        <p className="text-base text-text-muted">
          {t("price.breakdown", {
            price: formatINR(view.plan.pricePaise),
            gst: formatINR(view.plan.gstPaise),
            percent: view.plan.gstPercent,
          })}
        </p>
        <p className="text-base">{t("price.unlimited")}</p>
      </Card>

      {view.canPay ? (
        <Card className="flex flex-col gap-3">
          {paymentReady ? (
            <>
              <PayButton totalText={total} locale={locale} start={start} confirm={confirm} />
              <p className="text-base text-text-muted">{t("pay_how")}</p>
              {view.status === "trialing" && firstCharge ? (
                <p className="text-base">{t("pay_first_later", { date: firstCharge })}</p>
              ) : null}
            </>
          ) : (
            <Notice tone="pending">{t("not_set_up")}</Notice>
          )}
        </Card>
      ) : null}

      {view.missedRunPeriods.length > 0 && view.mode === "normal" ? (
        <Card className="flex flex-col gap-3" data-subscription="missed">
          <h2 className="font-strong text-lg">{t("missed.title")}</h2>
          <p className="text-base">{t("missed.body", { months })}</p>
          <div>
            <Button asChild variant="secondary" icon="bill">
              <Link href="/bills/runs">{t("missed.open")}</Link>
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

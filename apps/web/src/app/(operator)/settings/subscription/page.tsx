/**
 * Settings → App subscription (T-085, PLAN §13; replaces T-029's placeholder). Owner only: other
 * roles get 404 like every Owner-only page, and the services check `subscription.manage` again.
 * Works in read-only mode (paying is how a tenant leaves it, D-13).
 */
import { subscriptionOverview } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { razorpaySetup } from "@/lib/subscription/server";
import { confirmCheckoutAction, startCheckoutAction } from "./actions";
import { SubscriptionPage } from "./subscription-view";

export const generateMetadata = () => placeholderMetadata("settings_subscription");

export default async function SubscriptionSettingsPage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("settings_subscription", roleCan(ctx.role))) notFound();
  const result = await subscriptionOverview.call(getServerRuntime(), ctx, {});
  if (!result.ok) {
    if (result.error.code === "FORBIDDEN") notFound();
    throw new Error(`subscriptions.overview failed: ${result.error.code}`);
  }
  const [locale, shell] = await Promise.all([getLocale(), getTranslations("shell")]);
  const setup = razorpaySetup();
  return (
    <SubscriptionPage
      title={shell("routes.settings_subscription")}
      view={result.value}
      locale={locale as DisplayLocale}
      paymentReady={Boolean(setup?.planId)}
      start={startCheckoutAction}
      confirm={confirmCheckoutAction}
    />
  );
}

/**
 * The customer profile's frame (T-033, PLAN §12.1): back link, the customer's name as the page
 * title with code / area / status under it, the page's one primary action ("Take payment" by
 * default), and the tab bar. Each tab page renders its content as `children`:
 *
 * ```tsx
 * // customers/[id]/connections/page.tsx (T-034)
 * export default async function Page({ params }: { params: Promise<{ id: string }> }) {
 *   const { id } = await params;
 *   return (
 *     <CustomerProfileShell customerId={id} tab="connections">
 *       …the tab's content…
 *     </CustomerProfileShell>
 *   );
 * }
 * ```
 *
 * It answers 404 for a made-up id and for another business's customer (`loadCustomerProfile`),
 * the same as every other cross-tenant id. The profile it loaded is passed to `children` when
 * `children` is a function, so the tab doesn't load it again.
 */
import type { CustomerProfile } from "@cb/core";
import { Button, PAGE_ACTION_CLEARANCE } from "@cb/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactElement, ReactNode } from "react";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { CustomerTabs } from "./customer-tabs";
import { loadCustomerProfile } from "./server";
import { ActivePill } from "./status-pills";
import { CUSTOMER_TABS, type CustomerTab } from "./tab-list";

export interface CustomerProfileShellProps {
  customerId: string;
  tab: CustomerTab;
  /**
   * The page's one primary action. Default: "Take payment" (when the role may record payments).
   * `null`: none.
   */
  action?: ReactElement | null;
  children: ReactNode | ((profile: CustomerProfile) => ReactNode);
}

/** "Take payment" for this customer: the counter payment page (T-048) with the customer chosen. */
export function takePaymentHref(customerId: string): string {
  return `/payments/new?customer=${encodeURIComponent(customerId)}`;
}

export async function CustomerProfileShell({
  customerId,
  tab,
  action,
  children,
}: CustomerProfileShellProps) {
  const ctx = await getTenantContext();
  const profile = await loadCustomerProfile(customerId);
  if (!profile) notFound();
  const t = await getTranslations("customers");
  const can = roleCan(ctx.role);

  const takePayment = can("payments.record") ? (
    <Button asChild size="lg" icon="collect">
      <Link href={takePaymentHref(profile.id)} data-action="take-payment">
        {t("profile.take_payment")}
      </Link>
    </Button>
  ) : undefined;
  const pageAction = action === null ? undefined : (action ?? takePayment);
  const labels = Object.fromEntries(
    CUSTOMER_TABS.map((id) => [id, t(`profile.tab_${id}`)]),
  ) as Record<CustomerTab, string>;

  return (
    <div
      className={
        pageAction ? `flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}` : "flex flex-col gap-6"
      }
      data-customer-profile={tab}
    >
      <ShellPageHeader
        back={
          <Button asChild variant="quiet" icon="back">
            <Link href="/customers">{t("profile.back")}</Link>
          </Button>
        }
        title={profile.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-numeric text-text">
              {t("profile.code", { code: profile.customerCode })}
            </span>
            {profile.areaName ? <span>{profile.areaName}</span> : null}
            <ActivePill
              active={profile.status === "active"}
              label={t(`status.${profile.status}`)}
            />
          </span>
        }
        {...(pageAction ? { action: pageAction } : {})}
      />
      <CustomerTabs customerId={profile.id} labels={labels} label={t("profile.tabs")} />
      {typeof children === "function" ? children(profile) : children}
    </div>
  );
}

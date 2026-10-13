/**
 * `/payments/new`: take a payment at the office counter (T-048, PLAN §12.1, FR-013/FR-014).
 * `?customer=<id>` (T-033's "Take payment" on a customer) starts at the amount with that customer
 * chosen; another business's customer or a made-up id starts at the search instead. Owner and
 * Staff (`payments.record`; allowed in read-only mode, D-13).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CounterPayment } from "@/components/payments/counter-payment";
import type { PickerCustomer } from "@/components/payments/results";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { loadCustomerProfile } from "../../customers/_components/server";
import { copyReceiptLinkAction, findCustomersAction, takePaymentAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.payments_new") };
}

export default async function TakePaymentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!canSeeRoute("payments_new", roleCan(ctx.role))) notFound();
  const raw = (await searchParams).customer;
  const customerId = Array.isArray(raw) ? raw[0] : raw;
  const profile = customerId ? await loadCustomerProfile(customerId) : null;
  const initialCustomer: PickerCustomer | null = profile
    ? {
        id: profile.id,
        code: profile.customerCode,
        name: profile.name,
        phone: profile.phone,
        areaName: profile.areaName,
        balancePaise: profile.balancePaise,
        active: profile.status === "active",
      }
    : null;
  const [shell, t] = await Promise.all([getTranslations("shell"), getTranslations("payments")]);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <ShellPageHeader title={shell("routes.payments_new")} description={t("new.description")} />
      <CounterPayment
        key={initialCustomer?.id ?? "none"}
        initialCustomer={initialCustomer}
        findCustomers={findCustomersAction}
        takePayment={takePaymentAction}
        copyReceiptLink={copyReceiptLinkAction}
      />
    </div>
  );
}

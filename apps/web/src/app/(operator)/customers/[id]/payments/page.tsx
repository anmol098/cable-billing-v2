/**
 * Customer profile, **Payments** tab (T-048, PLAN §12.1 "Profile tabs … Payments"): every payment
 * of this customer, newest first, cancelled ones marked; a row opens the payment. "Take payment"
 * stays the profile's primary action (`CustomerProfileShell`). Another business's customer and
 * made-up ids answer 404 (the shell).
 */
import { listPayments } from "@cb/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type Translate, withQuery } from "@/components/payments/format";
import { NoPayments, Pager, PaymentsTable } from "@/components/payments/payment-parts";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { CustomerProfileShell } from "../../_components/profile-shell";
import { loadCustomerProfile } from "../../_components/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const [profile, shell] = await Promise.all([loadCustomerProfile(id), getTranslations("shell")]);
  const tab = shell("routes.customer_payments");
  return { title: profile ? `${profile.name} · ${tab}` : tab };
}

export default async function CustomerPaymentsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const raw = query.page;
  const page = Math.max(1, Math.min(Number.parseInt(String(raw ?? "1"), 10) || 1, 200));
  return (
    <CustomerProfileShell customerId={id} tab="payments">
      {(profile) => <CustomerPayments customerId={profile.id} page={page} />}
    </CustomerProfileShell>
  );
}

async function CustomerPayments({ customerId, page }: { customerId: string; page: number }) {
  const ctx = await getTenantContext();
  const result = await listPayments.call(getServerRuntime(), ctx, {
    customerId,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  if (!result.ok) throw new Error(`payments.list failed: ${result.error.code}`);
  const t = (await getTranslations("payments")) as unknown as Translate;
  return (
    <div className="flex flex-col gap-4" data-customer-payments={customerId}>
      <PaymentsTable
        rows={result.value.rows}
        caption={t("customer_tab.caption")}
        empty={<NoPayments message={t("customer_tab.empty")} />}
      />
      <Pager
        page={page}
        hasMore={result.value.hasMore}
        href={(n) =>
          withQuery(`/customers/${customerId}/payments`, { page: n > 1 ? String(n) : "" })
        }
      />
    </div>
  );
}

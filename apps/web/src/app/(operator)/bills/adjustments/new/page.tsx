/**
 * `/bills/adjustments/new?customer=<id>`: the Owner's "New bill change" (T-045, PLAN §8.3, FR-024):
 * an extra charge (goes on the next bill) or money taken off (taken off what the customer owes
 * now, oldest bill first), with a reason. **Owner only** (`adjustments.manage`): others get 404,
 * and the service refuses them too. `?customer=` starts with that customer chosen; another
 * business's customer or a made-up id starts with the search.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { loadCustomerProfile } from "../../../customers/_components/server";
import { findCustomersAction } from "../../../payments/actions";
import { ManualAdjustmentForm, type ManualCustomer } from "../_parts/manual-form";
import { createManualAdjustmentAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adjustments");
  return { title: t("manual.title") };
}

export default async function NewBillChangePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("adjustments.manage")) notFound();
  const raw = (await searchParams).customer;
  const customerId = Array.isArray(raw) ? raw[0] : raw;
  const profile = customerId ? await loadCustomerProfile(customerId) : null;
  const initialCustomer: ManualCustomer | null = profile
    ? { id: profile.id, code: profile.customerCode, name: profile.name }
    : null;
  const t = await getTranslations("adjustments");

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <ShellPageHeader title={t("manual.title")} description={t("manual.description")} />
      <ManualAdjustmentForm
        key={initialCustomer?.id ?? "none"}
        initialCustomer={initialCustomer}
        findCustomers={findCustomersAction}
        save={createManualAdjustmentAction}
        doneHref="/bills/adjustments"
      />
    </div>
  );
}

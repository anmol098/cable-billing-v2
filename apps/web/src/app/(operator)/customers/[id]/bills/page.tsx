/**
 * Customer profile, Bills tab (T-049; PLAN §12.1 Customers → Bills; FR-011): every bill of the
 * customer with what is paid and still due on it, newest first; a row opens the bill (T-047's
 * `/bills/[id]`: lines, payments, Print bill). Owner and Staff (`dashboard.view`); another
 * business's customer and made-up ids answer 404.
 */
import { customerBills } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Translate } from "@/components/bills/format";
import { roleCan } from "@/components/shell/access";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { CustomerProfileShell } from "../../_components/profile-shell";
import { loadCustomerProfile } from "../../_components/server";
import { customerTabHref } from "../../_components/tab-list";
import { CustomerBills } from "./_components/bills-view";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const [profile, shell] = await Promise.all([loadCustomerProfile(id), getTranslations("shell")]);
  const tab = shell("routes.customer_bills");
  return { title: profile ? `${profile.name} · ${tab}` : tab };
}

export default async function CustomerBillsPage({ params }: { params: Params }) {
  const [{ id }, ctx] = await Promise.all([params, getTenantContext()]);
  if (!roleCan(ctx.role)("dashboard.view")) notFound();
  const result = await customerBills.call(getServerRuntime(), ctx, { customerId: id });
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION") notFound();
    throw new Error(`customer bills: ${result.error.code}`);
  }
  const [ts, tbills, locale] = await Promise.all([
    getTranslations("statements"),
    getTranslations("bills"),
    getLocale(),
  ]);
  return (
    <CustomerProfileShell customerId={id} tab="bills">
      <CustomerBills
        view={result.value}
        t={ts as unknown as Translate}
        tb={tbills as unknown as Translate}
        locale={locale as DisplayLocale}
        historyHref={customerTabHref(result.value.customerId, "history")}
      />
    </CustomerProfileShell>
  );
}

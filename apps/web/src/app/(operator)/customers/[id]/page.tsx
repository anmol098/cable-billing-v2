/**
 * Customer profile, Summary tab (T-033, PLAN §12.1): due / credit, connections, last payment,
 * details, "Take payment" (header), "Change details" (`?edit=1`) and close / make active again
 * (Owner and Staff). The other tabs are their own pages (T-034, T-048, T-049) inside the same
 * `CustomerProfileShell`. Another business's customer and made-up ids answer 404.
 */
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { resolveLocale } from "@/i18n/config";
import { getTenantContext } from "@/lib/auth/session";
import { EMPTY_VALUES } from "../_components/form-state";
import { CustomerProfileShell } from "../_components/profile-shell";
import { loadCustomerProfile, loadFormOptions } from "../_components/server";
import { updateCustomerAction } from "./summary/actions";
import { EditCustomerForm } from "./summary/edit-form";
import { SavedNotice } from "./summary/saved-notice";
import { CustomerSummary } from "./summary/summary-view";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const profile = await loadCustomerProfile(id);
  const shell = await getTranslations("shell");
  return { title: profile?.name ?? shell("routes.customer_summary") };
}

export default async function CustomerSummaryPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ id }, query, ctx] = await Promise.all([params, searchParams, getTenantContext()]);
  const can = roleCan(ctx.role);
  const canManage = can("customers.manage");
  const editing = canManage && query.edit === "1";
  const saved = query.saved === "new" || query.saved === "changes" ? query.saved : null;
  const [t, locale] = await Promise.all([getTranslations("customers"), getLocale()]);
  const options = editing ? await loadFormOptions() : null;

  return (
    <CustomerProfileShell customerId={id} tab="summary" {...(editing ? { action: null } : {})}>
      {(profile) => (
        <>
          {saved ? (
            <SavedNotice
              message={saved === "new" ? t("profile.saved") : t("profile.changes_saved")}
            />
          ) : null}
          {editing && options ? (
            <EditCustomerForm
              action={updateCustomerAction.bind(null, profile.id)}
              areas={options.areas}
              cancelHref={`/customers/${profile.id}`}
              initial={{
                ...EMPTY_VALUES,
                customerCode: profile.customerCode,
                name: profile.name,
                phone: profile.phone ?? "",
                altPhone: profile.altPhone ?? "",
                areaId: profile.areaId ?? "",
                address: profile.address ?? "",
              }}
            />
          ) : (
            <CustomerSummary
              profile={profile}
              locale={resolveLocale(locale)}
              canManage={canManage}
            />
          )}
        </>
      )}
    </CustomerProfileShell>
  );
}

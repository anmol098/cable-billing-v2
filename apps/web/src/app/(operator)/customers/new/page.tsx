/**
 * Add customer (T-033, PLAN §12.2): Customer → Connections (VC) → Check & save. Owner and Staff
 * (`customers.manage`); others get 404 like the menu. Step 2 and saving the customer with its
 * connection in one transaction are T-034's (`_steps/connections/`).
 */
import { connectionFormOptions } from "@cb/core";
import { Button } from "@cb/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { callAsUser, loadFormOptions } from "../_components/server";
import { createCustomerWithConnectionAction } from "./_steps/connections/actions";
import { AddCustomerWithConnection } from "./_steps/connections/add-customer-with-connection";

export const generateMetadata = () => placeholderMetadata("customers_new");

export default async function AddCustomerPage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("customers_new", roleCan(ctx.role))) notFound();
  const [t, shell, options, connectionOptions] = await Promise.all([
    getTranslations("customers"),
    getTranslations("shell"),
    loadFormOptions(),
    callAsUser(connectionFormOptions, {}, ctx),
  ]);
  if (!connectionOptions.ok) {
    throw new Error(`connections.form_options failed: ${connectionOptions.error.code}`);
  }
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.customers_new")}
        back={
          <Button asChild variant="quiet" icon="back">
            <Link href="/customers">{t("profile.back")}</Link>
          </Button>
        }
      />
      <AddCustomerWithConnection
        action={createCustomerWithConnectionAction}
        areas={options.areas}
        nextAutoCode={options.nextAutoCode}
        plans={connectionOptions.value.plans}
        today={connectionOptions.value.today}
        latestStartDate={connectionOptions.value.latestStartDate}
      />
    </div>
  );
}

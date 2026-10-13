/**
 * Add customer (T-033, PLAN §12.2): Customer → Connections (VC) → Check & save. Owner and Staff
 * (`customers.manage`); others get 404 like the menu.
 */
import { Button } from "@cb/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { loadFormOptions } from "../_components/server";
import { createCustomerAction } from "./actions";
import { AddCustomerForm } from "./add-customer-form";

export const generateMetadata = () => placeholderMetadata("customers_new");

export default async function AddCustomerPage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("customers_new", roleCan(ctx.role))) notFound();
  const [t, shell, options] = await Promise.all([
    getTranslations("customers"),
    getTranslations("shell"),
    loadFormOptions(),
  ]);
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
      <AddCustomerForm
        action={createCustomerAction}
        areas={options.areas}
        nextAutoCode={options.nextAutoCode}
      />
    </div>
  );
}

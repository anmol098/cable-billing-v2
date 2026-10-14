/**
 * Add customers from Excel (T-084, FR-030, PLAN §12.2): a guided wizard. 1 Get the form
 * (download the .xlsx/.csv template, English or Hindi column names) → 2 Upload the file (read and
 * previewed by `imports.customers.check`) → 3 Check and add (every line's status and what to fix,
 * then the valid customers are added step by step by `imports.customers.apply`), then the result
 * and the "lines with problems" file to fix and upload again.
 *
 * Owner and Staff (`customers.manage`); others get 404 like the menu.
 */
import { IMPORT_LIMITS } from "@cb/core";
import { Button } from "@cb/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { megabytes } from "./_lib/words";
import { importStepAction } from "./actions";
import { ImportWizard } from "./import-wizard";

export const generateMetadata = () => placeholderMetadata("customers_import");

export default async function ImportCustomersPage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("customers_import", roleCan(ctx.role))) notFound();
  const [t, shell, customers, locale] = await Promise.all([
    getTranslations("import"),
    getTranslations("shell"),
    getTranslations("customers"),
    getLocale(),
  ]);
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.customers_import")}
        description={t("intro")}
        back={
          <Button asChild variant="quiet" icon="back">
            <Link href="/customers">{customers("profile.back")}</Link>
          </Button>
        }
      />
      <ImportWizard
        importStep={importStepAction}
        otherLanguage={locale === "hi" ? "en" : "hi"}
        limits={{
          rows: IMPORT_LIMITS.rows,
          megabytes: megabytes(IMPORT_LIMITS.fileBytes),
          fileBytes: IMPORT_LIMITS.fileBytes,
          parallelSteps: IMPORT_LIMITS.parallelSteps,
        }}
      />
    </div>
  );
}

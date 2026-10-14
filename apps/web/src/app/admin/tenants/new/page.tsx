/**
 * `/admin/tenants/new`: create an operator and its owner (T-086, PRD J-01) with T-027's
 * provisionTenant. The new operator's id is made here, once per page view (idempotency key).
 */
import { uuidv7 } from "@cb/db";
import { Button } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AdminPageHeader } from "../../_components/parts";
import { getAdminContext } from "../../_lib/context";
import { createTenantAction } from "../actions";
import { CreateTenantForm } from "./create-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("create.title"), robots: { index: false } };
}

export default async function NewTenantPage() {
  await getAdminContext();
  const t = await getTranslations("admin");
  return (
    <>
      <AdminPageHeader
        title={t("create.title")}
        back={
          <Button asChild variant="quiet" icon="back">
            <Link href="/admin/tenants">{t("tenants.title")}</Link>
          </Button>
        }
      />
      <CreateTenantForm operatorId={uuidv7()} action={createTenantAction} />
    </>
  );
}

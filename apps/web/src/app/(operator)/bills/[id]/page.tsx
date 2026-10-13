/**
 * `/bills/[id]` (T-047, PLAN §12.1 "Bill detail"; FR-011): one bill with its lines per VC, bill
 * changes, the payments and credit put on it, what is still due, and the customer's account now.
 * "Print bill" opens the A5 printable bill in the operator's language (`/bills/[id]/print`).
 * Another tenant's bill (or a made-up id) is a 404. Owner and Staff (`billing.preview`).
 */

import { getBill } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { Button, PAGE_ACTION_CLEARANCE } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { BillDetail } from "@/components/bills/bill-detail";
import { monthText, registerHref, type Translate } from "@/components/bills/format";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.bill_detail") };
}

export default async function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("billing.preview")) notFound();
  const { id } = await params;
  const result = await getBill.call(getServerRuntime(), ctx, { invoiceId: id });
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION") notFound();
    throw new Error(`bill: ${result.error.code}`);
  }
  const view = result.value;
  const [tr, locale] = await Promise.all([getTranslations("bills"), getLocale()]);
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;

  return (
    <div className={`flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}`}>
      <ShellPageHeader
        title={tr("detail.title", { number: view.bill.invoiceNumber })}
        description={monthText(view.bill.period, displayLocale)}
        action={
          <Button asChild size="lg" icon="print">
            {/* A plain link: the printable bill is a route handler (no client navigation). */}
            <a href={`/bills/${view.bill.id}/print?auto=1`}>{tr("detail.print")}</a>
          </Button>
        }
      />
      <div>
        <Button asChild variant="quiet" icon="back">
          <Link href={registerHref(view.bill.period)}>{tr("detail.back")}</Link>
        </Button>
      </div>
      <BillDetail t={t} view={view} locale={displayLocale} />
    </div>
  );
}

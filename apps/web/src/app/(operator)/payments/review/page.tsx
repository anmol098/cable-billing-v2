/**
 * `/payments/review` ("Payments to check", T-048, PLAN §10.4 `posted_needs_review`, §12.1): every
 * payment that came in flagged (closed customer, switched-off lineman, another phone, a wrong
 * phone clock …), newest first like the register, with the reason. The money is already saved;
 * each row opens the payment, where the office marks it checked. Owner and Staff.
 */
import { listPayments } from "@cb/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { type Translate, withQuery } from "@/components/payments/format";
import { NoPayments, Pager, PaymentsTable } from "@/components/payments/payment-parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.payments_check") };
}

export default async function PaymentsToCheckPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!canSeeRoute("payments_check", roleCan(ctx.role))) notFound();
  const raw = (await searchParams).page;
  const page = Math.max(1, Math.min(Number.parseInt(String(raw ?? "1"), 10) || 1, 200));
  const result = await listPayments.call(getServerRuntime(), ctx, {
    status: "to_check",
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  if (!result.ok) throw new Error(`payments.list failed: ${result.error.code}`);
  const [tr, shell] = await Promise.all([getTranslations("payments"), getTranslations("shell")]);
  const t = tr as unknown as Translate;

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.payments_check")}
        description={tr("check.description")}
      />
      <PaymentsTable
        rows={result.value.rows}
        caption={t("check.caption")}
        columns={["customer", "amount", "method", "reason", "when"]}
        empty={<NoPayments message={t("check.empty")} />}
      />
      <Pager
        page={page}
        hasMore={result.value.hasMore}
        href={(n) => withQuery("/payments/review", { page: n > 1 ? String(n) : "" })}
      />
    </div>
  );
}

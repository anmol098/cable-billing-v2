/**
 * `/payments/reversals` ("Undo payment", **Owner only**, T-048, PLAN §8.6, BR-13): find the payment
 * by its receipt no. (or a phone's temporary `P-…` no.) and go to its undo screen, or open any
 * payment from the register and press "Undo payment". Below: the payments already cancelled.
 * Staff get 404 here (like the T-029 placeholder) and the server refuses them anyway.
 */
import { listPayments } from "@cb/core";
import { Button, Icon, Input } from "@cb/ui";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { paymentHref, type Translate, undoHref, withQuery } from "@/components/payments/format";
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
  return { title: t("routes.payments_reversals") };
}

export default async function UndoPaymentFindPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!canSeeRoute("payments_reversals", roleCan(ctx.role))) notFound();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const receipt = one(params.receipt).trim().slice(0, 32);
  const page = Math.max(1, Math.min(Number.parseInt(one(params.page), 10) || 1, 200));
  const runtime = getServerRuntime();

  let notFoundNumber: string | null = null;
  if (receipt) {
    const found = await listPayments.call(runtime, ctx, { receiptNumber: receipt, limit: 2 });
    const rows = found.ok ? found.value.rows : [];
    if (rows.length === 1 && rows[0]) {
      const row = rows[0];
      redirect(row.cancelled ? paymentHref(row.id) : undoHref(row.id));
    }
    if (rows.length === 0) notFoundNumber = receipt;
  }

  const result = await listPayments.call(runtime, ctx, {
    status: "cancelled",
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  if (!result.ok) throw new Error(`payments.list failed: ${result.error.code}`);
  const [tr, shell] = await Promise.all([getTranslations("payments"), getTranslations("shell")]);
  const t = tr as unknown as Translate;

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={shell("routes.payments_reversals")}
        description={tr("undo.description")}
      />
      <search>
        <form method="get" action="/payments/reversals" className="flex flex-col gap-3">
          <label
            htmlFor="undo-receipt"
            className="flex max-w-sm flex-col gap-1 text-base text-text"
          >
            {tr("undo.find_label")}
            <Input
              id="undo-receipt"
              name="receipt"
              defaultValue={receipt}
              placeholder={tr("undo.find_placeholder")}
              autoComplete="off"
              className="font-numeric"
              maxLength={32}
            />
          </label>
          <div>
            <Button type="submit" icon="search">
              {tr("undo.find")}
            </Button>
          </div>
        </form>
      </search>
      {notFoundNumber ? (
        <p role="alert" className="flex items-center gap-2 text-base text-danger">
          <Icon name="danger" className="shrink-0" />
          {tr("undo.not_found", { number: notFoundNumber })}
        </p>
      ) : null}
      <p className="text-base text-text-muted">{tr("undo.how")}</p>

      <h2 className="font-strong text-xl">{tr("undo.recent_title")}</h2>
      <PaymentsTable
        rows={result.value.rows}
        caption={t("undo.recent_title")}
        empty={<NoPayments message={t("undo.recent_empty")} />}
      />
      <Pager
        page={page}
        hasMore={result.value.hasMore}
        href={(n) => withQuery("/payments/reversals", { page: n > 1 ? String(n) : "" })}
      />
    </div>
  );
}

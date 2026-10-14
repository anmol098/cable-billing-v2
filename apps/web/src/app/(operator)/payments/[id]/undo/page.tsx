/**
 * `/payments/[id]/undo`: the Owner undoes a payment (T-048, PLAN §8.6 "pick the payment, choose a
 * reason, then confirm"; BR-13, RULE-20; PLAN §2.2 rule 6). The effect is stated first in plain
 * words with the numbers: the payment, the balance now and after (balance + amount: the bills it
 * paid open again), "Cancelled" on the receipt, cash to give back. **Owner only**: Staff get 404
 * here, and `payments.reverse` refuses everyone but the Owner on the server.
 */

import { Button, Card, Icon } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { balanceText, paymentHref, rupees, type Translate } from "@/components/payments/format";
import { loadPayment } from "@/components/payments/server";
import { UndoPayment } from "@/components/payments/undo-payment";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { undoPaymentAction } from "../../actions";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.payment_undo") };
}

export default async function UndoPaymentPage({ params }: { params: Params }) {
  const [{ id }, ctx] = await Promise.all([params, getTenantContext()]);
  if (!canSeeRoute("payment_undo", roleCan(ctx.role))) notFound();
  const payment = await loadPayment(id);
  if (!payment) notFound();
  const [tr, shell] = await Promise.all([getTranslations("payments"), getTranslations("shell")]);
  const t = tr as unknown as Translate;
  const back = (
    <Button asChild variant="quiet" icon="back">
      <Link href={paymentHref(payment.id)}>{tr("undo.back")}</Link>
    </Button>
  );

  if (payment.cancellation) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <ShellPageHeader back={back} title={shell("routes.payment_undo")} />
        <p role="status" className="flex items-center gap-2 text-lg text-danger">
          <Icon name="undo" className="shrink-0" />
          {tr("undo.already")}
        </p>
      </div>
    );
  }

  const amount = rupees(payment.amountPaise);
  const before = balanceText(t, payment.customer.balancePaise);
  // PLAN §8.6 / T-046: the reversal adds the amount back to the balance (the ledger gets +amount).
  const after = balanceText(t, payment.customer.balancePaise + payment.amountPaise);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <ShellPageHeader
        back={back}
        title={shell("routes.payment_undo")}
        description={tr("undo.description")}
      />
      <Card className="flex flex-col gap-3 border-danger p-4 sm:p-6" data-testid="undo-effect">
        <h2 className="font-strong text-xl">{tr("undo.effect_title")}</h2>
        <p className="text-lg">
          {tr("undo.effect_payment", {
            name: payment.customer.name,
            amount,
            method: tr(`method.${payment.method}`),
            number: payment.receipt?.receiptNumber ?? "—",
          })}
        </p>
        <p className="text-lg font-strong" data-testid="undo-balance">
          {tr("undo.effect_balance", { before, after })}
        </p>
        {payment.bills.length > 0 ? <p className="text-base">{tr("undo.effect_bills")}</p> : null}
        <p className="text-base">{tr("undo.effect_receipt")}</p>
        {payment.method === "cash" ? (
          <p className="text-base text-text-muted">{tr("undo.effect_cash")}</p>
        ) : null}
      </Card>
      <UndoPayment
        paymentId={payment.id}
        amount={amount}
        customerName={payment.customer.name}
        balanceAfter={after}
        undo={undoPaymentAction}
      />
    </div>
  );
}

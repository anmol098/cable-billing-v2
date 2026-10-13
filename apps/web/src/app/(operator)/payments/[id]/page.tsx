/**
 * `/payments/[id]`: one payment (T-048, PLAN §12.1, FR-013/FR-014): the amount first, cash/UPI,
 * status (Counted / To check / Checked / Cancelled), the customer, receipt no. (+ the phone's
 * temporary no.), who took it and when (the phone's time and when it reached the office, PLAN
 * §10.4), what it paid, the receipt actions, the office check, and (Owner) "Undo payment".
 * Another business's payment and made-up ids answer 404.
 */
import type { PaymentDetail } from "@cb/core";
import { type DisplayLocale, type Period, periodLabel } from "@cb/domain";
import { Amount, Button, Card, Icon, PAGE_ACTION_CLEARANCE } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  balanceText,
  rupees,
  type Translate,
  undoHref,
  undoReasonWords,
  whenText,
} from "@/components/payments/format";
import { MethodPill, PaymentStatusPill } from "@/components/payments/payment-parts";
import { ReceiptActions } from "@/components/payments/receipt-actions";
import { ResolveReview } from "@/components/payments/resolve-review";
import { loadPayment } from "@/components/payments/server";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { copyReceiptLinkAction, resolveReviewAction } from "../actions";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const payment = await loadPayment(id);
  const t = await getTranslations("payments");
  return {
    title: payment?.receipt
      ? t("detail.title", { number: payment.receipt.receiptNumber })
      : t("detail.title_no_receipt"),
  };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b-hairline border-border py-3 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="text-sm text-text-muted sm:w-48 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-lg break-words">{children}</dd>
    </div>
  );
}

function billLine(t: Translate, bill: PaymentDetail["bills"][number], locale: DisplayLocale) {
  const amount = rupees(bill.amountPaise);
  const left = rupees(bill.outstandingAfterPaise);
  if (bill.invoiceKind === "opening_balance") {
    return bill.outstandingAfterPaise > 0
      ? t("detail.old_due_left", { amount, left })
      : t("detail.old_due_paid", { amount });
  }
  const month = periodLabel(bill.period as Period, locale, "short");
  return bill.outstandingAfterPaise > 0
    ? t("detail.bill_left", { month, amount, left })
    : t("detail.bill_paid", { month, amount });
}

export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query, ctx] = await Promise.all([params, searchParams, getTenantContext()]);
  const can = roleCan(ctx.role);
  if (!canSeeRoute("payment_detail", can)) notFound();
  const payment = await loadPayment(id);
  if (!payment) notFound();
  const [tr, locale] = await Promise.all([getTranslations("payments"), getLocale()]);
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const cancelled = payment.cancellation !== null;
  const canUndo = can("payments.reverse") && !cancelled;
  const undo = canUndo ? (
    <Button asChild size="lg" variant="danger" icon="undo">
      <Link href={undoHref(payment.id)}>{tr("detail.undo")}</Link>
    </Button>
  ) : undefined;
  const sameTime = Math.abs(payment.postedAt.getTime() - payment.recordedAt.getTime()) < 60_000;

  return (
    <div className={undo ? `flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}` : "flex flex-col gap-6"}>
      <ShellPageHeader
        back={
          <Button asChild variant="quiet" icon="back">
            <Link href="/payments">{tr("detail.back")}</Link>
          </Button>
        }
        title={
          payment.receipt
            ? tr("detail.title", { number: payment.receipt.receiptNumber })
            : tr("detail.title_no_receipt")
        }
        {...(undo ? { action: undo } : {})}
      />

      {query.undone === "1" && cancelled ? (
        <p role="status" className="flex items-center gap-2 text-base text-success">
          <Icon name="success" className="shrink-0" />
          {tr("detail.undone_notice")}
        </p>
      ) : null}

      <Card className="flex flex-col gap-3 p-4 sm:p-6">
        <Amount
          paise={payment.amountPaise}
          size="amount"
          weight="strong"
          className={cancelled ? "line-through" : undefined}
          data-testid="payment-amount"
        />
        <div className="flex flex-wrap items-center gap-2" data-testid="payment-status">
          <MethodPill t={t} method={payment.method} />
          <PaymentStatusPill t={t} cancelled={cancelled} reviewStatus={payment.review.status} />
        </div>
      </Card>

      {payment.cancellation ? (
        <Card className="flex flex-col gap-2 border-danger p-4 sm:p-6" data-testid="cancellation">
          <h2 className="flex items-center gap-2 font-strong text-xl text-danger">
            <Icon name="undo" className="shrink-0" />
            {tr("detail.cancelled_title")}
          </h2>
          <p className="text-base">
            {tr("detail.cancelled_reason", {
              reason: undoReasonWords(t, payment.cancellation.reason),
            })}
          </p>
          <p className="text-base text-text-muted">
            {tr("detail.cancelled_by", {
              name: payment.cancellation.by.name,
              when: whenText(t, payment.cancellation.at, displayLocale),
            })}
          </p>
          <p className="text-base">{tr("detail.cancelled_note")}</p>
        </Card>
      ) : null}

      {payment.review.status !== "none" ? (
        <Card className="flex flex-col gap-3 p-4 sm:p-6" data-testid="office-check">
          <h2 className="font-strong text-xl">{tr("detail.check_title")}</h2>
          {payment.review.reason ? (
            <p className="flex items-start gap-2 text-base text-pending">
              <Icon name="danger" className="mt-1 shrink-0" />
              {tr("detail.check_reason", {
                reason: tr(`review_reason.${payment.review.reason}`),
              })}
            </p>
          ) : null}
          {payment.review.status === "resolved" && payment.review.reviewedAt ? (
            <p className="flex items-center gap-2 text-base text-success">
              <Icon name="success" className="shrink-0" />
              {tr("detail.checked_by", {
                name: payment.review.reviewedBy?.name ?? "",
                when: whenText(t, payment.review.reviewedAt, displayLocale),
              })}
            </p>
          ) : null}
          {payment.review.note ? (
            <p className="text-base">{tr("detail.check_note", { note: payment.review.note })}</p>
          ) : null}
          {payment.review.status === "needs_review" && can("handover.review") ? (
            <div>
              <ResolveReview
                paymentId={payment.id}
                amount={rupees(payment.amountPaise)}
                customerName={payment.customer.name}
                resolve={resolveReviewAction}
              />
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="p-4 sm:p-6">
        <dl>
          <Row label={tr("detail.customer")}>
            <Link
              className="underline underline-offset-4"
              href={`/customers/${payment.customer.id}`}
            >
              {payment.customer.name}
            </Link>{" "}
            <span className="font-numeric text-base text-text-muted">
              ({payment.customer.code})
            </span>
          </Row>
          {payment.receipt ? (
            <Row label={tr("detail.receipt_no")}>
              <span className="font-numeric" data-testid="receipt-number">
                {payment.receipt.receiptNumber}
              </span>
            </Row>
          ) : null}
          {payment.receipt?.provisionalRef ? (
            <Row label={tr("detail.temporary_no")}>
              <span className="font-numeric">{payment.receipt.provisionalRef}</span>
            </Row>
          ) : null}
          <Row label={tr("detail.taken_by")}>
            {payment.collector?.name ?? "—"}{" "}
            <span className="text-base text-text-muted">({tr(`source.${payment.source}`)})</span>
          </Row>
          <Row label={tr("detail.taken_at")}>{whenText(t, payment.recordedAt, displayLocale)}</Row>
          {sameTime ? null : (
            <Row label={tr("detail.reached_office")}>
              {whenText(t, payment.postedAt, displayLocale)}
            </Row>
          )}
          {payment.upiReference ? (
            <Row label={tr("detail.upi_ref")}>
              <span className="font-numeric">{payment.upiReference}</span>{" "}
              <span className="text-base text-text-muted">({tr("detail.upi_ref_note")})</span>
            </Row>
          ) : null}
          {payment.notes ? <Row label={tr("detail.note")}>{payment.notes}</Row> : null}
          <Row label={tr("detail.balance_now")}>
            <span data-testid="balance-now">{balanceText(t, payment.customer.balancePaise)}</span>
          </Row>
        </dl>
      </Card>

      <Card className="flex flex-col gap-3 p-4 sm:p-6">
        <h2 className="font-strong text-xl">{tr("detail.bills_title")}</h2>
        {payment.bills.length === 0 ? (
          <p className="text-base">{tr("detail.no_bills")}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-base">
            {payment.bills.map((bill) => (
              <li key={bill.invoiceId}>{billLine(t, bill, displayLocale)}</li>
            ))}
            {payment.creditAddedPaise > 0 ? (
              <li className="text-credit">
                {tr("detail.credit_added", { amount: rupees(payment.creditAddedPaise) })}
              </li>
            ) : null}
          </ul>
        )}
        {payment.balanceAfterPaise !== null ? (
          <p className="text-base text-text-muted">
            {tr("detail.balance_after")}: {balanceText(t, payment.balanceAfterPaise)}
          </p>
        ) : null}
      </Card>

      {payment.receipt ? (
        <section aria-label={tr("receipt.label")}>
          <ReceiptActions paymentId={payment.id} copyLink={copyReceiptLinkAction} />
        </section>
      ) : null}
    </div>
  );
}

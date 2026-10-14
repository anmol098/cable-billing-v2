/**
 * The body of the bill detail page (T-047, PLAN §12.1 "Bill detail (lines, payments allocated,
 * adjustments)", FR-011): who, which month, the amounts (old due, this month, total, paid on
 * this bill, still due), the lines per connection (VC) with bill changes, the payments and credit
 * put on this bill, and the customer's account now. Server-rendered; words come in through `t`.
 */
import type { BillDetailView, BillLineView } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { Amount, Card, Divider, Icon, StatusPill } from "@cb/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { istDate, lineKey, monthText, PAY_STATE_PILL, type Translate } from "./format";

function Row({
  label,
  children,
  strong = false,
}: {
  label: ReactNode;
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className={strong ? "font-strong text-base text-text" : "text-base text-text-muted"}>
        {label}
      </dt>
      <dd className="m-0 text-end">{children}</dd>
    </div>
  );
}

function LineList({ t, lines }: { t: Translate; lines: readonly BillLineView[] }) {
  return (
    <dl className="flex flex-col">
      {lines.map((line) => (
        <Row
          key={line.id}
          label={
            <span className="flex flex-col">
              <span className="text-text">{t(`line.${lineKey(line)}`)}</span>
              {line.adjustment?.reason ? (
                <span className="text-sm text-text-muted">{line.adjustment.reason}</span>
              ) : null}
            </span>
          }
        >
          <Amount paise={line.amountPaise} weight="regular" />
        </Row>
      ))}
    </dl>
  );
}

export function BillDetail({
  t,
  view,
  locale,
}: {
  t: Translate;
  view: BillDetailView;
  locale: DisplayLocale;
}) {
  const { bill, customer, connections, otherLines, payments, balance } = view;
  const pill = PAY_STATE_PILL[bill.payState];
  return (
    <div className="flex flex-col gap-6">
      {bill.status === "void" ? (
        <p
          role="status"
          className="rounded-lg border-hairline border-danger p-4 text-base text-danger"
        >
          {t("detail.void", { reason: bill.voidReason ?? "" })}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card asChild className="flex flex-col gap-2">
          <section aria-label={t("detail.customer")}>
            <span className="text-sm text-text-muted">{t("detail.customer")}</span>
            <Link
              href={`/customers/${customer.id}`}
              className="flex items-center gap-2 font-strong text-xl text-text underline-offset-4 hover:underline"
              data-testid="bill-customer"
            >
              <Icon name="customer" className="shrink-0" />
              {customer.name}
            </Link>
            <span className="font-numeric text-base text-text-muted">
              {t("detail.code", { code: customer.code })}
              {customer.areaName ? ` · ${customer.areaName}` : ""}
            </span>
            {customer.phone ? (
              <span className="flex items-center gap-2 font-numeric text-base text-text">
                <Icon name="call" className="shrink-0" />
                {customer.phone}
              </span>
            ) : null}
          </section>
        </Card>
        <Card asChild className="flex flex-col gap-2">
          <section aria-label={t("detail.month")}>
            <dl className="flex flex-col">
              <Row label={t("detail.month")}>
                <span className="font-strong text-text">{monthText(bill.period, locale)}</span>
              </Row>
              <Row label={t("detail.made_on")}>
                <span className="text-text">{istDate(bill.issuedAt, locale)}</span>
              </Row>
            </dl>
            <StatusPill
              variant={pill.variant}
              icon={pill.icon}
              label={t(`pay_state.${bill.payState}`)}
              className="self-start"
              data-testid="bill-pay-state"
            />
            {bill.kind === "opening_balance" ? (
              <p className="text-sm text-text-muted">{t("detail.old_dues_bill")}</p>
            ) : null}
          </section>
        </Card>
      </div>

      <Card asChild className="flex flex-col gap-2">
        <section aria-labelledby="bill-amounts-title">
          <h2 id="bill-amounts-title" className="font-strong text-lg text-text">
            {t("detail.amounts")}
          </h2>
          <dl className="flex flex-col">
            {bill.kind === "regular" ? (
              <Row
                label={
                  bill.openingBalancePaise < 0
                    ? t("detail.previous_credit")
                    : t("detail.previous_due")
                }
              >
                <Amount paise={bill.openingBalancePaise} tone="balance" weight="regular" />
              </Row>
            ) : null}
            <Row label={t("detail.this_month")}>
              <Amount paise={bill.chargesPaise} data-testid="bill-charges" />
            </Row>
            {bill.kind === "regular" ? (
              <Row label={t("detail.total")} strong>
                <Amount paise={bill.totalDuePaise} tone="balance" data-testid="bill-total" />
              </Row>
            ) : null}
            <Divider />
            <Row label={t("detail.paid_on_bill")}>
              <Amount paise={bill.paidPaise} weight="regular" data-testid="bill-paid" />
            </Row>
            <Row label={t("detail.still_due")} strong>
              <Amount
                paise={bill.outstandingPaise}
                tone={bill.outstandingPaise > 0 ? "due" : "neutral"}
                size="2xl"
                data-testid="bill-outstanding"
              />
            </Row>
          </dl>
        </section>
      </Card>

      {connections.length > 0 || otherLines.length > 0 ? (
        <section aria-labelledby="bill-lines-title" className="flex flex-col gap-3">
          <h2 id="bill-lines-title" className="font-strong text-lg text-text">
            {t("detail.connections")}
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {connections.map((connection) => (
              <li key={connection.assignmentId}>
                <Card className="flex h-full flex-col gap-2" data-testid="bill-connection">
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-strong text-base text-text">
                      <Icon name="plan" className="shrink-0" />
                      {t("detail.vc", { number: connection.vcNumber })}
                    </span>
                    <Amount paise={connection.totalPaise} />
                  </span>
                  <LineList t={t} lines={connection.lines} />
                </Card>
              </li>
            ))}
            {otherLines.length > 0 ? (
              <li>
                <Card className="flex h-full flex-col gap-2" data-testid="bill-other-lines">
                  <span className="font-strong text-base text-text">{t("detail.other_lines")}</span>
                  <LineList t={t} lines={otherLines} />
                </Card>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="bill-payments-title" className="flex flex-col gap-3">
        <h2 id="bill-payments-title" className="font-strong text-lg text-text">
          {t("detail.payments")}
        </h2>
        {payments.length === 0 ? (
          <p className="text-base text-text-muted">{t("detail.no_payments")}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="bill-payments">
            {payments.map((entry) => (
              <li key={entry.sourceId}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex flex-col gap-1">
                    {entry.payment ? (
                      <>
                        <StatusPill
                          variant={entry.payment.method}
                          label={t(`method.${entry.payment.method}`)}
                          className="self-start"
                        />
                        <span className="text-sm text-text-muted">
                          {entry.payment.receiptNumber
                            ? `${t("detail.receipt", { number: entry.payment.receiptNumber })} · `
                            : ""}
                          {istDate(entry.payment.recordedAt, locale)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="font-strong text-base text-credit">
                          {t("detail.credit_used")}
                        </span>
                        {entry.creditAdjustment ? (
                          <span className="text-sm text-text-muted">
                            {t(`line.${entry.creditAdjustment.source}`)}
                            {entry.creditAdjustment.reason
                              ? ` · ${entry.creditAdjustment.reason}`
                              : ""}
                          </span>
                        ) : null}
                      </>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    {entry.undonePaise > 0 ? (
                      <StatusPill variant="danger" icon="undo" label={t("detail.cancelled")} />
                    ) : null}
                    <Amount
                      paise={entry.amountPaise}
                      className={entry.undonePaise > 0 ? "line-through" : undefined}
                    />
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card asChild className="flex flex-wrap items-center justify-between gap-3">
        <section aria-label={t("detail.account_now")}>
          <span className="font-strong text-base text-text">{t("detail.account_now")}</span>
          {balance.balancePaise > 0 ? (
            <Amount
              paise={balance.balancePaise}
              tone="due"
              size="xl"
              dueLabel={t("detail.due_now")}
              data-testid="account-now"
            />
          ) : balance.balancePaise < 0 ? (
            <Amount
              paise={balance.balancePaise}
              size="xl"
              creditLabel={t("detail.credit_now")}
              data-testid="account-now"
            />
          ) : (
            <span className="font-strong text-lg text-success" data-testid="account-now">
              {t("detail.nothing_due")}
            </span>
          )}
        </section>
      </Card>
    </div>
  );
}

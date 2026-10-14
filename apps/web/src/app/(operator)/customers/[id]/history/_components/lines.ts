/**
 * Plain words for one statement line (T-049; glossary: never "invoice", "ledger", "reversal",
 * "adjustment"). Pure: the translators come in, so the page, the printed statement and the tests
 * word lines the same way. `t` is the `statements` namespace, `tb` the `bills` namespace (T-047's
 * words for how a bill change came about).
 */
import type { StatementLine } from "@cb/core";
import { type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { formatRupees, type IconName } from "@cb/ui";
import { monthText, type Translate } from "@/components/bills/format";

/** The colour meaning of a line (PLAN §2.2 rule 4): cash, UPI, a cancelled payment, or plain. */
export type LineTone = "cash" | "upi" | "danger" | "plain";

export interface LineWords {
  readonly icon: IconName;
  readonly tone: LineTone;
  /** What happened, in a few words ("Bill for November 2026", "Paid in cash"). */
  readonly title: string;
  /** Short facts under the title (bill no., receipt no., who, why). */
  readonly details: readonly string[];
  /** The payment was cancelled later by the Owner. */
  readonly cancelledLater: boolean;
}

/** `+₹500` / `−₹300`: the line's effect on what the customer owes. */
export function signedRupees(paise: number): string {
  const text = formatRupees(Math.abs(paise)).text;
  if (paise > 0) return `+${text}`;
  if (paise < 0) return `−${text}`;
  return text;
}

/** The words, icon and colour of a line. */
export function describeLine(
  line: StatementLine,
  t: Translate,
  tb: Translate,
  locale: DisplayLocale,
): LineWords {
  const plain = { tone: "plain" as const, cancelledLater: false };
  switch (line.type) {
    case "invoice":
    case "opening_balance": {
      const bill = line.bill;
      const details: string[] = [];
      if (bill) details.push(t("line.bill_no", { number: bill.invoiceNumber }));
      if (bill?.status === "void") details.push(t("line.bill_cancelled"));
      const title =
        line.type === "opening_balance" || !bill
          ? t("line.old_dues")
          : t("line.bill", { month: monthText(bill.period, locale) });
      return { ...plain, icon: "bill", title, details };
    }
    case "debit_adjustment":
    case "credit_adjustment": {
      const adjustment = line.adjustment;
      const details: string[] = [];
      if (adjustment) {
        details.push(tb(`line.${adjustment.source}`));
        if (adjustment.period) {
          details.push(t("line.for_month", { month: monthText(adjustment.period, locale) }));
        }
        if (adjustment.reason) details.push(adjustment.reason);
      }
      return {
        ...plain,
        icon: "edit",
        title: line.type === "debit_adjustment" ? t("line.extra") : t("line.discount"),
        details,
      };
    }
    case "payment": {
      const payment = line.payment;
      const details: string[] = [];
      if (payment?.receiptNumber) {
        details.push(t("line.receipt", { number: payment.receiptNumber }));
      }
      if (payment && payment.businessDate !== line.date) {
        details.push(
          t("line.taken_on", { date: formatBusinessDate(payment.businessDate, locale) }),
        );
      }
      if (payment?.collectorName) details.push(t("line.by", { name: payment.collectorName }));
      const method = payment?.method ?? "cash";
      return {
        icon: method,
        tone: method,
        title: t(method === "cash" ? "line.paid_cash" : "line.paid_upi"),
        details,
        cancelledLater: payment?.reversed ?? false,
      };
    }
    case "payment_reversal": {
      const payment = line.payment;
      const details: string[] = [];
      if (payment) {
        details.push(`${tb(`method.${payment.method}`)} ${formatRupees(payment.amountPaise).text}`);
      }
      if (payment?.receiptNumber) {
        details.push(t("line.receipt", { number: payment.receiptNumber }));
      }
      if (line.reversal) details.push(t("line.why", { reason: line.reversal.reason }));
      return {
        icon: "undo",
        tone: "danger",
        title: t("line.cancelled"),
        details,
        cancelledLater: false,
      };
    }
  }
}

/**
 * What the public receipt says, in one language: the same lines for the HTML page and the A5 PDF,
 * in the order of the printed receipt (T-068 `ReceiptContent`, PLAN §11.8):
 *
 * operator name + phone, "Receipt", [Cancelled], receipt no. (+ temporary no.), date and time (IST),
 * customer (first name) + masked phone, the amount large, method, which bills were paid, the balance
 * after the payment, the operator's footer.
 *
 * Left out on purpose (public page, PLAN §9.4): customer surname and code, full phone, the lineman,
 * the UPI reference. Amounts use Indian grouping (`formatINR`), dates `12 Oct 2026` / `12 अक्टू 2026`.
 */
import type { PublicReceipt } from "@cb/core";
import {
  businessDateOf,
  formatBusinessDate,
  formatINR,
  IST_OFFSET_MINUTES,
  type Period,
  periodLabel,
} from "@cb/domain";
import type { Locale } from "@cb/i18n";
import type { ReceiptTranslator } from "./i18n";

export interface ReceiptField {
  readonly label: string;
  readonly value: string;
  /** Numbers and codes: drawn with tabular figures. */
  readonly numeric?: boolean;
}

export type BalanceTone = "due" | "credit" | "clear";

export interface ReceiptDocument {
  readonly locale: Locale;
  /** `<title>` / PDF title: the receipt number only (no personal data). */
  readonly pageTitle: string;
  readonly operatorName: string;
  /** The operator's phone as dialled (`tel:`), and the line that shows it. */
  readonly operatorPhone: { readonly dial: string; readonly text: string } | null;
  readonly heading: string;
  readonly cancelled: { readonly stamp: string; readonly note: string } | null;
  readonly receiptFields: readonly ReceiptField[];
  readonly customerFields: readonly ReceiptField[];
  readonly amount: string;
  readonly method: { readonly kind: "cash" | "upi"; readonly label: string };
  readonly bills: readonly string[];
  readonly balance: {
    readonly tone: BalanceTone;
    readonly label: string;
    readonly amount: string | null;
  } | null;
  readonly footer: string | null;
}

/** `4:05 PM` in India time, words for AM/PM from the messages (as on the printed receipt). */
export function istClock(instant: Date, t: ReceiptTranslator): string {
  const minutesOfDay =
    (((Math.floor(instant.getTime() / 60_000) + IST_OFFSET_MINUTES) % 1440) + 1440) % 1440;
  const hour = Math.floor(minutesOfDay / 60);
  const minute = String(minutesOfDay % 60).padStart(2, "0");
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const time = `${hour12}:${minute}`;
  return hour >= 12 ? t("time_pm", { time }) : t("time_am", { time });
}

/** `12 Oct 2026, 4:05 PM` / `12 अक्टू 2026, 4:05 PM` (IST). */
export function istDateTime(instant: Date, locale: Locale, t: ReceiptTranslator): string {
  return t("date_time", {
    date: formatBusinessDate(businessDateOf(instant), locale),
    time: istClock(instant, t),
  });
}

const rupees = (paise: number) => formatINR(paise, { sign: "absolute" });

function billLine(
  bill: PublicReceipt["bills"][number],
  locale: Locale,
  t: ReceiptTranslator,
): string {
  if (bill.period === null) {
    return bill.leftPaise <= 0
      ? t("old_due_paid")
      : t("old_due_left", { amount: rupees(bill.leftPaise) });
  }
  const month = periodLabel(bill.period as Period, locale, "short");
  return bill.leftPaise <= 0
    ? t("bill_paid", { month })
    : t("bill_left", { month, amount: rupees(bill.leftPaise) });
}

export function receiptDocument(
  receipt: PublicReceipt,
  locale: Locale,
  t: ReceiptTranslator,
): ReceiptDocument {
  const receiptFields: ReceiptField[] = [
    { label: t("number"), value: receipt.receiptNumber, numeric: true },
  ];
  if (receipt.provisionalRef) {
    receiptFields.push({
      label: t("temporary_number"),
      value: receipt.provisionalRef,
      numeric: true,
    });
  }
  receiptFields.push({ label: t("date"), value: istDateTime(receipt.recordedAt, locale, t) });

  const customerFields: ReceiptField[] = [];
  if (receipt.customer.firstName) {
    customerFields.push({ label: t("customer"), value: receipt.customer.firstName });
  }
  if (receipt.customer.maskedPhone) {
    customerFields.push({
      label: t("customer_phone"),
      value: receipt.customer.maskedPhone,
      numeric: true,
    });
  }

  const balance = receipt.balanceAfter;
  const phone = receipt.operator.phone?.trim();
  return {
    locale,
    pageTitle: t("page_title", { number: receipt.receiptNumber }),
    operatorName: receipt.operator.name,
    operatorPhone: phone
      ? { dial: phone.replace(/[^\d+]/g, ""), text: t("phone", { phone }) }
      : null,
    heading: t("title"),
    cancelled: receipt.cancelled ? { stamp: t("cancelled"), note: t("cancelled_note") } : null,
    receiptFields,
    customerFields,
    amount: rupees(receipt.amountPaise),
    method: { kind: receipt.method, label: receipt.method === "cash" ? t("cash") : t("upi") },
    bills: receipt.bills.map((bill) => billLine(bill, locale, t)),
    balance:
      balance === null
        ? null
        : balance.kind === "due"
          ? { tone: "due", label: t("due_now"), amount: rupees(balance.paise) }
          : balance.kind === "credit"
            ? { tone: "credit", label: t("credit_now"), amount: rupees(balance.paise) }
            : { tone: "clear", label: t("nothing_due"), amount: null },
    footer: receipt.operator.footer,
  };
}

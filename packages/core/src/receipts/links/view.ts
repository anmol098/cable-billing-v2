/**
 * The public receipt (FR-021, PLAN §9.4, §11.8): what the `/r/<token>` page and its A5 PDF show,
 * read inside the receipt's tenant transaction.
 *
 * Same content and order as the printed receipt (T-068 `ReceiptContent`), minus personal data the
 * public page must not show: the customer appears as **first name + masked phone** (not full name
 * and customer code), and the lineman's name, the UPI reference and the payment's notes are left out.
 *
 * A reversed payment (`payment_reversals` row) is `cancelled`: the page shows a "Cancelled" stamp
 * and hides the bills and balance (they describe a payment that no longer counts).
 */
import {
  allocations,
  customers,
  invoices,
  operators,
  parseOperatorSettings,
  paymentReversals,
  payments,
  receipts,
  type Tx,
} from "@cb/db";
import { type Paise, toPaise } from "@cb/domain";
import { and, asc, eq } from "drizzle-orm";
import { customerFirstName, maskPhone } from "./privacy";

export type PublicReceiptLanguage = "hi" | "en";

/** One bill the payment went to: `period` (YYYY-MM-01) or `null` for an old due (opening balance). */
export interface PublicReceiptBill {
  readonly period: string | null;
  /** What is left on that bill right after this payment (0 = paid in full). */
  readonly leftPaise: Paise;
}

/** The customer's balance right after the payment (same rule as Android `ReceiptBalance.of`). */
export type PublicReceiptBalance =
  | { readonly kind: "due"; readonly paise: Paise }
  | { readonly kind: "credit"; readonly paise: Paise }
  | { readonly kind: "clear" };

export interface PublicReceipt {
  readonly operator: {
    readonly name: string;
    /** The office phone from the settings, else the operator's phone; `null` when neither is set. */
    readonly phone: string | null;
    /** The operator's receipt footer text (settings), if any. */
    readonly footer: string | null;
    /** The operator's default language: the page's language when the URL doesn't choose one. */
    readonly language: PublicReceiptLanguage;
  };
  readonly receiptNumber: string;
  /** The phone's temporary number (`P-…`) the customer may have on a printed receipt. */
  readonly provisionalRef: string | null;
  /** When the money was taken (UTC; shown in IST). */
  readonly recordedAt: Date;
  readonly amountPaise: Paise;
  readonly method: "cash" | "upi";
  readonly customer: {
    readonly firstName: string | null;
    /** `XXXXXX3210`, or `null` when there is no usable phone. */
    readonly maskedPhone: string | null;
  };
  /** The payment was undone by the office (payment reversal). */
  readonly cancelled: boolean;
  /** Bills paid by this payment, oldest first (empty when cancelled). */
  readonly bills: readonly PublicReceiptBill[];
  /** Balance after the payment; `null` when unknown (migrated payment) or cancelled. */
  readonly balanceAfter: PublicReceiptBalance | null;
}

export function balanceOf(
  balanceAfterPaise: number | null,
  creditAfterPaise: number | null,
): PublicReceiptBalance | null {
  if (balanceAfterPaise === null || creditAfterPaise === null) return null;
  if (balanceAfterPaise > 0) return { kind: "due", paise: toPaise(balanceAfterPaise) };
  if (creditAfterPaise > 0) return { kind: "credit", paise: toPaise(creditAfterPaise) };
  return { kind: "clear" };
}

function settingsOf(value: unknown) {
  try {
    return parseOperatorSettings(value);
  } catch {
    return parseOperatorSettings({});
  }
}

/**
 * Reads the public view of receipt `receiptId` in `tx` (a `withTenant` transaction of the
 * receipt's operator). `null` when the receipt is not in this tenant.
 */
export async function loadPublicReceipt(
  tx: Tx,
  operatorId: string,
  receiptId: string,
): Promise<PublicReceipt | null> {
  const [row] = await tx
    .select({
      receiptNumber: receipts.receiptNumber,
      provisionalRef: receipts.provisionalRef,
      paymentId: payments.id,
      recordedAt: payments.recordedAt,
      amountPaise: payments.amountPaise,
      method: payments.method,
      balanceAfterPaise: payments.balanceAfterPaise,
      creditAfterPaise: payments.creditAfterPaise,
      customerName: customers.name,
      customerPhone: customers.phone,
      reversalId: paymentReversals.id,
    })
    .from(receipts)
    .innerJoin(
      payments,
      and(eq(payments.operatorId, receipts.operatorId), eq(payments.id, receipts.paymentId)),
    )
    .innerJoin(
      customers,
      and(eq(customers.operatorId, payments.operatorId), eq(customers.id, payments.customerId)),
    )
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(and(eq(receipts.operatorId, operatorId), eq(receipts.id, receiptId)))
    .limit(1);
  if (!row) return null;

  const [operator] = await tx
    .select({ name: operators.name, phone: operators.phone, settings: operators.settings })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .limit(1);
  if (!operator) return null;
  const settings = settingsOf(operator.settings);

  const cancelled = row.reversalId !== null;
  const bills = cancelled
    ? []
    : await tx
        .select({
          kind: invoices.kind,
          period: invoices.period,
          outstandingAfterPaise: allocations.outstandingAfterPaise,
        })
        .from(allocations)
        .innerJoin(
          invoices,
          and(
            eq(invoices.operatorId, allocations.operatorId),
            eq(invoices.id, allocations.invoiceId),
          ),
        )
        .where(
          and(
            eq(allocations.operatorId, operatorId),
            eq(allocations.paymentId, row.paymentId),
            eq(allocations.kind, "posting"),
          ),
        )
        .orderBy(asc(invoices.period), asc(invoices.id));

  return {
    operator: {
      name: operator.name,
      phone: settings.office_phone ?? operator.phone ?? null,
      footer: settings.receipt_footer?.trim() ? settings.receipt_footer.trim() : null,
      language: settings.default_language,
    },
    receiptNumber: row.receiptNumber,
    provisionalRef: row.provisionalRef,
    recordedAt: row.recordedAt,
    amountPaise: toPaise(row.amountPaise),
    method: row.method,
    customer: {
      firstName: customerFirstName(row.customerName),
      maskedPhone: maskPhone(row.customerPhone),
    },
    cancelled,
    bills: bills.map((bill) => ({
      period: bill.kind === "opening_balance" ? null : bill.period,
      leftPaise: toPaise(bill.outstandingAfterPaise),
    })),
    balanceAfter: cancelled ? null : balanceOf(row.balanceAfterPaise, row.creditAfterPaise),
  };
}

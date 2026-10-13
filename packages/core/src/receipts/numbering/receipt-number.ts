/**
 * Receipt numbers (PLAN §7.3, PRD §13.2 step 6, FR-016, RULE-17).
 *
 * - **Permanent:** `R-{YYMM}-{seq:05}` (e.g. `R-2610-00045`). `seq` comes from the tenant's gap-free
 *   `receipt` counter (`app.next_counter`, T-021), so it is continuous across months and never
 *   reused; `YYMM` is the payment's IST business date (`payments.business_date`). Past 99,999 the
 *   sequence simply gets more digits (`R-2610-100000`). Assigned only when the server posts the
 *   payment, inside the posting transaction: a rolled-back posting gives its number back.
 * - **Provisional:** `P-{device_code}-{local seq}` (e.g. `P-K7Q-0012`), made on the phone before
 *   sync and stored on the receipt as an alias forever (`receipts.provisional_ref`). It is not
 *   unique (T-023 decision 6): look-ups by it may return more than one receipt.
 *
 * Never parse a receipt number for meaning: migrated receipts keep their legacy numbers.
 */
import { nextCounter, type Tx } from "@cb/db";
import { type BusinessDate, yymm } from "@cb/domain";

/** The permanent receipt number prefix. */
export const RECEIPT_NUMBER_PREFIX = "R";

/** Minimum digits of the sequence part. */
export const RECEIPT_SEQUENCE_DIGITS = 5;

/** A receipt number this server makes (`R-YYMM-NNNNN`, five or more digits). */
export const RECEIPT_NUMBER_PATTERN = /^R-[0-9]{4}-[0-9]{5,}$/;

/** The phone's provisional reference (`P-{device_code}-{seq}`), as the DB CHECK and contract have it. */
export const PROVISIONAL_REF_REGEX = /^P-[A-Z0-9]{3}-[0-9]{4,9}$/;

/** Formats `R-{YYMM}-{seq:05}` for a business date and a counter value (≥ 1). */
export function formatReceiptNumber(businessDate: BusinessDate, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`receipt sequence must be a positive integer, got ${sequence}`);
  }
  return `${RECEIPT_NUMBER_PREFIX}-${yymm(businessDate)}-${String(sequence).padStart(RECEIPT_SEQUENCE_DIGITS, "0")}`;
}

/** True for a server-made receipt number (`R-YYMM-NNNNN`). */
export function isReceiptNumber(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_NUMBER_PATTERN.test(value);
}

/** True for a provisional phone reference (`P-K7Q-0012`). */
export function isProvisionalRef(value: unknown): value is string {
  return typeof value === "string" && PROVISIONAL_REF_REGEX.test(value);
}

/**
 * Takes the tenant's next receipt number. Call it inside the transaction that inserts the receipt,
 * as late as possible: the counter row stays locked until that transaction ends (every posting of
 * the tenant queues on it), and a rollback returns the number (gap-free).
 */
export async function nextReceiptNumber(
  tx: Tx,
  operatorId: string,
  businessDate: BusinessDate,
): Promise<string> {
  return formatReceiptNumber(businessDate, await nextCounter(tx, operatorId, "receipt"));
}

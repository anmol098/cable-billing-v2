/**
 * Payments (T-046): posting and reversal, the one money path for every payment (web counter,
 * Android batch). Public: the two services, their input schemas and result types, and the
 * receipt numbering helpers. The in-transaction algorithms stay internal to core.
 */
export * from "../receipts/numbering";
export {
  MAX_PAYMENT_PAISE,
  type PostPaymentCommand,
  PostPaymentInput,
  postPayment,
} from "./post-payment";
export {
  type ReversePaymentCommand,
  ReversePaymentInput,
  reversePayment,
} from "./reverse-payment";
export { MAX_FUTURE_SKEW_MS, MAX_RECORDED_AGE_MS } from "./review";
export type {
  PaymentAllocationView,
  PaymentReversalView,
  PaymentView,
  PostPaymentOutcome,
  PostPaymentResult,
  ReceiptView,
  ReversalAllocationView,
  ReversePaymentResult,
} from "./types";

/**
 * Receipt actions (T-061): what the lineman observably did with a receipt (printed, print
 * failed, WhatsApp/SMS opened, PDF shared). Never "sent" or "delivered" (BR-12, RULE-19).
 */
export {
  type RecordedReceiptAction,
  type RecordReceiptActionCommand,
  RecordReceiptActionInput,
  recordReceiptAction,
} from "./record";

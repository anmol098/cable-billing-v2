/**
 * Receipt preview links (T-050, FR-021, PLAN §9.4, D-14): make and revoke links (services), open
 * one from the public page (`openReceiptLink`), the public receipt view, and the weekly purge job.
 */
export {
  type CreatedReceiptLink,
  CreateReceiptLinkInput,
  createReceiptLink,
  RECEIPT_LINK_MAX_LIVE,
  type RevokedReceiptLinks,
  RevokeReceiptLinksInput,
  revokeReceiptLinks,
} from "./manage";
export {
  customerFirstName,
  FIRST_NAME_MAX_LENGTH,
  maskPhone,
  PHONE_VISIBLE_DIGITS,
} from "./privacy";
export {
  type OpenReceiptLinkDeps,
  type OpenReceiptLinkRequest,
  type OpenReceiptLinkResult,
  openReceiptLink,
  RECEIPT_LINK_RATE_LIMITS,
  type ReceiptLinkFormat,
} from "./public";
export {
  purgeExpiredReceiptLinksJob,
  RECEIPT_LINK_PURGE_AFTER_DAYS,
  RECEIPT_LINK_PURGE_BATCH,
  RECEIPT_LINK_PURGE_DEDUPE_KEY,
} from "./purge";
export {
  generateReceiptLinkToken,
  hashReceiptLinkToken,
  isReceiptLinkTokenShape,
  type NewReceiptLinkToken,
  RECEIPT_LINK_PATH_PREFIX,
  RECEIPT_LINK_TOKEN_BYTES,
  RECEIPT_LINK_TOKEN_PATTERN,
  RECEIPT_LINK_TTL_DAYS,
  RECEIPT_LINK_TTL_MS,
  receiptLinkUrl,
} from "./token";
export {
  balanceOf as publicReceiptBalanceOf,
  loadPublicReceipt,
  type PublicReceipt,
  type PublicReceiptBalance,
  type PublicReceiptBill,
  type PublicReceiptLanguage,
} from "./view";

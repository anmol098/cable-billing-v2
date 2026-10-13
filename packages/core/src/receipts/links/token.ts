/**
 * Receipt preview link tokens (FR-021, PLAN §9.4, D-14).
 *
 * - A token is **32 random bytes** from the OS CSPRNG (`crypto.randomBytes`), written as unpadded
 *   base64url: 43 characters of `[A-Za-z0-9_-]`. 256 bits: unguessable, so links can't be
 *   enumerated (the rate limits protect the database, not the secret).
 * - Only `sha256(token)` (64 lower-case hex) is stored (`receipt_links.token_hash`). A copy of the
 *   database (backup, support query) can't open a single receipt.
 * - The raw token exists only in the response to the person who made the link and in the URL they
 *   share. It is never logged, audited or stored.
 */
import { createHash, randomBytes } from "node:crypto";

/** Random bytes per token. */
export const RECEIPT_LINK_TOKEN_BYTES = 32;

/** Unpadded base64url of 32 bytes. */
export const RECEIPT_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Links work for 90 days (D-14). */
export const RECEIPT_LINK_TTL_DAYS = 90;
export const RECEIPT_LINK_TTL_MS = RECEIPT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The public page's path for a token (`/r/<token>`); the PDF is `/r/<token>/pdf`. */
export const RECEIPT_LINK_PATH_PREFIX = "/r/";

export interface NewReceiptLinkToken {
  /** The secret that goes into the URL. Never log or store it. */
  readonly token: string;
  /** What the database stores. */
  readonly tokenHash: string;
}

/** `sha256(token)` as 64 lower-case hex characters (the `receipt_links.token_hash` format). */
export function hashReceiptLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A fresh random token and its hash. `random` is injectable for tests only. */
export function generateReceiptLinkToken(
  random: (size: number) => Buffer = randomBytes,
): NewReceiptLinkToken {
  const token = random(RECEIPT_LINK_TOKEN_BYTES).toString("base64url");
  if (!RECEIPT_LINK_TOKEN_PATTERN.test(token)) {
    throw new Error("receipt link token generator returned the wrong number of bytes");
  }
  return { token, tokenHash: hashReceiptLinkToken(token) };
}

/** True for a string shaped like a token (43 base64url characters). Says nothing about validity. */
export function isReceiptLinkTokenShape(value: string): boolean {
  return RECEIPT_LINK_TOKEN_PATTERN.test(value);
}

/** `<origin>/r/<token>`. `origin` is e.g. `baseUrls().receipt` (no trailing slash needed). */
export function receiptLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}${RECEIPT_LINK_PATH_PREFIX}${token}`;
}

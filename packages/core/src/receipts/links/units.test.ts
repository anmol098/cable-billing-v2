/** Pure parts of the receipt links (T-050): tokens, URL shape, first name, masked phone, balance. */
import { describe, expect, it } from "vitest";
import { customerFirstName, maskPhone } from "./privacy";
import {
  generateReceiptLinkToken,
  hashReceiptLinkToken,
  isReceiptLinkTokenShape,
  RECEIPT_LINK_TTL_MS,
  receiptLinkUrl,
} from "./token";
import { balanceOf } from "./view";

describe("receipt link tokens", () => {
  it("are 32 random bytes as 43 base64url characters, stored only as their SHA-256", () => {
    const { token, tokenHash } = generateReceiptLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashReceiptLinkToken(token));
    expect(tokenHash).not.toContain(token);
  });

  it("never repeat", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateReceiptLinkToken().token));
    expect(tokens.size).toBe(500);
  });

  it("uses the injected byte source and refuses a short one", () => {
    const fixed = generateReceiptLinkToken((size) => Buffer.alloc(size, 7));
    expect(fixed.token).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(() => generateReceiptLinkToken(() => Buffer.alloc(16))).toThrow();
  });

  it("hashes like the database CHECK expects (sha256 hex of the UTF-8 text)", () => {
    expect(hashReceiptLinkToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("recognises the token shape only", () => {
    expect(isReceiptLinkTokenShape("a".repeat(43))).toBe(true);
    expect(isReceiptLinkTokenShape("a".repeat(42))).toBe(false);
    expect(isReceiptLinkTokenShape("a".repeat(44))).toBe(false);
    expect(isReceiptLinkTokenShape(`${"a".repeat(42)}=`)).toBe(false);
    expect(isReceiptLinkTokenShape(`${"a".repeat(42)}/`)).toBe(false);
  });

  it("builds /r/<token> URLs on the receipt origin and lives 90 days", () => {
    expect(receiptLinkUrl("https://pay.example.in/", "tok")).toBe("https://pay.example.in/r/tok");
    expect(receiptLinkUrl("https://pay.example.in", "tok")).toBe("https://pay.example.in/r/tok");
    expect(RECEIPT_LINK_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe("customerFirstName", () => {
  it.each([
    ["Ramesh Kumar Verma", "Ramesh"],
    ["  Sunita   Devi ", "Sunita"],
    ["Shri Ram Prasad", "Ram"],
    ["Smt. Kamla Devi", "Kamla"],
    ["Dr. A. Khan", "A."],
    ["श्री रामप्रसाद शर्मा", "रामप्रसाद"],
    ["श्रीमती सीता", "सीता"],
    ["Verma, Ramesh", "Verma"],
    ["Madonna", "Madonna"],
  ])("%s → %s", (name, first) => {
    expect(customerFirstName(name)).toBe(first);
  });

  it("is null for a blank name or only a title, and cuts a very long word", () => {
    expect(customerFirstName("")).toBeNull();
    expect(customerFirstName("   ")).toBeNull();
    expect(customerFirstName(null)).toBeNull();
    expect(customerFirstName("Shri")).toBeNull();
    expect(customerFirstName("x".repeat(60))).toBe("x".repeat(24));
  });
});

describe("maskPhone", () => {
  it.each([
    ["9876543210", "XXXXXX3210"],
    ["+91 98765 43210", "XXXXXX3210"],
    ["098765-43210", "XXXXXX3210"],
    ["0120 4567890", "XXXXXX7890"],
  ])("%s → %s", (phone, masked) => {
    expect(maskPhone(phone)).toBe(masked);
  });

  it("is null without a usable number (never more than four digits shown)", () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("")).toBeNull();
    expect(maskPhone("12345")).toBeNull();
    expect(maskPhone("1234567")).toBeNull();
  });
});

describe("balanceOf (same rule as Android ReceiptBalance.of)", () => {
  it("due wins, then credit, else clear; unknown when not snapshotted", () => {
    expect(balanceOf(5_000, 0)).toEqual({ kind: "due", paise: 5_000 });
    expect(balanceOf(-2_000, 2_000)).toEqual({ kind: "credit", paise: 2_000 });
    expect(balanceOf(0, 0)).toEqual({ kind: "clear" });
    expect(balanceOf(null, null)).toBeNull();
  });
});

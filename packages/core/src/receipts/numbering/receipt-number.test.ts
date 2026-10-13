import { PROVISIONAL_REF_PATTERN } from "@cb/db";
import { businessDate } from "@cb/domain";
import { describe, expect, it } from "vitest";
import {
  formatReceiptNumber,
  isProvisionalRef,
  isReceiptNumber,
  PROVISIONAL_REF_REGEX,
} from "./receipt-number";

describe("receipt numbers (PLAN §7.3)", () => {
  it("formats R-{YYMM}-{seq:05} from the business date", () => {
    expect(formatReceiptNumber(businessDate("2026-10-13"), 45)).toBe("R-2610-00045");
    expect(formatReceiptNumber(businessDate("2027-01-01"), 1)).toBe("R-2701-00001");
    expect(formatReceiptNumber(businessDate("2030-12-31"), 99_999)).toBe("R-3012-99999");
  });

  it("grows past five digits instead of wrapping", () => {
    expect(formatReceiptNumber(businessDate("2026-10-13"), 100_000)).toBe("R-2610-100000");
  });

  it("refuses a sequence that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => formatReceiptNumber(businessDate("2026-10-13"), bad)).toThrow(RangeError);
    }
  });

  it("recognises receipt numbers and provisional references", () => {
    expect(isReceiptNumber("R-2610-00045")).toBe(true);
    expect(isReceiptNumber("R-2610-0045")).toBe(false);
    expect(isReceiptNumber("P-K7Q-0012")).toBe(false);
    expect(isProvisionalRef("P-K7Q-0012")).toBe(true);
    expect(isProvisionalRef("P-k7q-0012")).toBe(false);
    expect(isProvisionalRef("P-K7Q-012")).toBe(false);
    expect(isProvisionalRef(42)).toBe(false);
  });

  it("uses the same provisional pattern as the database CHECK", () => {
    expect(PROVISIONAL_REF_REGEX.source).toBe(PROVISIONAL_REF_PATTERN);
  });
});

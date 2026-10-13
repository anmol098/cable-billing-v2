import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_RUPEE_DIGITS } from "./paise";
import { parseRupeesInput } from "./parse";

describe("parseRupeesInput()", () => {
  it.each([
    ["", null, ""],
    ["   ", null, ""],
    ["450", 45_000, "450"],
    ["0", 0, "0"],
    ["007", 700, "7"],
    ["₹1,23,456", 12_345_600, "123456"],
    ["1 23 456", 12_345_600, "123456"],
    ["४५०", 45_000, "450"],
    ["₹ ४,५०", 45_000, "450"],
    ["9999999999999", 999_999_999_999_900, "9999999999999"],
  ])("accepts %j", (text, amount, digits) => {
    expect(parseRupeesInput(text)).toEqual({ ok: true, value: { paise: amount, digits } });
  });

  it.each([
    ["12.50", "decimal"],
    ["12.00", "decimal"],
    ["12٫5", "decimal"],
    ["-5", "negative"],
    ["−5", "negative"],
    ["12a", "invalid"],
    ["1e3", "invalid"],
    ["Infinity", "invalid"],
    ["0x10", "invalid"],
    ["₹₹5", "invalid"],
    ["10000000000000", "too-large"],
  ])("refuses %j as %s", (text, reason) => {
    expect(parseRupeesInput(text)).toEqual({ ok: false, error: reason });
  });

  it("allows leading zeros beyond the digit limit", () => {
    expect(parseRupeesInput(`0000${"9".repeat(MAX_RUPEE_DIGITS)}`).ok).toBe(true);
  });

  it("never throws and every accepted value is whole-rupee paise (property)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = parseRupeesInput(text);
        if (result.ok && result.value.paise !== null) {
          expect(Number.isSafeInteger(result.value.paise)).toBe(true);
          expect(result.value.paise % 100).toBe(0);
          expect(result.value.paise).toBeGreaterThanOrEqual(0);
          expect(BigInt(result.value.paise)).toBe(BigInt(result.value.digits) * 100n);
        }
      }),
    );
  });
});

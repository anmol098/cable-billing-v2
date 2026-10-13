import { describe, expect, it } from "vitest";
import {
  formatRupees,
  groupIndian,
  MAX_RUPEE_DIGITS,
  paiseToRupeeDigits,
  parseRupeesInput,
  rupeesToPaise,
} from "./money";

describe("groupIndian", () => {
  it.each([
    ["0", "0"],
    ["99", "99"],
    ["999", "999"],
    ["1000", "1,000"],
    ["12345", "12,345"],
    ["123456", "1,23,456"],
    ["100000", "1,00,000"],
    ["1234567", "12,34,567"],
    ["123456789", "12,34,56,789"],
  ])("%s → %s", (digits, grouped) => {
    expect(groupIndian(digits)).toBe(grouped);
  });
});

describe("formatRupees", () => {
  it.each([
    [0, "₹0"],
    [9900, "₹99"],
    [10000000, "₹1,00,000"],
    [12345600, "₹1,23,456"],
    [1250, "₹12.50"],
    [5, "₹0.05"],
  ])("%d paise → %s", (paise, text) => {
    expect(formatRupees(paise)).toEqual({ text, negative: false });
  });

  it("formats the absolute value of negatives and flags them", () => {
    expect(formatRupees(-50000)).toEqual({ text: "₹500", negative: true });
  });

  it("accepts bigint beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatRupees(123456789012345678n).text).toBe("₹1,23,45,67,89,01,23,456.78");
  });

  it("refuses floats", () => {
    expect(() => formatRupees(12.5)).toThrow(RangeError);
  });
});

describe("rupeesToPaise", () => {
  it("multiplies whole rupees by 100", () => {
    expect(rupeesToPaise(0)).toBe(0);
    expect(rupeesToPaise(450)).toBe(45000);
  });

  it.each([12.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER])("refuses %s", (rupees) => {
    expect(() => rupeesToPaise(rupees)).toThrow(RangeError);
  });
});

describe("parseRupeesInput", () => {
  it.each([
    ["", null, ""],
    ["   ", null, ""],
    ["0", 0, "0"],
    ["450", 45000, "450"],
    ["007", 700, "7"],
    ["1,23,456", 12345600, "123456"],
    ["₹ 500", 50000, "500"],
    ["४५०", 45000, "450"],
  ])("%j → %s paise", (text, paise, digits) => {
    expect(parseRupeesInput(text)).toEqual({ ok: true, paise, digits });
  });

  it.each([
    ["12.50", "decimal"],
    ["12.", "decimal"],
    ["12.00", "decimal"],
    [".5", "decimal"],
    ["-5", "negative"],
    ["−5", "negative"],
    ["-0", "negative"],
    ["abc", "invalid"],
    ["1e3", "invalid"],
    ["+5", "invalid"],
    ["5₹", "invalid"],
  ])("rejects %j as %s", (text, reason) => {
    expect(parseRupeesInput(text)).toEqual({ ok: false, reason });
  });

  it(`accepts ${MAX_RUPEE_DIGITS} digits as safe-integer paise and rejects more`, () => {
    const max = "9".repeat(MAX_RUPEE_DIGITS);
    const result = parseRupeesInput(max);
    expect(result).toEqual({ ok: true, paise: 999999999999900, digits: max });
    expect(result.ok && Number.isSafeInteger(result.paise)).toBe(true);
    expect(parseRupeesInput(`${max}9`)).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("paiseToRupeeDigits", () => {
  it("shows whole rupees as digits and empty for null", () => {
    expect(paiseToRupeeDigits(null)).toBe("");
    expect(paiseToRupeeDigits(0)).toBe("0");
    expect(paiseToRupeeDigits(45000)).toBe("450");
  });

  it("shows a non-whole value honestly instead of rounding", () => {
    expect(paiseToRupeeDigits(45050)).toBe("450.50");
  });
});

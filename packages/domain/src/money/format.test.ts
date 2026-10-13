import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatINR,
  formatRupees,
  groupIndian,
  paiseToRupeeDigits,
  toAsciiDigits,
  toDevanagariDigits,
} from "./format";
import { paise, rupeesToPaise } from "./paise";
import { parseRupeesInput } from "./parse";

const UP_TO_10_12 = fc.integer({ min: 0, max: 1_000_000_000_000 });

/** Indian grouping: 1–3 digits, or 1–2 digits then pairs, then a final group of three. */
const INDIAN_GROUPED = /^(\d{1,3}|\d{1,2}(,\d{2})*,\d{3})$/;

describe("groupIndian()", () => {
  it.each([
    ["0", "0"],
    ["99", "99"],
    ["999", "999"],
    ["1000", "1,000"],
    ["12345", "12,345"],
    ["100000", "1,00,000"],
    ["123456", "1,23,456"],
    ["1234567", "12,34,567"],
    ["12345678", "1,23,45,678"],
    ["1000000000000", "10,00,00,00,00,000"],
  ])("%s → %s", (digits, grouped) => {
    expect(groupIndian(digits)).toBe(grouped);
  });

  it.each(["", "-1", "1,000", "12.5", "१२"])("refuses %j", (digits) => {
    expect(() => groupIndian(digits)).toThrow(RangeError);
  });

  it("groups every number from 0 to 10^12 (property)", () => {
    fc.assert(
      fc.property(UP_TO_10_12, (n) => {
        const grouped = groupIndian(String(n));
        expect(grouped).toMatch(INDIAN_GROUPED);
        expect(grouped.replaceAll(",", "")).toBe(String(n));
      }),
      { numRuns: 2000 },
    );
  });

  // en-IN is a convenient oracle when the runtime has ICU data for it; the code itself never uses Intl.
  const oracle = (() => {
    try {
      const format = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
      return format.format(123456) === "1,23,456" ? format : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(oracle === null)("agrees with Intl en-IN grouping (oracle)", () => {
    fc.assert(
      fc.property(UP_TO_10_12, (n) => {
        expect(groupIndian(String(n))).toBe(oracle?.format(n));
      }),
      { numRuns: 2000 },
    );
  });
});

describe("formatINR()", () => {
  it.each([
    [0, "₹0"],
    [9_900, "₹99"],
    [100_000, "₹1,000"],
    [10_000_000, "₹1,00,000"],
    [12_345_600, "₹1,23,456"],
    [1_250, "₹12.50"],
    [5, "₹0.05"],
    [-50_000, "-₹500"],
    [-1_250, "-₹12.50"],
  ])("%d paise → %s", (amount, text) => {
    expect(formatINR(paise(amount))).toBe(text);
  });

  it("gives the same text in en and hi (Latin digits, PLAN §11.4)", () => {
    expect(formatINR(paise(12_345_600), { locale: "hi" })).toBe("₹1,23,456");
    fc.assert(
      fc.property(fc.maxSafeInteger(), (amount) => {
        expect(formatINR(amount, { locale: "hi" })).toBe(formatINR(amount, { locale: "en" }));
      }),
    );
  });

  it("can drop the sign or use Devanagari digits", () => {
    expect(formatINR(paise(-50_000), { sign: "absolute" })).toBe("₹500");
    expect(formatINR(paise(12_345_600), { numerals: "devanagari" })).toBe("₹१,२३,४५६");
  });

  it("accepts bigint (report totals) and refuses fractions", () => {
    expect(formatINR(12_345_600n)).toBe("₹1,23,456");
    expect(formatINR(10n ** 20n)).toBe("₹10,00,00,00,00,00,00,00,000");
    expect(() => formatINR(12.5)).toThrow(RangeError);
    expect(() => formatINR(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it("round-trips whole rupees through parseRupeesInput (property)", () => {
    fc.assert(
      fc.property(UP_TO_10_12, (rupees) => {
        const amount = rupeesToPaise(rupees);
        const text = formatINR(amount);
        expect(text).toBe(`₹${groupIndian(String(rupees))}`);
        const parsed = parseRupeesInput(text);
        expect(parsed).toEqual({ ok: true, value: { paise: amount, digits: String(rupees) } });
        // Hindi keyboard digits too.
        expect(parseRupeesInput(formatINR(amount, { numerals: "devanagari" }))).toEqual(parsed);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("formatRupees() (same contract as @cb/ui)", () => {
  it("returns the absolute text and the sign", () => {
    expect(formatRupees(paise(12_345_600))).toEqual({ text: "₹1,23,456", negative: false });
    expect(formatRupees(paise(-12_345_600))).toEqual({ text: "₹1,23,456", negative: true });
    expect(formatRupees(-1_250n)).toEqual({ text: "₹12.50", negative: true });
    expect(formatRupees(0)).toEqual({ text: "₹0", negative: false });
  });
});

describe("paiseToRupeeDigits()", () => {
  it.each([
    [null, ""],
    [0, "0"],
    [12_300, "123"],
    [1_250, "12.50"],
    [-12_300, "-123"],
  ])("%s → %j", (amount, digits) => {
    expect(paiseToRupeeDigits(amount)).toBe(digits);
  });
});

describe("digit conversion", () => {
  it("maps Latin ↔ Devanagari digits and leaves the rest", () => {
    expect(toDevanagariDigits("₹1,234 - 567890")).toBe("₹१,२३४ - ५६७८९०");
    expect(toAsciiDigits("₹१,२३४ - ५६७८९०")).toBe("₹1,234 - 567890");
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(toAsciiDigits(toDevanagariDigits(text))).toBe(toAsciiDigits(text));
      }),
    );
  });
});

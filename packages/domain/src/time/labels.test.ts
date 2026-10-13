import { describe, expect, it } from "vitest";
import { businessDate } from "./business-date";
import { formatBusinessDate, MONTH_NAMES, monthName, periodLabel } from "./labels";
import { DISPLAY_LOCALES } from "./locale";
import { period } from "./period";

describe("periodLabel()", () => {
  it("names the month in en and hi", () => {
    expect(periodLabel(period("2026-10-01"), "en")).toBe("October 2026");
    expect(periodLabel(period("2026-10-01"), "hi")).toBe("अक्टूबर 2026");
    expect(periodLabel(period("2027-01-01"), "en", "short")).toBe("Jan 2027");
    expect(periodLabel(period("2027-01-01"), "hi", "short")).toBe("जन 2027");
  });
});

describe("formatBusinessDate() (PLAN §2.2 rule 10)", () => {
  it("matches the documented examples", () => {
    expect(formatBusinessDate(businessDate("2026-10-12"), "en")).toBe("12 Oct 2026");
    expect(formatBusinessDate(businessDate("2026-10-12"), "hi")).toBe("12 अक्टू 2026");
    expect(formatBusinessDate(businessDate("2026-02-05"), "en", "long")).toBe("5 February 2026");
  });
});

describe("month names", () => {
  it("has twelve distinct long and short names per locale", () => {
    for (const locale of DISPLAY_LOCALES) {
      for (const style of ["long", "short"] as const) {
        const names = MONTH_NAMES[locale][style];
        expect(names).toHaveLength(12);
        expect(new Set(names).size).toBe(12);
        for (const name of names) expect(name.trim()).toBe(name);
      }
    }
  });

  it("uses Devanagari for Hindi and Latin digits stay Latin", () => {
    for (const name of [...MONTH_NAMES.hi.long, ...MONTH_NAMES.hi.short]) {
      expect(name).toMatch(/^[ऀ-ॿ]+$/);
    }
    expect(periodLabel(period("2026-10-01"), "hi")).toMatch(/2026$/);
  });

  it("refuses months outside 1–12", () => {
    expect(() => monthName(0, "en")).toThrow(RangeError);
    expect(() => monthName(13, "hi")).toThrow(RangeError);
    expect(monthName(12, "hi")).toBe("दिसंबर");
  });
});

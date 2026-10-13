import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  type BusinessDate,
  businessDate,
  businessDateFromParts,
  businessDateOf,
  compareBusinessDates,
  dateParts,
  daysInMonth,
  IST_OFFSET_MINUTES,
  isBusinessDate,
  istDayRange,
  istStartOfDay,
  parseBusinessDate,
} from "./business-date";

const at = (iso: string) => new Date(iso);

/** Instants between 1970 and 2100. */
const instant = fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) });
/** Business dates between 1970 and 2099. */
const anyDate = fc
  .record({
    year: fc.integer({ min: 1970, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, day }) =>
    businessDateFromParts({ year, month, day: Math.min(day, daysInMonth(year, month)) }),
  );

describe("businessDateOf(): IST calendar date, boundary at 18:30 UTC", () => {
  it.each([
    ["2026-10-31T18:29:59.999Z", "2026-10-31"],
    ["2026-10-31T18:30:00.000Z", "2026-11-01"],
    ["2026-10-12T00:00:00.000Z", "2026-10-12"],
    ["2026-10-12T05:30:00.000Z", "2026-10-12"],
    ["2026-12-31T18:30:00.000Z", "2027-01-01"],
    ["2028-02-28T18:30:00.000Z", "2028-02-29"],
    ["2027-02-28T18:30:00.000Z", "2027-03-01"],
    // The billing scheduler fires at 18:45 UTC (00:15 IST, PLAN §14).
    ["2026-10-31T18:45:00.000Z", "2026-11-01"],
  ])("%s → %s", (iso, date) => {
    expect(businessDateOf(at(iso))).toBe(date);
    expect(businessDateOf(at(iso).getTime())).toBe(date);
  });

  it("refuses an invalid Date", () => {
    expect(() => businessDateOf(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => businessDateOf(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("changes day exactly at 18:30 UTC (property)", () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        const start = istStartOfDay(date).getTime();
        expect(new Date(start).toISOString()).toMatch(/T18:30:00\.000Z$/);
        expect(businessDateOf(start)).toBe(date);
        expect(businessDateOf(start - 1)).toBe(addDays(date, -1));
        expect(businessDateOf(start + 24 * 60 * 60 * 1000 - 1)).toBe(date);
      }),
    );
  });

  it("every instant lies inside its business date's range (property)", () => {
    fc.assert(
      fc.property(instant, (ms) => {
        const { start, end } = istDayRange(businessDateOf(ms));
        expect(start.getTime()).toBeLessThanOrEqual(ms);
        expect(ms).toBeLessThan(end.getTime());
        expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
      }),
    );
  });

  // The code uses the fixed +05:30 offset; the tz database is only an oracle here, when present.
  const kolkata = (() => {
    try {
      const format = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      return format.format(at("2026-10-31T18:30:00Z")) === "2026-11-01" ? format : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(kolkata === null)("agrees with the Asia/Kolkata tz database (oracle)", () => {
    fc.assert(
      fc.property(instant, (ms) => {
        expect(businessDateOf(ms)).toBe(kolkata?.format(ms));
      }),
      { numRuns: 2000 },
    );
  });

  it("uses +05:30", () => {
    expect(IST_OFFSET_MINUTES).toBe(330);
  });
});

describe("istStartOfDay() / istDayRange()", () => {
  it("starts at 18:30 UTC the day before", () => {
    expect(istStartOfDay(businessDate("2026-11-01")).toISOString()).toBe(
      "2026-10-31T18:30:00.000Z",
    );
    expect(istDayRange(businessDate("2026-10-12"))).toEqual({
      start: at("2026-10-11T18:30:00.000Z"),
      end: at("2026-10-12T18:30:00.000Z"),
    });
  });
});

describe("validation", () => {
  it.each(["2026-10-12", "2028-02-29", "1000-01-01", "9999-12-31"])("accepts %s", (value) => {
    expect(isBusinessDate(value)).toBe(true);
    expect(parseBusinessDate(value)).toEqual({ ok: true, value });
  });

  it.each([
    "2026-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-10-32",
    "2026-9-1",
    "26-10-12",
    "2026-10-12T00:00:00Z",
    "0999-12-31",
    "",
  ])("refuses %j", (value) => {
    expect(isBusinessDate(value)).toBe(false);
    const result = parseBusinessDate(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    expect(() => businessDate(value)).toThrow(RangeError);
  });

  it("isBusinessDate refuses non-strings", () => {
    expect(isBusinessDate(20261012)).toBe(false);
    expect(isBusinessDate(null)).toBe(false);
  });

  it("knows month lengths and leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("round-trips parts (property)", () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        expect(businessDateFromParts(dateParts(date))).toBe(date);
      }),
    );
  });
});

describe("addDays() / compareBusinessDates()", () => {
  it("crosses month and year ends", () => {
    expect(addDays(businessDate("2026-10-31"), 1)).toBe("2026-11-01");
    expect(addDays(businessDate("2026-01-01"), -1)).toBe("2025-12-31");
    expect(addDays(businessDate("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addDays(businessDate("2026-10-12"), 0)).toBe("2026-10-12");
    expect(() => addDays(businessDate("2026-10-12"), 0.5)).toThrow(RangeError);
  });

  it("is invertible and ordered (property)", () => {
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -3000, max: 3000 }), (date, days) => {
        const moved = addDays(date, days);
        expect(addDays(moved, -days)).toBe(date);
        expect(compareBusinessDates(date, moved)).toBe(days === 0 ? 0 : days > 0 ? -1 : 1);
      }),
    );
  });

  it("sorts ascending", () => {
    const dates: BusinessDate[] = ["2026-10-12", "2025-12-31", "2026-01-01"].map(businessDate);
    expect(dates.sort(compareBusinessDates)).toEqual(["2025-12-31", "2026-01-01", "2026-10-12"]);
  });
});

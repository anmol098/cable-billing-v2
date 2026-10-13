import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, businessDate, businessDateFromParts, daysInMonth } from "./business-date";
import {
  addPeriods,
  comparePeriods,
  isBillingDay,
  isPeriod,
  monthsBetween,
  nextPeriod,
  type Period,
  parsePeriod,
  period,
  periodContains,
  periodEnd,
  periodFromYearMonth,
  periodOf,
  periodOfInstant,
  periodsBetween,
  previousPeriod,
  yymm,
} from "./period";

const anyPeriod = fc
  .record({ year: fc.integer({ min: 1970, max: 2099 }), month: fc.integer({ min: 1, max: 12 }) })
  .map(({ year, month }) => periodFromYearMonth(year, month));

const anyDate = fc
  .record({
    year: fc.integer({ min: 1970, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, day }) =>
    businessDateFromParts({ year, month, day: Math.min(day, daysInMonth(year, month)) }),
  );

describe("periodOf()", () => {
  it.each([
    ["2026-10-01", "2026-10-01"],
    ["2026-10-12", "2026-10-01"],
    ["2026-10-31", "2026-10-01"],
    ["2028-02-29", "2028-02-01"],
  ])("%s → %s", (date, expected) => {
    expect(periodOf(businessDate(date))).toBe(expected);
  });

  it("uses the IST date of an instant", () => {
    expect(periodOfInstant(new Date("2026-10-31T18:29:59.999Z"))).toBe("2026-10-01");
    expect(periodOfInstant(new Date("2026-10-31T18:30:00.000Z"))).toBe("2026-11-01");
    expect(periodOfInstant(new Date("2026-12-31T18:45:00.000Z"))).toBe("2027-01-01");
  });

  it("is the 1st, idempotent, and contains the date (property)", () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        const p = periodOf(date);
        expect(isPeriod(p)).toBe(true);
        expect(periodOf(p)).toBe(p);
        expect(periodContains(p, date)).toBe(true);
        expect(p <= date && date <= periodEnd(p)).toBe(true);
      }),
    );
  });
});

describe("nextPeriod() / previousPeriod() / addPeriods()", () => {
  it("crosses year ends", () => {
    expect(nextPeriod(period("2026-12-01"))).toBe("2027-01-01");
    expect(previousPeriod(period("2027-01-01"))).toBe("2026-12-01");
    expect(addPeriods(period("2026-10-01"), 15)).toBe("2028-01-01");
    expect(addPeriods(period("2026-10-01"), -22)).toBe("2024-12-01");
    expect(() => addPeriods(period("2026-10-01"), 1.5)).toThrow(RangeError);
  });

  it("next is the day after the period's last day, and inverts (property)", () => {
    fc.assert(
      fc.property(anyPeriod, (p) => {
        expect(nextPeriod(p)).toBe(addDays(periodEnd(p), 1));
        expect(previousPeriod(nextPeriod(p))).toBe(p);
        expect(comparePeriods(p, nextPeriod(p))).toBe(-1);
      }),
    );
    fc.assert(
      fc.property(anyPeriod, fc.integer({ min: -600, max: 600 }), (p, n) => {
        const moved = addPeriods(p, n);
        expect(monthsBetween(p, moved)).toBe(n);
        expect(addPeriods(moved, -n)).toBe(p);
      }),
    );
  });
});

describe("periodEnd()", () => {
  it.each([
    ["2026-10-01", "2026-10-31"],
    ["2026-11-01", "2026-11-30"],
    ["2026-02-01", "2026-02-28"],
    ["2028-02-01", "2028-02-29"],
  ])("%s → %s", (p, end) => {
    expect(periodEnd(period(p))).toBe(end);
  });
});

describe("parsePeriod()", () => {
  it.each([
    ["2026-10-01", "2026-10-01"],
    ["2026-10", "2026-10-01"],
  ])("accepts %s", (value, expected) => {
    expect(parsePeriod(value)).toEqual({ ok: true, value: expected });
  });

  it.each(["2026-10-12", "2026-13", "2026-13-01", "2026-1", "October 2026", ""])(
    "refuses %j",
    (value) => {
      const result = parsePeriod(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
      expect(() => period(value)).toThrow(RangeError);
      expect(isPeriod(value)).toBe(false);
    },
  );
});

describe("periodsBetween() (missed bill runs, D-25)", () => {
  it("lists every period, both ends included, oldest first", () => {
    expect(periodsBetween(period("2026-11-01"), period("2027-02-01"))).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
    ]);
    expect(periodsBetween(period("2026-10-01"), period("2026-10-01"))).toEqual(["2026-10-01"]);
    expect(periodsBetween(period("2026-10-01"), period("2026-09-01"))).toEqual([]);
  });

  it("refuses unbounded ranges", () => {
    expect(() => periodsBetween(period("1900-01-01"), period("2026-10-01"))).toThrow(RangeError);
    expect(periodsBetween(period("2026-01-01"), period("2026-12-01"), 12)).toHaveLength(12);
  });

  it("has monthsBetween + 1 consecutive periods (property)", () => {
    fc.assert(
      fc.property(anyPeriod, fc.integer({ min: 0, max: 120 }), (from, n) => {
        const list: Period[] = periodsBetween(from, addPeriods(from, n));
        expect(list).toHaveLength(n + 1);
        list.slice(1).forEach((p, i) => {
          expect(p).toBe(nextPeriod(list[i] ?? from));
        });
      }),
    );
  });
});

describe("billing day", () => {
  it("is the 1st of the month", () => {
    expect(isBillingDay(businessDate("2026-11-01"))).toBe(true);
    expect(isBillingDay(businessDate("2026-11-02"))).toBe(false);
    expect(isBillingDay(businessDate("2026-10-31"))).toBe(false);
  });

  it("is the scheduler's IST date at 00:15 IST on the 1st", () => {
    // `45 18 * * *` UTC on 31 Oct is 00:15 IST on 1 Nov.
    expect(isBillingDay(periodOfInstant(new Date("2026-10-31T18:45:00Z")))).toBe(true);
  });
});

describe("yymm()", () => {
  it("gives the document-number month (PLAN §7.3)", () => {
    expect(yymm(period("2026-10-01"))).toBe("2610");
    expect(yymm(businessDate("2030-01-15"))).toBe("3001");
    expect(yymm(businessDate("2100-12-31"))).toBe("0012");
  });
});

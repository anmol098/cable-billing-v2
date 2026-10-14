/** The day range of the day-based operations reports (T-081). Pure. */
import { businessDate } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { daysInRange, REPORT_MAX_DAYS, resolveDayRange } from "./range";

/** 2 Nov 2026, 00:10 IST (still 1 Nov in UTC). */
const JUST_AFTER_MIDNIGHT = new Date("2026-11-02T00:10:00+05:30");
const d = businessDate;

describe("resolveDayRange", () => {
  it("defaults to today (IST), or the last N days up to `to`", () => {
    expect(resolveDayRange(JUST_AFTER_MIDNIGHT, {})).toEqual({
      ok: true,
      value: { from: "2026-11-02", to: "2026-11-02" },
    });
    expect(resolveDayRange(JUST_AFTER_MIDNIGHT, {}, 7)).toEqual({
      ok: true,
      value: { from: "2026-10-27", to: "2026-11-02" },
    });
    expect(resolveDayRange(JUST_AFTER_MIDNIGHT, { to: d("2026-10-31") })).toEqual({
      ok: true,
      value: { from: "2026-10-31", to: "2026-10-31" },
    });
    expect(resolveDayRange(JUST_AFTER_MIDNIGHT, { from: d("2026-10-03") })).toEqual({
      ok: true,
      value: { from: "2026-10-03", to: "2026-11-02" },
    });
  });

  it("refuses future days, a backwards range and more than 31 days", () => {
    const fields = (input: Parameters<typeof resolveDayRange>[1]) => {
      const result = resolveDayRange(JUST_AFTER_MIDNIGHT, input);
      return result.ok ? [] : result.error.details?.fields;
    };
    expect(fields({ from: d("2026-11-01"), to: d("2026-11-03") })).toEqual([
      { path: "to", code: "future" },
    ]);
    expect(fields({ from: d("2026-11-03"), to: d("2026-11-03") })).toEqual([
      { path: "from", code: "future" },
      { path: "to", code: "future" },
    ]);
    expect(fields({ from: d("2026-11-02"), to: d("2026-11-01") })).toEqual([
      { path: "to", code: "before_from" },
    ]);
    expect(fields({ from: d("2026-10-02"), to: d("2026-11-01") })).toEqual([]);
    expect(fields({ from: d("2026-10-01"), to: d("2026-11-01") })).toEqual([
      { path: "to", code: "too_many_days" },
    ]);
  });

  it("counts days across months and years", () => {
    expect(daysInRange(d("2026-10-01"), d("2026-10-31"))).toBe(REPORT_MAX_DAYS);
    expect(daysInRange(d("2026-12-31"), d("2027-01-01"))).toBe(2);
    expect(daysInRange(d("2028-02-28"), d("2028-03-01"))).toBe(3);
    expect(daysInRange(d("2026-11-02"), d("2026-11-02"))).toBe(1);
  });
});

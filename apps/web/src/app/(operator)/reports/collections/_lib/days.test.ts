import { businessDate } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { dayCount, MAX_DAYS, paymentsReportHref, pickDays } from "./days";

const today = businessDate("2026-11-02");

describe("pickDays", () => {
  it("defaults to today, or the last N days", () => {
    expect(pickDays(undefined, undefined, today)).toEqual({
      from: "2026-11-02",
      to: "2026-11-02",
      bad: false,
    });
    expect(pickDays(undefined, undefined, today, 7)).toEqual({
      from: "2026-10-27",
      to: "2026-11-02",
      bad: false,
    });
  });

  it("takes real days up to today, at most 31", () => {
    expect(pickDays("2026-10-03", "2026-11-02", today)).toEqual({
      from: "2026-10-03",
      to: "2026-11-02",
      bad: false,
    });
    expect(pickDays(["2026-10-31", "x"], undefined, today)).toEqual({
      from: "2026-10-31",
      to: "2026-11-02",
      bad: false,
    });
    expect(pickDays(undefined, "2026-10-31", today)).toEqual({
      from: "2026-10-31",
      to: "2026-10-31",
      bad: false,
    });
  });

  it("falls back to the default and says so for days the report would refuse", () => {
    const fallback = { from: "2026-11-02", to: "2026-11-02", bad: true };
    expect(pickDays("2026-10-02", "2026-11-02", today)).toEqual(fallback); // 32 days
    expect(pickDays("2026-11-01", "2026-11-03", today)).toEqual(fallback); // after today
    expect(pickDays("2026-11-02", "2026-11-01", today)).toEqual(fallback); // backwards
    expect(pickDays("2026-02-30", undefined, today)).toEqual(fallback); // not a day
    expect(pickDays(undefined, "soon", today)).toEqual(fallback);
  });

  it("counts days and builds the payments link", () => {
    expect(dayCount(businessDate("2026-10-01"), businessDate("2026-10-31"))).toBe(MAX_DAYS);
    expect(dayCount(businessDate("2026-12-31"), businessDate("2027-01-01"))).toBe(2);
    expect(
      paymentsReportHref(
        businessDate("2026-10-31"),
        businessDate("2026-10-31"),
        "0190a000-0000-7000-8000-00000000000a",
      ),
    ).toBe(
      "/reports/payments?from=2026-10-31&to=2026-10-31&collector=0190a000-0000-7000-8000-00000000000a",
    );
    expect(paymentsReportHref(businessDate("2026-10-01"), businessDate("2026-10-31"), null)).toBe(
      "/reports/payments?from=2026-10-01&to=2026-10-31",
    );
  });
});

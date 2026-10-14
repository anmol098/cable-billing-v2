import { businessDate } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { daysBetween, subscriptionSummary } from "./rules";

const TODAY = businessDate("2026-10-14");

describe("daysBetween", () => {
  it("counts IST calendar days, across months and years, negative backwards", () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0);
    expect(daysBetween(TODAY, businessDate("2026-10-15"))).toBe(1);
    expect(daysBetween(TODAY, businessDate("2026-11-13"))).toBe(30);
    expect(daysBetween(businessDate("2026-12-31"), businessDate("2027-01-01"))).toBe(1);
    expect(daysBetween(businessDate("2028-02-28"), businessDate("2028-03-01"))).toBe(2);
    expect(daysBetween(TODAY, businessDate("2026-10-10"))).toBe(-4);
  });
});

describe("subscriptionSummary", () => {
  it("trial: the IST end day and days left (an instant late in the IST day is that day)", () => {
    // 20 Oct 2026 23:00 IST = 20 Oct 17:30 UTC.
    const trialEndsAt = new Date("2026-10-20T17:30:00Z");
    expect(
      subscriptionSummary({ status: "trialing", trialEndsAt, graceEndsAt: null }, TODAY),
    ).toEqual({
      status: "trialing",
      mode: "normal",
      trialEndsOn: "2026-10-20",
      trialDaysLeft: 6,
      graceEndsOn: null,
    });
    // 21 Oct 2026 00:30 IST is already the 21st in India, though still the 20th in UTC.
    const lateUtc = new Date("2026-10-20T19:00:00Z");
    expect(
      subscriptionSummary({ status: "trialing", trialEndsAt: lateUtc, graceEndsAt: null }, TODAY)
        .trialEndsOn,
    ).toBe("2026-10-21");
  });

  it("a trial that ended but was not moved on yet ends today (never negative)", () => {
    const summary = subscriptionSummary(
      { status: "trialing", trialEndsAt: new Date("2026-10-01T06:00:00Z"), graceEndsAt: null },
      TODAY,
    );
    expect(summary.trialDaysLeft).toBe(0);
  });

  it("grace has its end day; read-only, cancelled and no row are read-only", () => {
    const graceEndsAt = new Date("2026-10-25T06:30:00Z");
    expect(
      subscriptionSummary({ status: "grace", trialEndsAt: graceEndsAt, graceEndsAt }, TODAY),
    ).toEqual({
      status: "grace",
      mode: "normal",
      trialEndsOn: null,
      trialDaysLeft: null,
      graceEndsOn: "2026-10-25",
    });
    for (const status of ["read_only", "cancelled"] as const) {
      expect(
        subscriptionSummary({ status, trialEndsAt: null, graceEndsAt: null }, TODAY).mode,
      ).toBe("read_only");
    }
    expect(subscriptionSummary(null, TODAY)).toEqual({
      status: null,
      mode: "read_only",
      trialEndsOn: null,
      trialDaysLeft: null,
      graceEndsOn: null,
    });
    expect(
      subscriptionSummary({ status: "active", trialEndsAt: null, graceEndsAt: null }, TODAY).mode,
    ).toBe("normal");
  });
});

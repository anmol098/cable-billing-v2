/** Pure connection rules (T-034): transitions, effect months, date rules, stored reasons. */
import { businessDate, period } from "@cb/domain";
import { describe, expect, it } from "vitest";
import {
  allowedActions,
  billedFrom,
  CONNECTION_ACTIONS,
  changeDateProblem,
  earliestAllowedDate,
  eventTypeOf,
  formatStopReason,
  isMidMonth,
  latestStartDate,
  nextStatus,
  parseStopReason,
  reachesBilledPeriod,
  rentStopsFrom,
  startDateProblem,
} from "./rules";

const d = businessDate;

describe("transitions (FR-006)", () => {
  it.each([
    ["active", "suspend", "suspended"],
    ["active", "reactivate", null],
    ["active", "disconnect", "disconnected"],
    ["active", "change_plan", "active"],
    ["suspended", "suspend", null],
    ["suspended", "reactivate", "active"],
    ["suspended", "disconnect", "disconnected"],
    ["suspended", "change_plan", "suspended"],
    ["disconnected", "suspend", null],
    ["disconnected", "reactivate", null],
    ["disconnected", "disconnect", null],
    ["disconnected", "change_plan", null],
  ] as const)("%s + %s → %s", (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it("lists the allowed actions; a removed connection has none", () => {
    expect(allowedActions("active")).toEqual(["suspend", "disconnect", "change_plan"]);
    expect(allowedActions("suspended")).toEqual(["reactivate", "disconnect", "change_plan"]);
    expect(allowedActions("disconnected")).toEqual([]);
  });

  it("maps every action to its event type", () => {
    expect(CONNECTION_ACTIONS.map(eventTypeOf)).toEqual([
      "suspended",
      "reactivated",
      "disconnected",
      "plan_changed",
    ]);
  });
});

describe("effect months (PLAN §8.1, §8.3)", () => {
  it("rent stops from the month after the effective day's month", () => {
    expect(rentStopsFrom(d("2026-10-20"))).toBe("2026-11-01");
    expect(rentStopsFrom(d("2026-10-31"))).toBe("2026-11-01");
    // Disconnected effective 1 Nov: active during 1 Nov, so November is still charged.
    expect(rentStopsFrom(d("2026-11-01"))).toBe("2026-12-01");
    expect(rentStopsFrom(d("2026-12-15"))).toBe("2027-01-01");
  });

  it("a start on the 1st is billed that month; any other start (and any reactivation) next month", () => {
    expect(billedFrom("start", d("2026-11-01"))).toBe("2026-11-01");
    expect(billedFrom("start", d("2026-11-02"))).toBe("2026-12-01");
    expect(billedFrom("reactivate", d("2026-11-01"))).toBe("2026-12-01");
    expect(billedFrom("reactivate", d("2026-10-31"))).toBe("2026-11-01");
    expect(isMidMonth("start", d("2026-11-01"))).toBe(false);
    expect(isMidMonth("start", d("2026-11-13"))).toBe(true);
    expect(isMidMonth("reactivate", d("2026-11-01"))).toBe(true);
  });
});

describe("back-dating into a billed month", () => {
  const oct = period("2026-10-01");

  it("never billed: any date", () => {
    expect(reachesBilledPeriod(d("2020-01-01"), null)).toBe(false);
    expect(earliestAllowedDate(null)).toBeNull();
  });

  it("a date in the latest billed month or later is fine (that month is the hook's)", () => {
    expect(reachesBilledPeriod(d("2026-10-01"), oct)).toBe(false);
    expect(reachesBilledPeriod(d("2026-10-31"), oct)).toBe(false);
    expect(reachesBilledPeriod(d("2026-11-05"), oct)).toBe(false);
  });

  it("a date in an earlier month would change the billed month", () => {
    expect(reachesBilledPeriod(d("2026-09-30"), oct)).toBe(true);
    expect(reachesBilledPeriod(d("2026-01-15"), oct)).toBe(true);
    expect(earliestAllowedDate(oct)).toBe("2026-10-01");
  });
});

describe("date rules", () => {
  const base = {
    today: d("2026-10-13"),
    startDate: d("2026-09-05"),
    lastChangeDate: d("2026-10-02"),
  };

  it.each([
    ["2026-10-13", null],
    ["2026-10-02", null],
    ["2026-10-14", "in_future"],
    ["2026-09-04", "before_start"],
    ["2026-10-01", "before_last_change"],
    ["1999-12-31", "too_old"],
  ] as const)("a change on %s → %s", (date, problem) => {
    expect(changeDateProblem({ ...base, date: d(date) })).toBe(problem);
  });

  it.each([
    ["2026-10-13", null],
    ["2026-10-14", null],
    ["2026-10-15", "in_future"],
    ["2001-01-01", null],
    ["1999-12-31", "too_old"],
  ] as const)("a start on %s → %s", (date, problem) => {
    expect(startDateProblem({ date: d(date), today: d("2026-10-13") })).toBe(problem);
  });

  it("the latest start is tomorrow (across a month end too)", () => {
    expect(latestStartDate(d("2026-10-31"))).toBe("2026-11-01");
  });
});

describe("stored reasons", () => {
  it("round-trips a code and a code with a note", () => {
    expect(formatStopReason("moved_away")).toBe("moved_away");
    expect(formatStopReason("other", "  shop closed  ")).toBe("other: shop closed");
    expect(parseStopReason("moved_away")).toEqual({ code: "moved_away", note: null });
    expect(parseStopReason("other: shop closed")).toEqual({ code: "other", note: "shop closed" });
  });

  it("keeps free text (migrated rows) as a note", () => {
    expect(parseStopReason("Customer shifted to DTH")).toEqual({
      code: null,
      note: "Customer shifted to DTH",
    });
    expect(parseStopReason("unknown_code")).toEqual({ code: null, note: "unknown_code" });
    expect(parseStopReason(null)).toBeNull();
    expect(parseStopReason("  ")).toBeNull();
  });
});

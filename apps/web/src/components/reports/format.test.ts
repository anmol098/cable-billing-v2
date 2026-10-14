import { businessDate, period } from "@cb/domain";
import { describe, expect, it } from "vitest";
import {
  asOfText,
  duesHref,
  monthOptions,
  pickId,
  pickMonthRange,
  pickOption,
  pickPage,
  pickPastDate,
  query,
} from "./format";
import { reportsT } from "./test-fixtures";

const NOV = period("2026-11-01");

describe("report params", () => {
  it("takes a UUID area, a known option and a sane page", () => {
    expect(pickId("0193A000-0000-7000-8000-0000000000F1")).toBe(
      "0193a000-0000-7000-8000-0000000000f1",
    );
    expect(pickId("north")).toBeUndefined();
    expect(pickId(["0193a000-0000-7000-8000-0000000000f1", "x"])).toBe(
      "0193a000-0000-7000-8000-0000000000f1",
    );
    expect(pickOption("advance", ["due", "advance"] as const)).toBe("advance");
    expect(pickOption("other", ["due", "advance"] as const)).toBeUndefined();
    expect(pickPage(undefined)).toBe(1);
    expect(pickPage("3")).toBe(3);
    expect(pickPage("-2")).toBe(1);
    expect(pickPage("abc")).toBe(1);
    expect(pickPage("999999")).toBe(10_000);
  });

  it("takes only a real past day; today or later means now", () => {
    const today = businessDate("2026-11-02");
    expect(pickPastDate("2026-10-31", today)).toBe("2026-10-31");
    expect(pickPastDate("2026-11-02", today)).toBeUndefined();
    expect(pickPastDate("2026-11-05", today)).toBeUndefined();
    expect(pickPastDate("2026-02-30", today)).toBeUndefined();
    expect(pickPastDate(undefined, today)).toBeUndefined();
  });

  it("takes a month range of up to 12 months, else falls back", () => {
    expect(pickMonthRange(undefined, undefined, NOV)).toEqual({
      from: "2026-09-01",
      to: NOV,
      fixed: false,
    });
    expect(pickMonthRange("2026-01-01", "2026-06-01", NOV)).toEqual({
      from: "2026-01-01",
      to: "2026-06-01",
      fixed: false,
    });
    expect(pickMonthRange("2025-12-01", "2026-11-01", NOV)).toEqual({
      from: "2025-12-01",
      to: NOV,
      fixed: false,
    });
    for (const [from, to] of [
      ["2025-11-01", "2026-11-01"],
      ["2026-06-01", "2026-01-01"],
      ["2026-10-01", "2026-12-01"],
    ]) {
      expect(pickMonthRange(from, to, NOV)).toEqual({ from: NOV, to: NOV, fixed: true });
    }
    expect(pickMonthRange("2026-10-05", "2026-11-01", NOV).fixed).toBe(true);
  });

  it("lists 36 months back from this month", () => {
    const months = monthOptions(NOV);
    expect(months).toHaveLength(36);
    expect(months[0]).toBe(NOV);
    expect(months.at(-1)).toBe("2023-12-01");
  });

  it("builds links without empty or default values", () => {
    expect(query({ a: "1", b: undefined, c: "", page: 1 })).toBe("?a=1");
    expect(query({ page: 2 })).toBe("?page=2");
    expect(query({})).toBe("");
    expect(duesHref({})).toBe("/reports/dues");
    expect(duesHref({ date: "2026-10-31", area: "x", age: "d90_plus", page: 2 })).toBe(
      "/reports/dues?date=2026-10-31&area=x&age=d90_plus&page=2",
    );
    // The age filter belongs to the "who owes" list only.
    expect(duesHref({ show: "advance", age: "d90_plus" })).toBe("/reports/dues?show=advance");
  });
});

describe("asOfText", () => {
  it("says the time now, or the end of a past day, in IST and both languages", () => {
    const now = {
      at: new Date("2026-11-02T04:30:00.000Z"),
      date: businessDate("2026-11-02"),
      endOfDay: false,
    };
    expect(asOfText(now, "en", reportsT())).toBe("Numbers as of 2 Nov 2026, 10:00 am");
    const past = {
      at: new Date("2026-10-31T18:30:00.000Z"),
      date: businessDate("2026-10-31"),
      endOfDay: true,
    };
    expect(asOfText(past, "en", reportsT())).toBe("Numbers as of the end of 31 Oct 2026");
    expect(asOfText(past, "hi", reportsT("hi"))).toBe("31 अक्टू 2026 का दिन खत्म होने तक के आँकड़े");
  });
});

import { period } from "@cb/domain";
import { describe, expect, it } from "vitest";
import {
  billHref,
  isRunInProgress,
  istDate,
  istDateTime,
  lineKey,
  monthNeighbours,
  monthText,
  pickMonth,
  pickYear,
  problemReasonKey,
  registerHref,
  runsHref,
  rupees,
  yearPeriods,
} from "./format";
import { runErrorKey } from "./run-result";

const NOV = period("2026-11-01");
const SEP = period("2026-09-01");

describe("bills format helpers", () => {
  it("formats rupees, months and IST instants", () => {
    expect(rupees(12_345_600)).toBe("1,23,456");
    expect(monthText(NOV, "en")).toBe("November 2026");
    expect(monthText(NOV, "hi")).toBe("नवंबर 2026");
    // 31 Oct 2026 20:00 UTC is 1 Nov 2026 01:30 IST.
    const at = new Date("2026-10-31T20:00:00Z");
    expect(istDate(at, "en")).toBe("1 Nov 2026");
    expect(istDateTime(at, "en")).toMatch(/^1 Nov 2026, 1:30\s?am$/i);
  });

  it("picks the month from ?month=, inside the tenant's months", () => {
    expect(pickMonth(undefined, NOV, SEP)).toBe(NOV);
    expect(pickMonth("2026-10-01", NOV, SEP)).toBe("2026-10-01");
    expect(pickMonth(["2026-10-01", "x"], NOV, SEP)).toBe("2026-10-01");
    expect(pickMonth("2027-01-01", NOV, SEP)).toBe(NOV);
    expect(pickMonth("2026-01-01", NOV, SEP)).toBe(SEP);
    expect(pickMonth("2026-10-15", NOV, SEP)).toBe(NOV);
    expect(pickMonth("nonsense", NOV, SEP)).toBe(NOV);
  });

  it("picks the calendar year and its months", () => {
    expect(pickYear(undefined, NOV)).toBe(2026);
    expect(pickYear("2025", NOV)).toBe(2025);
    expect(pickYear("2027", NOV)).toBe(2026);
    expect(pickYear("19", NOV)).toBe(2026);
    expect(yearPeriods(2026)).toEqual({ from: "2026-01-01", to: "2026-12-01" });
  });

  it("links neighbour months only inside [first, current]", () => {
    expect(monthNeighbours(NOV, NOV, SEP)).toEqual({ previous: "2026-10-01", next: null });
    expect(monthNeighbours(SEP, NOV, SEP)).toEqual({ previous: null, next: "2026-10-01" });
  });

  it("builds the Bills URLs", () => {
    expect(runsHref(NOV)).toBe("/bills/runs?month=2026-11-01");
    expect(runsHref(NOV, { preview: true })).toBe("/bills/runs?month=2026-11-01&preview=1");
    expect(registerHref(NOV)).toBe("/bills/register?month=2026-11-01");
    expect(registerHref(NOV, { areaId: "a1", payState: "unpaid", page: 2 })).toBe(
      "/bills/register?month=2026-11-01&area=a1&paid=unpaid&page=2",
    );
    expect(billHref("b1")).toBe("/bills/b1");
  });

  it("names run states, problem reasons and lines", () => {
    expect(isRunInProgress("pending")).toBe(true);
    expect(isRunInProgress("running")).toBe(true);
    expect(isRunInProgress("completed")).toBe(false);
    expect(isRunInProgress("none")).toBe(false);
    expect(problemReasonKey("balance_mismatch")).toBe("books");
    expect(problemReasonKey("credit_mismatch")).toBe("books");
    expect(problemReasonKey("event_before_start")).toBe("connection");
    expect(problemReasonKey("internal_error")).toBe("other");
    expect(lineKey({ type: "rent", adjustment: null })).toBe("rent");
    expect(lineKey({ type: "adjustment", adjustment: { source: "plan_change" } })).toBe(
      "plan_change",
    );
  });

  it("maps service errors to the words the Owner sees", () => {
    expect(runErrorKey({ code: "FORBIDDEN" })).toBe("forbidden");
    expect(runErrorKey({ code: "TENANT_READ_ONLY" })).toBe("read_only");
    expect(runErrorKey({ code: "VALIDATION" })).toBe("period");
    expect(runErrorKey({ code: "NOT_FOUND" })).toBe("not_found");
    expect(runErrorKey({ code: "CONFLICT", details: { reason: "run_skipped" } })).toBe(
      "run_skipped",
    );
    expect(runErrorKey({ code: "CONFLICT" })).toBe("generic");
    expect(runErrorKey({ code: "INTERNAL" })).toBe("generic");
  });
});

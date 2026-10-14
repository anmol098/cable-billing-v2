/** The ageing rule and the as-of moment (T-080), pure. */
import { businessDate, period } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { ageingBucket, ageingBucketOfDays, billAgeInDays, spreadDue } from "./ageing";
import { resolveAsOf } from "./as-of";

const d = businessDate;
const p = period;

describe("billAgeInDays / ageingBucket", () => {
  it("counts days from the 1st of the bill's month to the as-of date", () => {
    expect(billAgeInDays(p("2026-10-01"), d("2026-10-01"))).toBe(0);
    expect(billAgeInDays(p("2026-10-01"), d("2026-10-14"))).toBe(13);
    expect(billAgeInDays(p("2026-09-01"), d("2026-10-14"))).toBe(43);
    expect(billAgeInDays(p("2026-11-01"), d("2026-10-14"))).toBe(-18);
    // Across a year and February.
    expect(billAgeInDays(p("2027-02-01"), d("2027-03-01"))).toBe(28);
    expect(billAgeInDays(p("2028-02-01"), d("2028-03-01"))).toBe(29);
    expect(billAgeInDays(p("2026-12-01"), d("2027-01-01"))).toBe(31);
  });

  it("puts 0–30, 31–60, 61–90 and 91+ days in the four buckets", () => {
    expect(ageingBucketOfDays(-5)).toBe("d0_30");
    expect(ageingBucketOfDays(0)).toBe("d0_30");
    expect(ageingBucketOfDays(30)).toBe("d0_30");
    expect(ageingBucketOfDays(31)).toBe("d31_60");
    expect(ageingBucketOfDays(60)).toBe("d31_60");
    expect(ageingBucketOfDays(61)).toBe("d61_90");
    expect(ageingBucketOfDays(90)).toBe("d61_90");
    expect(ageingBucketOfDays(91)).toBe("d90_plus");
    expect(ageingBucketOfDays(1000)).toBe("d90_plus");
    expect(() => ageingBucketOfDays(1.5)).toThrow(RangeError);
  });

  it("moves October's bill to 31–60 on 1 November", () => {
    expect(ageingBucket(p("2026-10-01"), d("2026-10-31"))).toBe("d0_30");
    expect(ageingBucket(p("2026-10-01"), d("2026-11-01"))).toBe("d31_60");
    expect(ageingBucket(p("2026-09-01"), d("2026-10-31"))).toBe("d31_60");
    expect(ageingBucket(p("2026-09-01"), d("2026-11-01"))).toBe("d61_90");
    expect(ageingBucket(p("2026-08-01"), d("2026-10-30"))).toBe("d61_90");
    expect(ageingBucket(p("2026-08-01"), d("2026-10-31"))).toBe("d90_plus");
  });
});

describe("spreadDue", () => {
  const asOf = d("2026-11-02");
  const bills = [
    { id: "a", period: p("2026-07-01"), outstandingPaise: 10_000 },
    { id: "b", period: p("2026-08-01"), outstandingPaise: 30_000 },
    { id: "c", period: p("2026-10-01"), outstandingPaise: 30_000 },
    { id: "d", period: p("2026-09-01"), outstandingPaise: 30_000 },
  ];

  it("spreads the balance over the bills from the newest back", () => {
    expect(spreadDue(100_000, bills, asOf)).toEqual({
      buckets: { d0_30: 0, d31_60: 30_000, d61_90: 30_000, d90_plus: 40_000 },
      oldestPeriod: "2026-07-01",
    });
  });

  it("treats an advance as paying the oldest bills first", () => {
    // ₹1,000 unpaid on bills, ₹450 advance: the ₹550 left is the newest part.
    expect(spreadDue(55_000, bills, asOf)).toEqual({
      buckets: { d0_30: 0, d31_60: 30_000, d61_90: 25_000, d90_plus: 0 },
      oldestPeriod: "2026-09-01",
    });
  });

  it("puts a due not on any bill in 0–30, and owes nothing for a balance ≤ 0", () => {
    expect(spreadDue(5_000, [], asOf)).toEqual({
      buckets: { d0_30: 5_000, d31_60: 0, d61_90: 0, d90_plus: 0 },
      oldestPeriod: null,
    });
    expect(spreadDue(110_000, bills, asOf).buckets.d0_30).toBe(10_000);
    expect(spreadDue(-20_000, bills, asOf)).toEqual({
      buckets: { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
      oldestPeriod: null,
    });
  });

  it("orders two bills of one month by id (newest id first)", () => {
    const twin = [
      { id: "x1", period: p("2026-06-01"), outstandingPaise: 7_000 },
      { id: "x2", period: p("2026-06-01"), outstandingPaise: 3_000 },
    ];
    expect(spreadDue(4_000, twin, asOf).buckets.d90_plus).toBe(4_000);
  });
});

describe("resolveAsOf", () => {
  // 14 Oct 2026, 23:50 IST.
  const now = new Date("2026-10-14T18:20:00.000Z");

  it("is now when no date (or today) is given", () => {
    for (const date of [undefined, d("2026-10-14")]) {
      const result = resolveAsOf(now, date);
      expect(result).toEqual({
        ok: true,
        value: {
          at: now,
          date: "2026-10-14",
          endOfDay: false,
          cutoff: new Date(now.getTime() + 1),
        },
      });
    }
  });

  it("is the end of a past IST day (the next 00:00 IST, exclusive)", () => {
    const result = resolveAsOf(now, d("2026-09-30"));
    expect(result).toEqual({
      ok: true,
      value: {
        at: new Date("2026-09-30T18:30:00.000Z"),
        date: "2026-09-30",
        endOfDay: true,
        cutoff: new Date("2026-09-30T18:30:00.000Z"),
      },
    });
  });

  it("refuses a future date, also just after midnight UTC on the IST day", () => {
    const result = resolveAsOf(now, d("2026-10-15"));
    expect(result.ok ? "ok" : result.error.code).toBe("VALIDATION");
    // 15 Oct 00:10 IST is still 14 Oct in UTC: 15 Oct is today, not the future.
    const early = new Date("2026-10-14T18:40:00.000Z");
    const today = resolveAsOf(early, d("2026-10-15"));
    expect(today.ok && today.value.endOfDay).toBe(false);
  });
});

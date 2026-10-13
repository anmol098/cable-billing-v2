/**
 * PLAN §8.1 eligibility: the rule itself, every listed consequence as a named test (quoted word for
 * word), the edge-case table from `timeline.ts`, the rental in effect for a period, and timeline
 * validation.
 */
import { describe, expect, it } from "vitest";
import { type Paise, paise } from "../money";
import { type BusinessDate, businessDate, type Period, period } from "../time";
import {
  assignmentStatusOn,
  isBillable,
  rentalForPeriod,
  validateAssignmentTimeline,
} from "./timeline";
import type { AssignmentEvent, AssignmentTimeline } from "./types";

const d = businessDate;
const SEP = period("2026-09-01");
const OCT = period("2026-10-01");
const NOV = period("2026-11-01");
const DEC = period("2026-12-01");
const JAN = period("2027-01-01");
const FEB = period("2027-02-01");

function timeline(
  startDate: string,
  events: readonly AssignmentEvent[] = [],
  endDate: string | null = null,
): AssignmentTimeline {
  return { startDate: d(startDate), endDate: endDate === null ? null : d(endDate), events };
}

function ev(
  type: "activated" | "suspended" | "reactivated" | "disconnected",
  date: string,
): AssignmentEvent {
  return { type, effectiveDate: d(date) };
}

function plan(date: string, rental: number): AssignmentEvent {
  return { type: "plan_changed", effectiveDate: d(date), rentalPaise: paise(rental) };
}

function billedPeriods(t: AssignmentTimeline, periods: readonly Period[]): Period[] {
  return periods.filter((p) => isBillable(t, p));
}

const ALL = [SEP, OCT, NOV, DEC, JAN, FEB];

describe("PLAN §8.1 rule", () => {
  it('"A VC assignment is charged its full rental for month P if it is active at any time on the 1st of P"', () => {
    // Active only during 1 Nov (starts that day, disconnected effective that day): billed for Nov.
    const oneDay = timeline("2026-11-01", [ev("disconnected", "2026-11-01")], "2026-11-01");
    expect(billedPeriods(oneDay, ALL)).toEqual([NOV]);
    // Full rental, never prorated: an assignment active on the 1st pays the whole month.
    const rental = { ...oneDay, initialRentalPaise: paise(45_000) };
    expect(rentalForPeriod(rental, NOV)).toBe(45_000);
  });

  it('"Status changes take effect at the end of their effective day"', () => {
    const t = timeline("2026-06-01", [
      ev("suspended", "2026-10-10"),
      ev("reactivated", "2026-10-20"),
    ]);
    expect(assignmentStatusOn(t, d("2026-10-09"))).toBe("active");
    expect(assignmentStatusOn(t, d("2026-10-10"))).toBe("active"); // the effective day itself
    expect(assignmentStatusOn(t, d("2026-10-11"))).toBe("suspended");
    expect(assignmentStatusOn(t, d("2026-10-20"))).toBe("suspended");
    expect(assignmentStatusOn(t, d("2026-10-21"))).toBe("active");
  });
});

describe("PLAN §8.1 consequences (each one is a test case)", () => {
  it('"Disconnected on 20 Oct, so it is charged for Oct and not for Nov onwards. Arrears remain (RULE-08)."', () => {
    const t = timeline("2026-06-15", [ev("disconnected", "2026-10-20")], "2026-10-20");
    expect(isBillable(t, OCT)).toBe(true);
    expect(billedPeriods(t, [NOV, DEC, JAN, FEB])).toEqual([]);
    // The status history is kept: it was active until the end of 20 Oct.
    expect(assignmentStatusOn(t, d("2026-10-20"))).toBe("active");
    expect(assignmentStatusOn(t, d("2026-10-21"))).toBe("disconnected");
    // "Arrears remain" is checked on the invoice in invoice.test.ts: the opening balance is carried,
    // never dropped.
  });

  it('"Disconnected effective 1 Nov: it was active during 1 Nov, so it is charged for Nov."', () => {
    const t = timeline("2026-06-15", [ev("disconnected", "2026-11-01")], "2026-11-01");
    expect(billedPeriods(t, ALL)).toEqual([SEP, OCT, NOV]);
    expect(assignmentStatusOn(t, d("2026-11-01"))).toBe("active");
    expect(assignmentStatusOn(t, d("2026-11-02"))).toBe("disconnected");
  });

  it('"Suspended on 10 Oct, so it is not charged from Nov until reactivated. The issued Oct invoice is untouched (D-14)."', () => {
    const beforeSuspension = timeline("2026-06-15");
    const suspended = timeline("2026-06-15", [ev("suspended", "2026-10-10")]);
    expect(billedPeriods(suspended, ALL)).toEqual([SEP, OCT]);
    // Oct is still billable after the suspension is recorded, so the Oct bill issued on 1 Oct agrees
    // with the timeline as it is now: nothing about Oct changes.
    expect(isBillable(beforeSuspension, OCT)).toBe(isBillable(suspended, OCT));
    // "until reactivated": reactivated on 15 Jan (mid-month) → billed again from Feb.
    const reactivated = timeline("2026-06-15", [
      ev("suspended", "2026-10-10"),
      ev("reactivated", "2027-01-15"),
    ]);
    expect(billedPeriods(reactivated, ALL)).toEqual([SEP, OCT, FEB]);
  });

  it('"Starts on the 1st before the run, so it is included in that month\'s run."', () => {
    const t = timeline("2026-11-01", [ev("activated", "2026-11-01")]);
    expect(isBillable(t, OCT)).toBe(false);
    expect(isBillable(t, NOV)).toBe(true);
    expect(isBillable(t, DEC)).toBe(true);
  });

  it('"Starts or reactivates mid-month after the run: handled by §8.3."', () => {
    // Not billed by the run for that month (the §8.3 / D-18 hook decides about it), billed from the
    // next month.
    const starts = timeline("2026-11-15");
    expect(billedPeriods(starts, ALL)).toEqual([DEC, JAN, FEB]);
    const reactivates = timeline("2026-06-15", [
      ev("suspended", "2026-09-20"),
      ev("reactivated", "2026-11-15"),
    ]);
    expect(billedPeriods(reactivates, ALL)).toEqual([SEP, DEC, JAN, FEB]);
  });
});

describe("isBillable edge cases (the table in timeline.ts)", () => {
  const cases: readonly { name: string; t: AssignmentTimeline; billed: boolean }[] = [
    { name: "starts on the 1st", t: timeline("2026-11-01"), billed: true },
    { name: "starts on the 2nd", t: timeline("2026-11-02"), billed: false },
    { name: "starts on the last day of the period", t: timeline("2026-11-30"), billed: false },
    { name: "started long before", t: timeline("2020-01-15"), billed: true },
    {
      name: "suspended effective the 1st",
      t: timeline("2026-06-01", [ev("suspended", "2026-11-01")]),
      billed: true,
    },
    {
      name: "suspended effective the last day of the previous month",
      t: timeline("2026-06-01", [ev("suspended", "2026-10-31")]),
      billed: false,
    },
    {
      name: "disconnected effective the last day of the previous month",
      t: timeline("2026-06-01", [ev("disconnected", "2026-10-31")], "2026-10-31"),
      billed: false,
    },
    {
      name: "reactivated effective the 1st (still suspended during the 1st)",
      t: timeline("2026-06-01", [ev("suspended", "2026-09-10"), ev("reactivated", "2026-11-01")]),
      billed: false,
    },
    {
      name: "reactivated effective the last day of the previous month",
      t: timeline("2026-06-01", [ev("suspended", "2026-09-10"), ev("reactivated", "2026-10-31")]),
      billed: true,
    },
    {
      name: "suspended and reactivated within the previous month",
      t: timeline("2026-06-01", [ev("suspended", "2026-10-05"), ev("reactivated", "2026-10-25")]),
      billed: true,
    },
    {
      name: "suspended and reactivated on the same day before the 1st",
      t: timeline("2026-06-01", [ev("suspended", "2026-10-05"), ev("reactivated", "2026-10-05")]),
      billed: true,
    },
    {
      name: "end date before the 1st with no disconnection event (migrated row)",
      t: timeline("2026-06-01", [], "2026-10-31"),
      billed: false,
    },
    {
      name: "end date on the 1st with no disconnection event",
      t: timeline("2026-06-01", [], "2026-11-01"),
      billed: true,
    },
    {
      name: "suspended, then disconnected while suspended, before the 1st",
      t: timeline(
        "2026-06-01",
        [ev("suspended", "2026-09-10"), ev("disconnected", "2026-10-10")],
        "2026-10-10",
      ),
      billed: false,
    },
    {
      name: "plan changes do not affect eligibility",
      t: timeline("2026-06-01", [plan("2026-10-31", 50_000), plan("2026-11-01", 0)]),
      billed: true,
    },
  ];

  it.each(cases)("$name → billed for Nov: $billed", ({ t, billed }) => {
    expect(isBillable(t, NOV)).toBe(billed);
  });

  it("does not depend on the order the events are passed in (different days)", () => {
    const events = [
      ev("suspended", "2026-07-10"),
      ev("reactivated", "2026-08-10"),
      ev("suspended", "2026-10-10"),
    ];
    const forward = timeline("2026-06-01", events);
    const backward = timeline("2026-06-01", [...events].reverse());
    for (const p of ALL) expect(isBillable(backward, p)).toBe(isBillable(forward, p));
  });

  it("says not_started before the start date", () => {
    expect(assignmentStatusOn(timeline("2026-11-15"), d("2026-11-14"))).toBe("not_started");
    expect(assignmentStatusOn(timeline("2026-11-15"), d("2026-11-15"))).toBe("active");
  });

  it("throws RangeError for a value that is not a period, or an impossible timeline", () => {
    expect(() => isBillable(timeline("2026-06-01"), d("2026-11-02") as Period)).toThrow(RangeError);
    expect(() =>
      isBillable(timeline("2026-06-01", [ev("reactivated", "2026-07-01")]), NOV),
    ).toThrow(RangeError);
  });
});

describe("rentalForPeriod (BR-07, D-14: the full new rental applies to the current month)", () => {
  const base = (events: readonly AssignmentEvent[]) => ({
    ...timeline("2026-06-01", events),
    initialRentalPaise: paise(30_000),
  });

  it("uses the initial rental when the plan never changed", () => {
    expect(rentalForPeriod(base([]), NOV)).toBe(30_000);
  });

  it("applies a change effective mid-month to that whole month and later months", () => {
    const a = base([plan("2026-11-15", 45_000)]);
    expect(rentalForPeriod(a, OCT)).toBe(30_000);
    expect(rentalForPeriod(a, NOV)).toBe(45_000);
    expect(rentalForPeriod(a, DEC)).toBe(45_000);
  });

  it("applies a change effective on the last day of a month to that month", () => {
    expect(rentalForPeriod(base([plan("2026-11-30", 45_000)]), NOV)).toBe(45_000);
    expect(rentalForPeriod(base([plan("2026-12-01", 45_000)]), NOV)).toBe(30_000);
  });

  it("ends at the latest amount after three changes in one month (PRD §15 #5)", () => {
    const a = base([
      plan("2026-11-03", 40_000),
      plan("2026-11-20", 25_000),
      plan("2026-11-10", 50_000),
    ]);
    expect(rentalForPeriod(a, NOV)).toBe(25_000);
    expect(rentalForPeriod(a, OCT)).toBe(30_000);
  });

  it("uses the recorded order for two changes effective the same day", () => {
    expect(
      rentalForPeriod(base([plan("2026-11-03", 40_000), plan("2026-11-03", 20_000)]), NOV),
    ).toBe(20_000);
  });

  it("allows a ₹0 rental and refuses a negative one", () => {
    expect(rentalForPeriod(base([plan("2026-11-03", 0)]), NOV)).toBe(0);
    expect(() => rentalForPeriod(base([plan("2026-11-03", -1)]), NOV)).toThrow(RangeError);
    expect(() =>
      rentalForPeriod({ ...timeline("2026-06-01"), initialRentalPaise: -5 as Paise }, NOV),
    ).toThrow(RangeError);
  });
});

describe("validateAssignmentTimeline", () => {
  const reasonOf = (t: AssignmentTimeline): unknown => {
    const result = validateAssignmentTimeline(t);
    return result.ok ? "ok" : result.error.details?.reason;
  };

  it.each([
    ["a plain open assignment", timeline("2026-06-01"), "ok"],
    [
      "a full history",
      timeline(
        "2026-06-01",
        [
          ev("activated", "2026-06-01"),
          ev("suspended", "2026-07-01"),
          plan("2026-07-15", 1),
          ev("reactivated", "2026-08-01"),
          ev("disconnected", "2026-09-01"),
        ],
        "2026-09-01",
      ),
      "ok",
    ],
    [
      "a disconnection event without an end date",
      timeline("2026-06-01", [ev("disconnected", "2026-09-01")]),
      "ok",
    ],
    [
      "a one-day assignment",
      timeline("2026-06-01", [ev("disconnected", "2026-06-01")], "2026-06-01"),
      "ok",
    ],
    [
      "a bad start date",
      { startDate: "2026-02-30" as BusinessDate, endDate: null, events: [] },
      "invalid_date",
    ],
    [
      "a bad end date",
      { startDate: d("2026-06-01"), endDate: "x" as BusinessDate, events: [] },
      "invalid_date",
    ],
    [
      "a bad event date",
      timeline("2026-06-01", [{ type: "suspended", effectiveDate: "2026-13-01" as BusinessDate }]),
      "invalid_date",
    ],
    ["an end before the start", timeline("2026-06-01", [], "2026-05-31"), "end_before_start"],
    [
      "an event before the start",
      timeline("2026-06-01", [ev("suspended", "2026-05-31")]),
      "event_before_start",
    ],
    [
      "an event after the end",
      timeline("2026-06-01", [ev("suspended", "2026-09-02")], "2026-09-01"),
      "event_after_end",
    ],
    [
      "an unknown event type",
      timeline("2026-06-01", [
        { type: "paused", effectiveDate: d("2026-07-01") } as unknown as AssignmentEvent,
      ]),
      "unknown_event_type",
    ],
    [
      "activated on another day",
      timeline("2026-06-01", [ev("activated", "2026-06-02")]),
      "activated_not_on_start",
    ],
    [
      "activated twice",
      timeline("2026-06-01", [ev("activated", "2026-06-01"), ev("activated", "2026-06-01")]),
      "activated_not_on_start",
    ],
    [
      "reactivating an active assignment",
      timeline("2026-06-01", [ev("reactivated", "2026-07-01")]),
      "invalid_transition",
    ],
    [
      "suspending a suspended assignment",
      timeline("2026-06-01", [ev("suspended", "2026-07-01"), ev("suspended", "2026-08-01")]),
      "invalid_transition",
    ],
    [
      "reactivating a disconnected assignment (VC reuse needs a new assignment, RULE-07)",
      timeline("2026-06-01", [ev("disconnected", "2026-07-01"), ev("reactivated", "2026-08-01")]),
      "invalid_transition",
    ],
    [
      "a plan change after the disconnection",
      timeline("2026-06-01", [ev("disconnected", "2026-07-01"), plan("2026-07-01", 5)]),
      "invalid_transition",
    ],
    [
      "an end date that differs from the disconnection",
      timeline("2026-06-01", [ev("disconnected", "2026-07-01")], "2026-07-02"),
      "end_date_mismatch",
    ],
    [
      "a negative plan rental",
      timeline("2026-06-01", [plan("2026-07-01", -100)]),
      "invalid_amount",
    ],
    [
      "a fractional plan rental",
      timeline("2026-06-01", [
        { type: "plan_changed", effectiveDate: d("2026-07-01"), rentalPaise: 1.5 as Paise },
      ]),
      "invalid_amount",
    ],
  ] as const)("%s → %s", (_name, t, expected) => {
    expect(reasonOf(t)).toBe(expected);
  });

  it("returns the timeline itself when valid", () => {
    const t = timeline("2026-06-01");
    expect(validateAssignmentTimeline(t)).toEqual({ ok: true, value: t });
  });
});

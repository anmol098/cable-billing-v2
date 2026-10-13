/** The pure handover rules (T-062): discrepancy, stored reason, phone warning boundaries. */
import { ERROR_CODES } from "@cb/contracts";
import { DISCREPANCY_REASONS } from "@cb/db";
import { businessDate } from "@cb/domain";
import { describe, expect, it } from "vitest";
import {
  HANDOVER_ERROR_CODES,
  MAX_HANDOVER_NOTE_LENGTH,
  MAX_UNSYNCED_PAYMENT_COUNT,
} from "./handover";
import {
  discrepancyOf,
  lastContactOf,
  PHONE_STALE_AFTER_MS,
  phoneMayHoldPayments,
  storedReason,
} from "./rules";

describe("handover rules", () => {
  it("discrepancy = handed − expected (negative = short)", () => {
    expect(discrepancyOf(45_000, 50_000)).toBe(-5_000);
    expect(discrepancyOf(55_000, 50_000)).toBe(5_000);
    expect(discrepancyOf(0, 0)).toBe(0);
    expect(() => discrepancyOf(Number.MAX_SAFE_INTEGER, -10)).toThrow(RangeError);
  });

  it("a reason only when the cash differs", () => {
    expect(storedReason(0, "short")).toBeNull();
    expect(storedReason(0, undefined)).toBeNull();
    expect(storedReason(-1, "short")).toBe("short");
    expect(storedReason(1, null)).toBeUndefined();
    expect(storedReason(1, undefined)).toBeUndefined();
  });

  it("last contact is the later of last seen and the handover", () => {
    const a = new Date("2026-10-13T10:00:00Z");
    const b = new Date("2026-10-13T11:00:00Z");
    expect(lastContactOf({ lastSeenAt: null, submittedAt: null })).toBeNull();
    expect(lastContactOf({ lastSeenAt: a, submittedAt: null })).toBe(a);
    expect(lastContactOf({ lastSeenAt: null, submittedAt: b })).toBe(b);
    expect(lastContactOf({ lastSeenAt: a, submittedAt: b })).toBe(b);
    expect(lastContactOf({ lastSeenAt: b, submittedAt: a })).toBe(b);
  });

  it("phone warning: stale before min(now, end of the IST day) − 30 min", () => {
    const day = businessDate("2026-10-13");
    const dayEnd = new Date("2026-10-13T18:30:00.000Z"); // 14 Oct 00:00 IST
    const check = (lastSeenAt: Date | null, now: Date) =>
      phoneMayHoldPayments({ lastSeenAt, submittedAt: null, businessDate: day, now });
    const midday = new Date("2026-10-13T06:30:00.000Z");
    expect(check(null, midday)).toBe(false);
    expect(check(new Date(midday.getTime() - PHONE_STALE_AFTER_MS), midday)).toBe(false);
    expect(check(new Date(midday.getTime() - PHONE_STALE_AFTER_MS - 1), midday)).toBe(true);
    // The day is over: compared with its end, however late it is now.
    const later = new Date("2026-10-20T06:30:00.000Z");
    expect(check(new Date(dayEnd.getTime() - PHONE_STALE_AFTER_MS), later)).toBe(false);
    expect(check(new Date(dayEnd.getTime() - PHONE_STALE_AFTER_MS - 1), later)).toBe(true);
    expect(check(new Date("2026-10-15T00:00:00Z"), later)).toBe(false);
    // The handover counts as contact.
    expect(
      phoneMayHoldPayments({
        lastSeenAt: new Date("2026-10-13T08:00:00Z"),
        submittedAt: new Date("2026-10-13T18:10:00Z"),
        businessDate: day,
        now: later,
      }),
    ).toBe(false);
  });

  it("matches the mobile contract's codes and limits", () => {
    for (const code of HANDOVER_ERROR_CODES) expect(ERROR_CODES).toContain(code);
    expect(MAX_HANDOVER_NOTE_LENGTH).toBe(500);
    expect(MAX_UNSYNCED_PAYMENT_COUNT).toBe(10_000);
    expect([...DISCREPANCY_REASONS].sort()).toEqual(["extra", "other", "pending_sync", "short"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  isRecordedAtOutOfRange,
  MAX_FUTURE_SKEW_MS,
  MAX_RECORDED_AGE_MS,
  type ReviewFacts,
  reviewReasons,
} from "./review";

const now = new Date("2026-10-13T06:00:00.000Z");
const base: ReviewFacts = {
  now,
  recordedAt: now,
  customerActive: true,
  collectorId: "u1",
  deviceId: "d1",
};
const at = (ms: number) => new Date(now.getTime() + ms);

describe("reviewReasons (PLAN §10.4)", () => {
  it("is empty for a normal payment", () => {
    expect(reviewReasons(base)).toEqual([]);
    expect(
      reviewReasons({
        ...base,
        claimedCollector: { id: "u1", status: "active" },
        claimedDeviceId: "d1",
      }),
    ).toEqual([]);
  });

  it("flags an inactive customer", () => {
    expect(reviewReasons({ ...base, customerActive: false })).toEqual(["customer_inactive"]);
  });

  it("flags a disabled or different claimed collector", () => {
    expect(reviewReasons({ ...base, claimedCollector: { id: "u2", status: "active" } })).toEqual([
      "collector_mismatch",
    ]);
    expect(reviewReasons({ ...base, claimedCollector: { id: "u2", status: "disabled" } })).toEqual([
      "collector_inactive",
      "collector_mismatch",
    ]);
    expect(reviewReasons({ ...base, claimedCollector: { id: "u9", status: "unknown" } })).toEqual([
      "collector_mismatch",
    ]);
  });

  it("flags a different claimed device", () => {
    expect(reviewReasons({ ...base, claimedDeviceId: "d2" })).toEqual(["device_mismatch"]);
    expect(reviewReasons({ ...base, claimedDeviceId: null })).toEqual([]);
  });

  it("flags recorded_at more than 10 minutes ahead or more than 7 days old (bounds allowed)", () => {
    expect(isRecordedAtOutOfRange(at(MAX_FUTURE_SKEW_MS), now)).toBe(false);
    expect(isRecordedAtOutOfRange(at(MAX_FUTURE_SKEW_MS + 1), now)).toBe(true);
    expect(isRecordedAtOutOfRange(at(-MAX_RECORDED_AGE_MS), now)).toBe(false);
    expect(isRecordedAtOutOfRange(at(-MAX_RECORDED_AGE_MS - 1), now)).toBe(true);
    expect(reviewReasons({ ...base, recordedAt: at(MAX_FUTURE_SKEW_MS + 1) })).toEqual([
      "recorded_at_out_of_range",
    ]);
  });

  it("reports every reason in a fixed order", () => {
    expect(
      reviewReasons({
        ...base,
        customerActive: false,
        claimedCollector: { id: "u2", status: "disabled" },
        claimedDeviceId: "d2",
        recordedAt: at(-MAX_RECORDED_AGE_MS - 1),
      }),
    ).toEqual([
      "customer_inactive",
      "collector_inactive",
      "collector_mismatch",
      "device_mismatch",
      "recorded_at_out_of_range",
    ]);
  });
});

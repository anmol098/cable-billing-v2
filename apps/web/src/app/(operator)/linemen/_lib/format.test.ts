import { businessDate } from "@cb/domain";
import { describe, expect, it } from "vitest";
import en from "../../../../../messages/en.json";
import hi from "../../../../../messages/hi.json";
import {
  differenceText,
  istClock,
  linemanHref,
  linemenHref,
  pickDay,
  rupees,
  type Translate,
  whenText,
} from "./format";
import { isStale, reviewErrorKey } from "./review-result";

/** A tiny translator over the generated messages (plain `{x}` placeholders only). */
function translator(messages: Record<string, unknown>): Translate {
  return (key, values = {}) => {
    const text = key.split(".").reduce<unknown>((node, part) => {
      return (node as Record<string, unknown>)[part];
    }, messages);
    if (typeof text !== "string") throw new Error(`missing ${key}`);
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
  };
}

const t = translator(en.linemen);
const th = translator(hi.linemen);
const DAY = businessDate("2026-10-13");

describe("linemen format", () => {
  it("rupees: Indian grouping without the sign; paise only when not whole", () => {
    expect(rupees(12_345_600)).toBe("1,23,456");
    expect(rupees(1_250)).toBe("12.50");
    expect(rupees(0)).toBe("0");
  });

  it("difference: match / short / extra, in both languages", () => {
    expect(differenceText(t, 0)).toBe("Cash matches");
    expect(differenceText(t, -30_000)).toBe("₹300 short");
    expect(differenceText(t, 20_000)).toBe("₹200 extra");
    expect(differenceText(th, -30_000)).toBe("₹300 कम");
    expect(differenceText(th, 20_000)).toBe("₹200 ज़्यादा");
  });

  it("times are IST: same day shows the clock, another day the date too", () => {
    const at = new Date("2026-10-13T10:35:00Z"); // 4:05 PM IST
    expect(istClock(at)).toEqual({ time: "4:05", pm: true });
    expect(istClock(new Date("2026-10-12T19:00:00Z"))).toEqual({ time: "12:30", pm: false });
    expect(whenText(t, at, DAY, "en")).toBe("4:05 PM");
    expect(whenText(t, at, businessDate("2026-10-14"), "en")).toBe("13 Oct 2026, 4:05 PM");
    expect(whenText(th, at, businessDate("2026-10-14"), "hi")).toBe("13 अक्टू 2026, 4:05 PM");
  });

  it("the day comes from ?date= but is never in the future or invalid", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(pickDay(undefined, now)).toBe("2026-10-13");
    expect(pickDay("2026-10-01", now)).toBe("2026-10-01");
    expect(pickDay(["2026-10-02", "x"], now)).toBe("2026-10-02");
    expect(pickDay("2026-10-14", now)).toBe("2026-10-13");
    expect(pickDay("2026-02-30", now)).toBe("2026-10-13");
    expect(pickDay("yesterday", now)).toBe("2026-10-13");
    // 18:30 UTC is midnight IST.
    expect(pickDay(undefined, new Date("2026-10-13T18:30:00Z"))).toBe("2026-10-14");
  });

  it("links", () => {
    expect(linemenHref(DAY, DAY)).toBe("/linemen");
    expect(linemenHref(businessDate("2026-10-12"), DAY)).toBe("/linemen?date=2026-10-12");
    expect(linemanHref("abc", DAY)).toBe("/linemen/abc?date=2026-10-13");
  });

  it("maps service errors to the office's words", () => {
    for (const reason of ["already_accepted", "already_returned", "not_submitted", "resubmitted"]) {
      const key = reviewErrorKey({ code: "CONFLICT", details: { reason } });
      expect(key).toBe(reason);
      expect(isStale(key)).toBe(true);
      expect(en.linemen.review.error).toHaveProperty(reason);
    }
    expect(reviewErrorKey({ code: "CONFLICT", details: { retryable: true } })).toBe("generic");
    expect(reviewErrorKey({ code: "TENANT_READ_ONLY" })).toBe("read_only");
    expect(
      reviewErrorKey({
        code: "VALIDATION",
        details: { fields: [{ path: "note", code: "too_small" }] },
      }),
    ).toBe("note_required");
    expect(reviewErrorKey({ code: "NOT_FOUND" })).toBe("generic");
    expect(isStale("generic")).toBe(false);
  });
});

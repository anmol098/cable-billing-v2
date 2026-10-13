import { describe, expect, it } from "vitest";
import {
  balanceText,
  newPaymentId,
  parseUndoReason,
  receiptPrintHref,
  type Translate,
  takePaymentHref,
  undoReasonText,
  undoReasonWords,
  whenText,
  withQuery,
} from "./format";
import { receiptLinkErrorKey, resolveErrorKey, takePaymentErrorKey, undoErrorKey } from "./results";

/** A translator that shows the key and its values, so the tests see what was asked for. */
const t: Translate = (key, values) =>
  values
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key;

describe("payment helpers (T-048)", () => {
  it("makes UUIDv7 payment ids from the clock, all different", () => {
    const at = Date.UTC(2026, 9, 13, 6, 0, 0);
    const ids = Array.from({ length: 200 }, () => newPaymentId(at));
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(at);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("balance words: due, credit, nothing due (Indian grouping)", () => {
    expect(balanceText(t, 12_345_600)).toBe("balance.due(amount=1,23,456)");
    expect(balanceText(t, -20_000)).toBe("balance.credit(amount=200)");
    expect(balanceText(t, 0)).toBe("balance.clear");
  });

  it("times are shown in IST, also across midnight", () => {
    // 18:40 UTC on 12 Oct = 00:10 IST on 13 Oct.
    expect(whenText(t, new Date("2026-10-12T18:40:00Z"), "en")).toBe(
      "date_time(date=13 Oct 2026,time=time_am(time=12:10))",
    );
    expect(whenText(t, new Date("2026-10-13T10:35:00Z"), "en")).toBe(
      "date_time(date=13 Oct 2026,time=time_pm(time=4:05))",
    );
  });

  it("undo reasons are stored as a code (+ note) and read back in words", () => {
    expect(undoReasonText("wrong_amount", "  typed 5000  ")).toBe("wrong_amount: typed 5000");
    expect(undoReasonText("entered_twice", " ")).toBe("entered_twice");
    expect(parseUndoReason("wrong_amount: typed 5000")).toEqual({
      reason: "wrong_amount",
      note: "typed 5000",
    });
    expect(parseUndoReason("entered_twice")).toEqual({ reason: "entered_twice", note: null });
    // Text stored another way (another channel, an older format) is kept as the note.
    expect(parseUndoReason("Counted twice")).toEqual({ reason: null, note: "Counted twice" });
    expect(undoReasonWords(t, "other: customer asked")).toBe("undo_reason.other: customer asked");
    expect(undoReasonWords(t, "Counted twice")).toBe("Counted twice");
    expect(undoReasonText("other", "x".repeat(600))).toHaveLength("other: ".length + 400);
  });

  it("URLs", () => {
    expect(receiptPrintHref("p1")).toBe("/payments/p1/receipt");
    expect(takePaymentHref("c 1")).toBe("/payments/new?customer=c%201");
    expect(takePaymentHref()).toBe("/payments/new");
    expect(withQuery("/payments", { from: "2026-10-01", to: "", page: "2" })).toBe(
      "/payments?from=2026-10-01&page=2",
    );
    expect(withQuery("/payments", { from: undefined })).toBe("/payments");
  });

  it("maps service errors to the words the office sees", () => {
    expect(takePaymentErrorKey({ code: "ID_REUSED_WITH_DIFFERENT_DATA" })).toBe(
      "already_saved_different",
    );
    expect(takePaymentErrorKey({ code: "NOT_FOUND" })).toBe("customer_not_found");
    expect(
      takePaymentErrorKey({
        code: "VALIDATION",
        details: { fields: [{ path: "upiReference", code: "too_big" }] },
      }),
    ).toBe("upi_ref");
    expect(
      takePaymentErrorKey({ code: "VALIDATION", details: { fields: [{ path: "amountPaise" }] } }),
    ).toBe("amount");
    expect(takePaymentErrorKey({ code: "CONFLICT", details: { retryable: true } })).toBe("busy");
    expect(takePaymentErrorKey({ code: "INTERNAL" })).toBe("generic");

    expect(receiptLinkErrorKey({ code: "CONFLICT", details: { reason: "too_many_links" } })).toBe(
      "too_many_links",
    );
    expect(receiptLinkErrorKey({ code: "NOT_FOUND" })).toBe("not_found");

    expect(resolveErrorKey({ code: "CONFLICT", details: { reason: "already_resolved" } })).toBe(
      "already_resolved",
    );
    expect(resolveErrorKey({ code: "TENANT_READ_ONLY" })).toBe("read_only");

    expect(undoErrorKey({ code: "CONFLICT", details: { reason: "already_reversed" } })).toBe(
      "already_cancelled",
    );
    expect(undoErrorKey({ code: "FORBIDDEN" })).toBe("forbidden");
    expect(undoErrorKey({ code: "TENANT_READ_ONLY" })).toBe("read_only");
    expect(undoErrorKey({ code: "INTERNAL" })).toBe("generic");
  });
});

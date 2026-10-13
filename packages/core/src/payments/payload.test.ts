import { describe, expect, it } from "vitest";
import { type PaymentPayload, payloadDifferences, type StoredPayload } from "./payload";

const recordedAt = new Date("2026-10-13T06:00:00.000Z");
const stored: StoredPayload = {
  customerId: "0199d6a0-0000-7000-8000-000000000001",
  amountPaise: 50_000,
  method: "upi",
  upiReference: "123456789012",
  notes: null,
  provisionalRef: "P-K7Q-0012",
  recordedAt,
};
const sent: PaymentPayload = { ...stored, recordedAt: new Date(recordedAt.getTime()) };

describe("payloadDifferences (idempotency, PLAN §8.4)", () => {
  it("finds nothing for the same payment", () => {
    expect(payloadDifferences(sent, stored)).toEqual([]);
    // UUIDs compare case-insensitively.
    expect(
      payloadDifferences({ ...sent, customerId: sent.customerId.toUpperCase() }, stored),
    ).toEqual([]);
  });

  it("ignores recorded_at when the caller did not send one", () => {
    expect(payloadDifferences({ ...sent, recordedAt: null }, stored)).toEqual([]);
  });

  it("names every differing field, never the values", () => {
    const other: PaymentPayload = {
      customerId: "0199d6a0-0000-7000-8000-000000000002",
      amountPaise: 50_100,
      method: "cash",
      upiReference: null,
      notes: "x",
      provisionalRef: "P-K7Q-0013",
      recordedAt: new Date(recordedAt.getTime() + 1),
    };
    expect(payloadDifferences(other, stored)).toEqual([
      "customerId",
      "amountPaise",
      "method",
      "upiReference",
      "notes",
      "provisionalRef",
      "recordedAt",
    ]);
  });
});

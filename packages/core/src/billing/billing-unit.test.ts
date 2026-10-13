/** Pure helpers of the billing run (T-044): invoice numbers, transient errors, job payloads. */
import { period } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { formatInvoiceNumber, isTransientDbError } from "./customer";
import { BillingRunJobPayload } from "./job";
import { BillingPeriodInput } from "./services";

describe("formatInvoiceNumber (PLAN §7.3)", () => {
  it("is {prefix}-{YYMM of the period}-{seq:05}", () => {
    expect(formatInvoiceNumber("INV", period("2026-10-01"), 123)).toBe("INV-2610-00123");
    expect(formatInvoiceNumber("CB", period("2027-01-01"), 1)).toBe("CB-2701-00001");
    expect(formatInvoiceNumber("INV", period("2026-10-01"), 123_456)).toBe("INV-2610-123456");
  });
});

describe("isTransientDbError", () => {
  const dbError = (code: string) => Object.assign(new Error("db"), { code });
  it("retries lock, serialisation and connection trouble, not data errors", () => {
    for (const code of ["40001", "40P01", "08006", "57P01"]) {
      expect(isTransientDbError(dbError(code))).toBe(true);
    }
    expect(isTransientDbError({ cause: dbError("40P01") })).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("net"), { code: "ECONNRESET" }))).toBe(true);
    for (const code of ["23505", "23514", "CB001", "42501"]) {
      expect(isTransientDbError(dbError(code))).toBe(false);
    }
    expect(isTransientDbError(new Error("bug"))).toBe(false);
  });
});

describe("inputs", () => {
  it("periods must be the 1st of a month", () => {
    expect(BillingPeriodInput.safeParse("2026-11-01").success).toBe(true);
    for (const bad of ["2026-11-02", "2026-13-01", "Nov 2026", ""]) {
      expect(BillingPeriodInput.safeParse(bad).success).toBe(false);
    }
  });
  it("the job payload carries ids and a period only", () => {
    const runId = "0199e0a4-6a3b-7c2d-8e4f-0123456789ab";
    expect(
      BillingRunJobPayload.safeParse({ runId, period: "2026-11-01", mode: "run" }).success,
    ).toBe(true);
    expect(
      BillingRunJobPayload.safeParse({ runId, period: "2026-11-15", mode: "run" }).success,
    ).toBe(false);
    expect(
      BillingRunJobPayload.safeParse({ runId, period: "2026-11-01", mode: "all" }).success,
    ).toBe(false);
  });
});

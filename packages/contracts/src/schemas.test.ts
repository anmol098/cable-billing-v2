/** Behaviour of the schemas beyond what the fixtures show: limits, refinements, brands, errors. */

import { BASE_ERROR_CODES, type BusinessDate, type Paise, type Period } from "@cb/domain";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as z from "zod";
import {
  BusinessDateSchema,
  ENDPOINT_LIST,
  ERROR_CODE_INFO,
  ERROR_CODES,
  errorCodesOf,
  HandoverRequest,
  httpStatusForError,
  isErrorCode,
  MAX_AMOUNT_PAISE,
  MOBILE_ERROR_CODES,
  PAYMENT_BATCH_MAX,
  PaymentBatchEnvelope,
  PaymentBatchItem,
  PaymentBatchRequest,
  PaymentBatchResult,
  PeriodSchema,
  PositivePaise,
  type PostedPayment,
  ReceiptActionResult,
  ReceiptActionType,
  SignedPaise,
  SyncCustomersQuery,
  Timestamp,
  Uuid,
} from "./index";

const UUID = "01929b11-2c3d-7e4f-9a05-000000000001";

const item = {
  id: UUID,
  customer_id: "01929a3e-5b10-7c4e-8a03-000000000001",
  amount_paise: 50000,
  method: "cash",
  recorded_at: "2026-10-13T01:15:00.000Z",
  provisional_ref: "P-K7Q-0012",
  collector_id: "01929a3e-5b10-7c4e-8a01-000000000002",
  device_id: "01929a3e-5b10-7c4e-8a01-000000000003",
};

describe("primitives", () => {
  it("money is a positive safe integer of paise", () => {
    expect(PositivePaise.safeParse(1).success).toBe(true);
    expect(PositivePaise.safeParse(MAX_AMOUNT_PAISE).success).toBe(true);
    for (const bad of [0, -100, 12.5, MAX_AMOUNT_PAISE + 1, Number.NaN, "500", 2 ** 53]) {
      expect(PositivePaise.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(SignedPaise.safeParse(-5000).success).toBe(true);
    expect(SignedPaise.safeParse(-0.5).success).toBe(false);
  });

  it("instants are UTC with Z only", () => {
    expect(Timestamp.safeParse("2026-10-13T05:30:00Z").success).toBe(true);
    expect(Timestamp.safeParse("2026-10-13T05:30:00.123Z").success).toBe(true);
    for (const bad of [
      "2026-10-13T11:00:00+05:30",
      "2026-10-13T05:30:00",
      "2026-10-13",
      "13/10/2026",
    ]) {
      expect(Timestamp.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("business dates are real YYYY-MM-DD dates; periods are the 1st", () => {
    expect(BusinessDateSchema.safeParse("2028-02-29").success).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-10-1", "2026-10-13T00:00:00Z"]) {
      expect(BusinessDateSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(PeriodSchema.safeParse("2026-10-01").success).toBe(true);
    expect(PeriodSchema.safeParse("2026-10-13").success).toBe(false);
    expect(PeriodSchema.safeParse("2026-10").success).toBe(false);
  });

  it("ids are UUIDs", () => {
    expect(Uuid.safeParse(UUID).success).toBe(true);
    expect(Uuid.safeParse("1045").success).toBe(false);
  });

  it("types money, dates and periods with the @cb/domain brands", () => {
    expectTypeOf<z.infer<typeof PositivePaise>>().toEqualTypeOf<Paise>();
    expectTypeOf<z.infer<typeof BusinessDateSchema>>().toEqualTypeOf<BusinessDate>();
    expectTypeOf<z.infer<typeof PeriodSchema>>().toEqualTypeOf<Period>();
    expectTypeOf<PostedPayment["amount_paise"]>().toEqualTypeOf<Paise>();
    expectTypeOf<PostedPayment["business_date"]>().toEqualTypeOf<BusinessDate>();
  });
});

describe("payment batch", () => {
  it("accepts a minimal item (optional texts omitted)", () => {
    expect(PaymentBatchItem.parse(item)).toEqual(item);
  });

  it("refuses a UPI reference on a cash payment", () => {
    const result = PaymentBatchItem.safeParse({ ...item, upi_reference: "123" });
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["upi_reference"]);
    expect(
      PaymentBatchItem.safeParse({ ...item, method: "upi", upi_reference: "123" }).success,
    ).toBe(true);
  });

  it("refuses a malformed provisional reference", () => {
    for (const bad of ["P-K7Q-12", "R-2610-00045", "P-k7q-0012"]) {
      expect(PaymentBatchItem.safeParse({ ...item, provisional_ref: bad }).success, bad).toBe(
        false,
      );
    }
  });

  it("takes 1 to 50 payments", () => {
    const many = (count: number) => ({ payments: Array.from({ length: count }, () => item) });
    expect(PaymentBatchRequest.safeParse(many(0)).success).toBe(false);
    expect(PaymentBatchRequest.safeParse(many(PAYMENT_BATCH_MAX)).success).toBe(true);
    expect(PaymentBatchRequest.safeParse(many(PAYMENT_BATCH_MAX + 1)).success).toBe(false);
  });

  it("the envelope lets a server reject one bad item without failing the batch", () => {
    const body = { payments: [item, { ...item, amount_paise: 0 }] };
    expect(PaymentBatchRequest.safeParse(body).success).toBe(false);
    const envelope = PaymentBatchEnvelope.parse(body);
    expect(envelope.payments.map((entry) => PaymentBatchItem.safeParse(entry).success)).toEqual([
      true,
      false,
    ]);
  });

  it("a result carries the payment exactly when it was saved, and an error exactly when not", () => {
    const base = { id: UUID, payment: null, review_reason: null, error: null };
    const error = { code: "INTERNAL", message: "x" };
    expect(PaymentBatchResult.safeParse({ ...base, outcome: "posted" }).success).toBe(false);
    expect(PaymentBatchResult.safeParse({ ...base, outcome: "rejected" }).success).toBe(false);
    expect(PaymentBatchResult.safeParse({ ...base, outcome: "retry_later", error }).success).toBe(
      true,
    );
    expect(
      PaymentBatchResult.safeParse({
        ...base,
        outcome: "rejected",
        error,
        review_reason: "other",
      }).success,
    ).toBe(false);
  });
});

describe("receipts", () => {
  it("records only observable actions (never sent or delivered)", () => {
    expect(ReceiptActionType.options).toEqual([
      "printed",
      "print_failed",
      "whatsapp_opened",
      "sms_opened",
      "pdf_shared",
    ]);
    for (const claim of ["sent", "delivered", "whatsapp_sent", "sms_delivered"]) {
      expect(ReceiptActionType.safeParse(claim).success, claim).toBe(false);
    }
  });

  it("an action result has an error exactly when it was not recorded", () => {
    expect(
      ReceiptActionResult.safeParse({ id: UUID, outcome: "recorded", error: null }).success,
    ).toBe(true);
    expect(
      ReceiptActionResult.safeParse({ id: UUID, outcome: "retry_later", error: null }).success,
    ).toBe(false);
  });
});

describe("other requests", () => {
  it("sync limit is 1..500, coerced from the query string", () => {
    expect(SyncCustomersQuery.parse({ limit: "200" })).toEqual({ limit: 200 });
    expect(SyncCustomersQuery.safeParse({ limit: "501" }).success).toBe(false);
    expect(SyncCustomersQuery.parse({})).toEqual({});
  });

  it("handover amounts are non-negative integer paise", () => {
    const handover = {
      submission_id: UUID,
      cash_handed_over_paise: 0,
      unsynced_payment_count: 0,
      unsynced_cash_paise: 0,
    };
    expect(HandoverRequest.safeParse(handover).success).toBe(true);
    expect(HandoverRequest.safeParse({ ...handover, cash_handed_over_paise: -1 }).success).toBe(
      false,
    );
    expect(HandoverRequest.safeParse({ ...handover, cash_handed_over_paise: 1.5 }).success).toBe(
      false,
    );
  });
});

describe("error codes", () => {
  it("extend @cb/domain's base codes without duplicates", () => {
    expect(ERROR_CODES.slice(0, BASE_ERROR_CODES.length)).toEqual([...BASE_ERROR_CODES]);
    expect(new Set(ERROR_CODES).size).toBe(BASE_ERROR_CODES.length + MOBILE_ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
  });

  it("include the codes PLAN §10.2 names", () => {
    for (const code of [
      "CUSTOMER_NOT_FOUND",
      "TENANT_READ_ONLY",
      "ID_REUSED_WITH_DIFFERENT_DATA",
      "APP_TOO_OLD",
    ]) {
      expect(isErrorCode(code), code).toBe(true);
    }
  });

  it("map to HTTP error statuses", () => {
    for (const code of ERROR_CODES) {
      const status = httpStatusForError(code);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
      expect(ERROR_CODE_INFO[code].meaning.length, code).toBeGreaterThan(10);
    }
    expect(httpStatusForError("UNAUTHENTICATED")).toBe(401);
    expect(httpStatusForError("APP_TOO_OLD")).toBe(426);
    expect(httpStatusForError("CUSTOMER_NOT_FOUND")).toBe(404);
  });

  it("every endpoint can answer validation, rate-limit and server errors", () => {
    for (const endpoint of ENDPOINT_LIST) {
      const codes = errorCodesOf(endpoint);
      expect(codes).toEqual(expect.arrayContaining(["VALIDATION", "RATE_LIMITED", "INTERNAL"]));
      expect(codes.includes("APP_TOO_OLD")).toBe(endpoint.appVersionGate);
      expect(codes.includes("UNAUTHENTICATED")).toBe(endpoint.auth === "bearer");
    }
  });
});

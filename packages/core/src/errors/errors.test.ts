import { ERROR_CODES, httpStatusForError } from "@cb/contracts";
import { BASE_ERROR_CODES } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CORE_ERROR_CODES, notFound, toServiceError, validationError } from "./errors";

const pgError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("db said no"), { code, ...extra });

describe("core error codes", () => {
  it("are the base codes plus ACCOUNT_DISABLED and INTERNAL", () => {
    expect(CORE_ERROR_CODES).toEqual([...BASE_ERROR_CODES, "ACCOUNT_DISABLED", "INTERNAL"]);
  });

  it("are all mobile-contract codes, so httpStatusForError maps every one (T-051)", () => {
    for (const code of CORE_ERROR_CODES) {
      expect(ERROR_CODES as readonly string[]).toContain(code);
    }
    expect(httpStatusForError("NOT_FOUND")).toBe(404);
    expect(httpStatusForError("TENANT_READ_ONLY")).toBe(403);
    expect(httpStatusForError("INTERNAL")).toBe(500);
  });
});

describe("toServiceError", () => {
  it("RLS WITH CHECK (writing another tenant's row) → NOT_FOUND, no details", () => {
    expect(toServiceError(pgError("42501", { constraint: "x" }))).toEqual({ code: "NOT_FOUND" });
  });

  it("FK to a missing or other-tenant row → NOT_FOUND; FK still referenced → CONFLICT", () => {
    expect(
      toServiceError(
        pgError("23503", {
          constraint: "customers_area_fk",
          detail: 'Key (operator_id, area_id)=(…) is not present in table "areas".',
        }),
      ),
    ).toEqual({ code: "NOT_FOUND" });
    expect(
      toServiceError(
        pgError("23503", {
          constraint: "customers_area_fk",
          detail: 'Key (id)=(…) is still referenced from table "customers".',
        }),
      ),
    ).toEqual({
      code: "CONFLICT",
      message: "Row is still referenced",
      details: { constraint: "customers_area_fk" },
    });
  });

  it.each([
    ["23505", "CONFLICT"],
    ["23P01", "CONFLICT"],
    ["CB001", "CONFLICT"],
    ["40001", "CONFLICT"],
    ["40P01", "CONFLICT"],
    ["23514", "VALIDATION"],
    ["23502", "VALIDATION"],
    ["22P02", "VALIDATION"],
    ["25006", "INTERNAL"],
    ["XX000", "INTERNAL"],
  ])("SQLSTATE %s → %s", (state, code) => {
    expect(toServiceError(pgError(state)).code).toBe(code);
  });

  it("follows drizzle's `cause` to the driver error", () => {
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: pgError("23505", { constraint: "areas_operator_name_unique" }),
    });
    expect(toServiceError(wrapped)).toEqual({
      code: "CONFLICT",
      message: "Unique or exclusion constraint violated",
      details: { constraint: "areas_operator_name_unique" },
    });
  });

  it("serialization failures are marked retryable", () => {
    expect(toServiceError(pgError("40001")).details).toEqual({ retryable: true });
  });

  it("anything else → INTERNAL without the original message", () => {
    const mapped = toServiceError(new TypeError("customer 9876543210 broke"));
    expect(mapped).toEqual({ code: "INTERNAL", message: "Unexpected error" });
    expect(toServiceError("boom")).toEqual({ code: "INTERNAL", message: "Unexpected error" });
  });

  it("notFound() carries nothing", () => {
    expect(notFound()).toEqual({ code: "NOT_FOUND" });
  });
});

describe("validationError", () => {
  it("lists paths and issue codes, never the submitted values", () => {
    const schema = z.object({ phone: z.string().regex(/^\d{10}$/), amount: z.number().int() });
    const parsed = schema.safeParse({ phone: "98765-SECRET", amount: 12.5 });
    if (parsed.success) throw new Error("expected failure");
    const error = validationError(parsed.error);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toEqual({
      fields: [
        { path: "phone", code: "invalid_format" },
        { path: "amount", code: "invalid_type" },
      ],
    });
    expect(JSON.stringify(error)).not.toContain("SECRET");
    expect(JSON.stringify(error)).not.toContain("12.5");
  });
});

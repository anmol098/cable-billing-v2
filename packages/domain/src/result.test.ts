import { describe, expect, expectTypeOf, it } from "vitest";
import {
  andThen,
  BASE_ERROR_CODES,
  type DomainError,
  domainError,
  err,
  isBaseErrorCode,
  isErr,
  isOk,
  mapErr,
  mapResult,
  ok,
  type Result,
  ResultError,
  unwrap,
  unwrapOr,
} from "./result";

const half = (n: number): Result<number, DomainError<"VALIDATION">> =>
  n % 2 === 0 ? ok(n / 2) : err(domainError("VALIDATION", "odd", { n }));

describe("Result", () => {
  it("narrows on ok", () => {
    const result = half(4);
    if (result.ok) expectTypeOf(result.value).toEqualTypeOf<number>();
    else expectTypeOf(result.error.code).toEqualTypeOf<"VALIDATION">();
    expect(result).toEqual({ ok: true, value: 2 });
    expect(half(3)).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "odd", details: { n: 3 } },
    });
  });

  it("has guards and combinators", () => {
    expect(isOk(half(2))).toBe(true);
    expect(isErr(half(3))).toBe(true);
    expect(mapResult(half(8), (n) => n + 1)).toEqual(ok(5));
    expect(mapResult(half(3), (n) => n + 1)).toEqual(half(3));
    expect(mapErr(half(3), (e) => e.code)).toEqual(err("VALIDATION"));
    expect(andThen(half(8), half)).toEqual(ok(2));
    expect(andThen(half(6), half).ok).toBe(false);
    expect(unwrapOr(half(3), 0)).toBe(0);
    expect(unwrap(half(10))).toBe(5);
  });

  it("unwrap throws a ResultError carrying the error", () => {
    expect(() => unwrap(half(3))).toThrow(ResultError);
    expect(() => unwrap(half(3))).toThrow(/VALIDATION/);
    expect(() => unwrap(err("too-large"))).toThrow(/too-large/);
  });

  it("omits empty optional fields", () => {
    expect(domainError("NOT_FOUND")).toEqual({ code: "NOT_FOUND" });
    expect(Object.keys(domainError("NOT_FOUND"))).toEqual(["code"]);
  });
});

describe("base error codes", () => {
  it("include the codes later layers rely on", () => {
    expect(BASE_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "VALIDATION",
        "NOT_FOUND",
        "FORBIDDEN",
        "CONFLICT",
        "TENANT_READ_ONLY",
      ]),
    );
    expect(new Set(BASE_ERROR_CODES).size).toBe(BASE_ERROR_CODES.length);
    for (const code of BASE_ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z_]*$/);
    expect(isBaseErrorCode("NOT_FOUND")).toBe(true);
    expect(isBaseErrorCode("not_found")).toBe(false);
  });
});

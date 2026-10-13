/**
 * Structured logger: JSON lines with request_id/operator_id, and **no PII**. The PII tests below
 * fail if a PII-looking field (by key or by value) can reach a log line.
 */
import { describe, expect, it } from "vitest";
import {
  createLogger,
  errorLogFields,
  type LogRecord,
  PiiInLogError,
  strictLoggingByDefault,
} from "./logger";
import { findPii, isPiiKey, piiKindOfValue, scrubText } from "./pii";

function capture(strict: boolean) {
  const records: LogRecord[] = [];
  const logger = createLogger({ sink: (r) => records.push(r), strict, level: "debug" });
  return { records, logger };
}

const REQUEST_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OPERATOR_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

describe("createLogger", () => {
  it("writes one structured record with request_id and operator_id from child()", () => {
    const { records, logger } = capture(true);
    logger
      .child({ request_id: REQUEST_ID, operator_id: OPERATOR_ID })
      .info("billing.run_started", { customer_count: 128, amount_paise: 9876543210 });
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      level: "info",
      event: "billing.run_started",
      request_id: REQUEST_ID,
      operator_id: OPERATOR_ID,
      customer_count: 128,
      amount_paise: 9876543210, // numbers are never inspected (paise can look like phones)
    });
    expect(Number.isNaN(Date.parse(String(record?.time)))).toBe(false);
  });

  it("can't overwrite time/level/event; drops undefined; filters by level", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ sink: (r) => records.push(r), strict: true, level: "info" });
    logger.debug("x.hidden");
    logger.warn("x.shown", { level: "fake", event: "fake", skipped: undefined });
    expect(records).toEqual([
      expect.objectContaining({ level: "warn", event: "x.shown" }) as unknown as LogRecord,
    ]);
    expect(records[0]).not.toHaveProperty("skipped");
  });

  it("requires dotted snake_case event names", () => {
    expect(() => capture(true).logger.info("Customer Ramesh paid")).toThrow(TypeError);
    const lenient = capture(false);
    lenient.logger.info("Customer Ramesh paid");
    expect(lenient.records[0]?.event).toBe("invalid_event_name");
  });

  it("is strict under Vitest by default", () => {
    expect(strictLoggingByDefault()).toBe(true);
  });
});

describe("no PII in logs", () => {
  const PII_FIELDS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["customer name", { customer_name: "Ramesh Kumar" }],
    ["name", { name: "Ramesh" }],
    ["camelCase phone key", { customerPhone: "x" }],
    ["phone key", { phone: "x" }],
    ["mobile", { mobile_number: "x" }],
    ["email key", { email: "x" }],
    ["login", { login: "ramesh01" }],
    ["password", { password: "x" }],
    ["token", { refresh_token: "x" }],
    ["authorization header", { Authorization: "x" }],
    ["cookie", { cookie: "x" }],
    ["address", { address: "x" }],
    ["ip", { ip: "203.0.113.7" }],
    ["user agent", { user_agent: "x" }],
    ["upi reference", { upi_reference: "x" }],
    ["notes", { notes: "x" }],
    ["nested", { payment: { customer: { phone: "x" } } }],
    ["phone in a value", { detail: "call 9876543210" }],
    ["+91 phone in a value", { detail: "+91 98765 43210" }],
    ["email in a value", { detail: "ramesh@example.com" }],
    ["jwt in a value", { detail: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc" }],
    ["bearer in a value", { detail: "Bearer abcdef0123456789" }],
    ["secret in a value", { detail: "a3f9c2e1b4d7a3f9c2e1b4d7a3f9c2e1b4d7" }],
    ["value in an array", { ids: ["ok", "ramesh@example.com"] }],
  ];

  it.each(PII_FIELDS)("strict mode throws for %s", (_label, fields) => {
    const { logger, records } = capture(true);
    expect(() => logger.info("test.event", fields)).toThrow(PiiInLogError);
    expect(records).toEqual([]);
  });

  it.each(PII_FIELDS)("production mode redacts %s and never writes the value", (_l, fields) => {
    const { logger, records } = capture(false);
    logger.info("test.event", { ...fields, kept: 1 });
    const line = JSON.stringify(records[0]);
    expect(records[0]?.pii_redacted).toBeInstanceOf(Array);
    expect(records[0]?.kept).toBe(1);
    for (const secret of ["Ramesh", "9876543210", "98765 43210", "ramesh@", "eyJ", "abcdef01"]) {
      expect(line).not.toContain(secret);
    }
  });

  it("strict child() refuses PII context too", () => {
    expect(() => capture(true).logger.child({ customer_name: "x" })).toThrow(PiiInLogError);
  });

  it("the error message lists paths, never values", () => {
    try {
      capture(true).logger.info("test.event", { detail: "ramesh@example.com" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("detail");
      expect((error as Error).message).not.toContain("ramesh");
    }
  });

  it("allows ids, codes, counts, amounts, durations and dates", () => {
    const fields = {
      request_id: "iad1::abcde-1700000000000-0123456789ab",
      operator_id: OPERATOR_ID,
      user_id: REQUEST_ID,
      customer_id: REQUEST_ID,
      session_id: REQUEST_ID,
      error_code: "23505",
      constraint_name: "areas_operator_name_unique",
      service: "customers.update_phone",
      capability: "customers.phone.update",
      period: "2026-10-01",
      at: "2026-10-13T18:30:00.000Z",
      duration_ms: 12,
      outcome: "connection_status_change_rejected_because_billed",
      payment_count: 50,
      amount_paise: 9876543210,
    };
    expect(findPii(fields)).toEqual([]);
    const { logger, records } = capture(true);
    logger.info("service.completed", fields);
    expect(records).toHaveLength(1);
  });
});

describe("PII helpers", () => {
  it("isPiiKey handles camelCase, kebab and safe exceptions", () => {
    expect(isPiiKey("customerName")).toBe(true);
    expect(isPiiKey("X-Auth-Token")).toBe(true);
    expect(isPiiKey("error_name")).toBe(false);
    expect(isPiiKey("customer_id")).toBe(false);
  });

  it("UUIDs are never mistaken for phone numbers or secrets", () => {
    // Last group all digits, shaped like +91 and a mobile number.
    expect(piiKindOfValue("0190a1b2-c3d4-7e5f-8a9b-919876543210")).toBeUndefined();
  });

  it("scrubText redacts PII inside free text and keeps UUIDs", () => {
    expect(scrubText(`user ${REQUEST_ID} ramesh@example.com 9876543210`)).toBe(
      `user ${REQUEST_ID} [redacted:email] [redacted:phone]`,
    );
  });

  it("errorLogFields keeps type/SQLSTATE/constraint, drops DB messages, scrubs others", () => {
    const dbError = Object.assign(new Error("Key (login)=(ramesh) already exists"), {
      code: "23505",
      constraint: "users_login_unique",
    });
    expect(errorLogFields(dbError)).toEqual({
      error_type: "Error",
      sqlstate: "23505",
      constraint_name: "users_login_unique",
    });
    expect(errorLogFields(new RangeError("bad phone 9876543210"))).toEqual({
      error_type: "RangeError",
      error_message: "bad phone [redacted:phone]",
    });
    expect(findPii(errorLogFields(new Error("x ramesh@example.com")))).toEqual([]);
  });
});

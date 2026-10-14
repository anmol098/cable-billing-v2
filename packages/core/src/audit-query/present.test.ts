/**
 * The viewer's redaction (T-035): secrets hidden at any depth, phones masked to the last four
 * digits by key and inside text, emails masked, ids dropped, amounts kept as paise, unchanged
 * fields left out, and a new password still shown as "something hidden changed".
 */
import { describe, expect, it } from "vitest";
import { REDACTED } from "../audit/redact";
import {
  AUDIT_VIEW_HIDDEN_KEYS,
  auditChanges,
  MAX_CHANGES,
  MAX_TEXT_LENGTH,
  maskContactsInText,
  maskEmail,
  presentAuditValue,
} from "./present";

const HIDDEN = { kind: "hidden" };

describe("presentAuditValue", () => {
  it("hides credentials, secrets, KYC and network identifiers whatever their value", () => {
    for (const key of [
      "password",
      "password_hash",
      "token_hash",
      "refresh_token",
      "secret",
      "otp",
      "cookie",
      "authorization",
      "api_key",
      "kyc",
      "aadhaar",
      "pan",
      ...AUDIT_VIEW_HIDDEN_KEYS,
    ]) {
      expect(presentAuditValue(key, "anything"), key).toEqual(HIDDEN);
      expect(presentAuditValue(key, 12345), key).toEqual(HIDDEN);
      expect(presentAuditValue(key, { nested: "x" }), key).toEqual(HIDDEN);
    }
    expect(presentAuditValue("name", REDACTED)).toEqual(HIDDEN);
  });

  it("masks phones to the last four digits, by key and inside text", () => {
    expect(presentAuditValue("phone", "9876543210")).toEqual({ kind: "text", value: "XXXXXX3210" });
    expect(presentAuditValue("alt_phone", "+91 98765 43210")).toEqual({
      kind: "text",
      value: "XXXXXX3210",
    });
    expect(presentAuditValue("office_phone", 9876543210)).toEqual({
      kind: "text",
      value: "XXXXXX3210",
    });
    // Too short to be a phone: showing four digits would show half of it.
    expect(presentAuditValue("phone", "12345")).toEqual(HIDDEN);
    expect(presentAuditValue("phone", "")).toEqual({ kind: "empty" });
    expect(presentAuditValue("phone", null)).toEqual({ kind: "empty" });
    // A lineman's user name is their mobile number.
    expect(presentAuditValue("login", "9812345678")).toEqual({ kind: "text", value: "XXXXXX5678" });
    expect(maskContactsInText("Call 98765-43210 or +919812345678 today")).toBe(
      "Call XXXXXX3210 or XXXXXX5678 today",
    );
    expect(maskContactsInText("ph 09876543210, 91 98123 45678")).toBe("ph XXXXXX3210, XXXXXX5678");
  });

  it("does not mistake dates, bill numbers, amounts or long ids in text for phones", () => {
    for (const text of [
      "from 2026-10-01 to 2026-10-31",
      "receipt R-2610-00045, bill CB-2610-00001",
      "₹1,23,456 paid",
      "card 98765432101234", // longer than a phone: not cut in two
      "pin 560001",
    ]) {
      expect(maskContactsInText(text), text).toBe(text);
    }
    // Identifiers the Owner reads as they are, even when they look like a mobile number.
    for (const key of ["vc_number", "customer_code", "receipt_number", "business_date"]) {
      expect(presentAuditValue(key, "9876543210"), key).toEqual({
        kind: "text",
        value: "9876543210",
      });
    }
  });

  it("masks emails", () => {
    expect(maskEmail("ramesh.k@example.com")).toBe("r•••@example.com");
    expect(presentAuditValue("email", "ramesh@example.com")).toEqual({
      kind: "text",
      value: "r•••@example.com",
    });
    expect(maskContactsInText("mail ramesh@example.com")).toBe("mail r•••@example.com");
  });

  it("keeps business values, leaves UUIDs in text alone, and cuts long text", () => {
    expect(presentAuditValue("name", "Sita Devi")).toEqual({ kind: "text", value: "Sita Devi" });
    expect(presentAuditValue("receipt_number", "R-2610-00045")).toEqual({
      kind: "text",
      value: "R-2610-00045",
    });
    expect(presentAuditValue("amount_paise", 50_000)).toEqual({ kind: "paise", value: 50_000 });
    expect(presentAuditValue("count", 3)).toEqual({ kind: "number", value: 3 });
    expect(presentAuditValue("reversed", true)).toEqual({ kind: "flag", value: true });
    expect(presentAuditValue("tags", ["a", "b"])).toEqual({ kind: "text", value: "a, b" });
    expect(presentAuditValue("allocations", [{ a: 1 }, { a: 2 }])).toEqual({
      kind: "items",
      value: 2,
    });
    const id = "0190a1b2-c3d4-7e5f-8a9b-012345678901";
    expect(presentAuditValue("note", `see ${id}`)).toEqual({ kind: "text", value: `see ${id}` });
    const long = presentAuditValue("address", "x".repeat(500));
    expect(long?.kind === "text" && Array.from(long.value).length).toBe(MAX_TEXT_LENGTH + 1);
  });

  it("drops ids (internal; the sentence names the thing)", () => {
    expect(
      presentAuditValue("customer_id", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"),
    ).toBeUndefined();
    expect(presentAuditValue("revoked_link_ids", ["0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"])).toEqual(
      { kind: "items", value: 1 },
    );
  });
});

describe("auditChanges", () => {
  it("lists changed fields with both sides, snake_case, and leaves out unchanged ones and ids", () => {
    expect(
      auditChanges(
        { name: "Sita", altPhone: "9876543210", areaId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" },
        { name: "Sita", altPhone: "9123456780", status: "inactive" },
      ),
    ).toEqual([
      {
        field: "alt_phone",
        before: { kind: "text", value: "XXXXXX3210" },
        after: { kind: "text", value: "XXXXXX6780" },
      },
      { field: "status", before: null, after: { kind: "text", value: "inactive" } },
    ]);
  });

  it("flattens one level, hides secrets inside nested objects, and keeps a changed secret as a row", () => {
    expect(
      auditChanges(
        { password: REDACTED },
        {
          password: REDACTED,
          settings: { receipt_footer: "Thanks", api_key: "k-123" },
          kyc: { aadhaar: "1234 5678 9012" },
        },
      ),
    ).toEqual([
      { field: "password", before: HIDDEN, after: HIDDEN },
      { field: "settings.receipt_footer", before: null, after: { kind: "text", value: "Thanks" } },
      { field: "settings.api_key", before: null, after: HIDDEN },
      { field: "kyc", before: null, after: HIDDEN },
    ]);
  });

  it("copes with missing, non-object and huge values", () => {
    expect(auditChanges(null, null)).toEqual([]);
    expect(auditChanges("text", [1, 2])).toEqual([]);
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, i]));
    expect(auditChanges(null, many)).toHaveLength(MAX_CHANGES);
  });
});

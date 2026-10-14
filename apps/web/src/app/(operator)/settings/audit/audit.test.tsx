/**
 * "Who changed what" words and page body (T-035): one plain sentence per event in English and
 * Hindi (every known action, with and without its details), the generic sentence for unknown
 * actions, IST times, before/after cells (hidden values say "Hidden"), the URL filters and the
 * keyset pager.
 */
import {
  type AuditEventView,
  type AuditValue,
  KNOWN_AUDIT_ACTIONS,
  type KnownAuditAction,
} from "@cb/core";
import { screen, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { renderWithIntl } from "@/test/intl";
import en from "../../../../../messages/en.json";
import hi from "../../../../../messages/hi.json";
import { AuditLog, type AuditLogProps } from "./audit-log";
import { auditHref, readAuditQuery } from "./filters";
import {
  type AuditTranslate,
  auditSentence,
  auditTime,
  fieldLabel,
  shownValueText,
  valueText,
} from "./sentences";

function auditT(locale: "en" | "hi" = "en"): AuditTranslate {
  return createTranslator({
    locale,
    messages: locale === "en" ? en : hi,
    namespace: "audit",
  }) as unknown as AuditTranslate;
}

const STAFF = "0190a3b2-0000-7000-8000-00000000000a";
const text = (value: string): AuditValue => ({ kind: "text", value });

function event(overrides: Partial<AuditEventView> = {}): AuditEventView {
  return {
    id: "0190a3b2-0000-7000-8000-000000000001",
    at: new Date("2026-10-14T10:35:00.000Z"), // 4:05 PM IST
    actor: { kind: "person", id: STAFF, name: "Ramesh", role: "staff" },
    action: "customers.update_phone",
    known: true,
    entityType: "customer",
    knownEntityType: true,
    target: text("1045"),
    details: { field: { kind: "code", value: "phone" } },
    changes: [
      {
        field: "phone",
        before: { kind: "text", value: "XXXXXX3210" },
        after: { kind: "text", value: "XXXXXX6780" },
      },
    ],
    ...overrides,
  };
}

describe("auditSentence", () => {
  it("says who changed what, in plain words", () => {
    expect(auditSentence(auditT(), event(), "en")).toBe(
      "Ramesh (Staff) changed the phone of customer 1045",
    );
    expect(auditSentence(auditT("hi"), event(), "hi")).toBe(
      "Ramesh (स्टाफ़) ने ग्राहक 1045 का मोबाइल नंबर बदला",
    );
    expect(
      auditSentence(
        auditT(),
        event({ details: { field: { kind: "code", value: "alt_phone" } } }),
        "en",
      ),
    ).toBe("Ramesh (Staff) changed the other mobile no. of customer 1045");
  });

  it("names the app, support and people whose name can't be read", () => {
    const t = auditT();
    expect(
      auditSentence(
        t,
        event({
          actor: { kind: "system" },
          action: "billing.run_scheduled",
          entityType: "billing_run",
          target: { kind: "period", value: "2026-11-01" },
          details: {},
        }),
        "en",
      ),
    ).toBe("The app set the bills for November 2026 to be made");
    expect(
      auditSentence(
        t,
        event({ actor: { kind: "person", id: STAFF, name: null, role: "platform_admin" } }),
        "en",
      ),
    ).toMatch(/^Cable Billing support changed/);
    expect(
      auditSentence(
        t,
        event({ actor: { kind: "person", id: STAFF, name: null, role: "owner" } }),
        "en",
      ),
    ).toMatch(/^Someone \(Owner\) changed/);
  });

  it("puts amounts in whole rupees with Indian grouping, dates and months in the reader's language", () => {
    const payment = event({
      action: "payments.post",
      entityType: "payment",
      target: text("R-2610-00045"),
      details: {
        customer: text("1045"),
        amount: { kind: "paise", value: 12_345_600 },
        method: { kind: "code", value: "upi" },
      },
    });
    expect(auditSentence(auditT(), payment, "en")).toBe(
      "Ramesh (Staff) took ₹1,23,456 by UPI from customer 1045 (receipt R-2610-00045)",
    );
    const handover = event({
      action: "handover.accept",
      entityType: "collection_session",
      target: text("Suresh"),
      details: {
        amount: { kind: "paise", value: 250_000 },
        date: { kind: "date", value: "2026-10-13" },
      },
    });
    expect(auditSentence(auditT("hi"), handover, "hi")).toBe(
      "Ramesh (स्टाफ़) ने Suresh का 13 अक्टू 2026 का कैश मंज़ूर किया: ₹2,500",
    );
  });

  it("lists changed fields by their words", () => {
    const changed = event({
      action: "customers.update",
      details: { fields: { kind: "fields", value: ["name", "alt_phone", "mystery_field"] } },
    });
    expect(auditSentence(auditT(), changed, "en")).toBe(
      "Ramesh (Staff) changed Name, Other mobile no., mystery field of customer 1045",
    );
  });

  it("uses a safe generic sentence for actions it doesn't know", () => {
    const odd = event({
      action: "exports.csv_downloaded",
      known: false,
      details: {},
      target: null,
    });
    expect(auditSentence(auditT(), odd, "en")).toBe("Ramesh (Staff) made a change: Customer");
    expect(
      auditSentence(
        auditT("hi"),
        event({ action: "x.y", known: false, entityType: "widget", knownEntityType: false }),
        "hi",
      ),
    ).toBe("Ramesh (स्टाफ़) ने बदलाव किया: दूसरा 1045");
  });

  it("every known action makes a full sentence in both languages, with or without details", () => {
    for (const locale of ["en", "hi"] as const) {
      const t = auditT(locale);
      for (const action of KNOWN_AUDIT_ACTIONS as readonly KnownAuditAction[]) {
        for (const withTarget of [true, false]) {
          const sentence = auditSentence(
            t,
            event({ action, details: {}, target: withTarget ? text("T-1") : null }),
            locale,
          );
          expect(sentence, `${locale} ${action}`).not.toMatch(/[{}]|sentence\.|undefined/);
          expect(sentence, `${locale} ${action}`).toContain("Ramesh");
        }
      }
    }
  });
});

describe("values", () => {
  it("formats times in IST and before/after cells", () => {
    expect(auditTime(auditT(), new Date("2026-10-14T10:35:00.000Z"), "en")).toBe(
      "14 Oct 2026, 4:05 PM",
    );
    expect(auditTime(auditT("hi"), new Date("2026-10-13T18:30:00.000Z"), "hi")).toBe(
      "14 अक्टू 2026, 12:00 AM",
    );
    const t = auditT();
    expect(shownValueText(t, { kind: "hidden" }, "en")).toBe("Hidden");
    expect(shownValueText(t, { kind: "empty" }, "en")).toBe("Not set");
    expect(shownValueText(t, null, "en")).toBe("—");
    expect(shownValueText(t, { kind: "paise", value: 50_000 }, "en")).toBe("₹500");
    expect(shownValueText(t, { kind: "flag", value: true }, "en")).toBe("Yes");
    expect(shownValueText(t, { kind: "items", value: 2 }, "en")).toBe("2 items");
    expect(shownValueText(t, { kind: "text", value: "2026-10-01" }, "en")).toBe("1 Oct 2026");
    expect(valueText(t, { kind: "period", value: "2026-10-01" }, "en")).toBe("October 2026");
    expect(shownValueText(t, { kind: "text", value: "2026-10-14T10:35:00.000Z" }, "en")).toBe(
      "14 Oct 2026, 4:05 PM",
    );
    expect(
      auditSentence(
        t,
        event({
          actor: { kind: "system" },
          action: "subscription.state_changed",
          entityType: "subscription",
          target: null,
          details: { status: { kind: "code", value: "read_only" } },
        }),
        "en",
      ),
    ).toBe("The app set the app subscription to: View only");
    expect(fieldLabel(t, "settings.receipt_footer")).toBe("Receipt message");
  });
});

describe("filters in the URL", () => {
  it("reads valid filters and drops the rest", () => {
    const query = readAuditQuery({
      from: "2026-10-01",
      to: "2026-10-14",
      who: STAFF.toUpperCase(),
      what: "customer",
      change: "customers.update_phone",
      after: "abc_DEF-1",
    });
    expect(query.input).toEqual({
      from: "2026-10-01",
      to: "2026-10-14",
      actor: STAFF,
      entityType: "customer",
      action: "customers.update_phone",
    });
    expect(query.cursor).toBe("abc_DEF-1");
    expect(readAuditQuery({ who: "app" }).input).toEqual({ actor: "system" });
    const junk = readAuditQuery({
      from: "yesterday",
      who: "'; DROP TABLE",
      what: "secrets",
      change: "Drop Table",
      after: "a b",
    });
    expect(junk.input).toEqual({});
    expect(junk.cursor).toBeNull();
    const backwards = readAuditQuery({ from: "2026-10-14", to: "2026-10-01" });
    expect(backwards.badDates).toBe(true);
    expect(backwards.input).toEqual({});
  });

  it("builds page links that keep the filters", () => {
    expect(auditHref({})).toBe("/settings/audit");
    expect(auditHref({ who: "app", what: "" }, "CUR")).toBe("/settings/audit?who=app&after=CUR");
  });
});

describe("AuditLog", () => {
  const base: AuditLogProps = {
    events: [],
    actors: [{ id: STAFF, name: "Ramesh", role: "staff", active: false }],
    values: { from: "", to: "", who: "", what: "", change: "" },
    nextCursor: null,
    paged: false,
    badDates: false,
    today: "2026-10-14",
    monthStart: "2026-10-01",
  };

  it("shows each change as a sentence with its time, and the details with hidden values", () => {
    const secret = event({
      id: "0190a3b2-0000-7000-8000-000000000002",
      action: "team.reset_password",
      entityType: "user",
      target: text("Suresh"),
      details: {},
      changes: [{ field: "password", before: { kind: "hidden" }, after: { kind: "hidden" } }],
    });
    renderWithIntl(<AuditLog {...base} events={[event(), secret]} nextCursor="NEXT" />);
    const rows = screen.getAllByTestId("audit-event");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Ramesh (Staff) changed the phone of customer 1045");
    expect(rows[0]).toHaveTextContent("14 Oct 2026, 4:05 PM");
    expect(within(rows[0] as HTMLElement).getByText("XXXXXX3210")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Ramesh (Staff) set a new password for Suresh");
    expect(within(rows[1] as HTMLElement).getAllByText("Hidden")).toHaveLength(2);
    const older = screen.getByRole("link", { name: "Older changes" });
    expect(older).toHaveAttribute("href", "/settings/audit?after=NEXT");
    expect(screen.queryByRole("link", { name: "Back to the newest" })).toBeNull();
    // The "Who" filter offers people (switched-off ones marked) and the app itself.
    const who = screen.getByLabelText("Who");
    expect(
      within(who).getByRole("option", { name: "Ramesh (Staff) (switched off)" }),
    ).toBeVisible();
    expect(within(who).getByRole("option", { name: "The app (by itself)" })).toBeVisible();
  });

  it("says when nothing matches, and offers the way back from a later page", () => {
    renderWithIntl(<AuditLog {...base} values={{ ...base.values, what: "payment" }} paged />);
    expect(screen.getByText("No changes match. Try fewer choices.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the newest" })).toHaveAttribute(
      "href",
      "/settings/audit?what=payment",
    );
    expect(screen.getByRole("link", { name: "Show all" })).toHaveAttribute(
      "href",
      "/settings/audit",
    );
  });

  it("renders in Hindi", () => {
    renderWithIntl(<AuditLog {...base} events={[event()]} />, "hi");
    expect(screen.getByTestId("audit-event")).toHaveTextContent(
      "Ramesh (स्टाफ़) ने ग्राहक 1045 का मोबाइल नंबर बदला",
    );
  });
});

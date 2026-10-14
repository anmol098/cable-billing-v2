/**
 * CSV exports on the web (T-082): the URL → filters mapping matches each page's, every column has
 * words in en and hi (no machine codes), cash and UPI stay apart, the streamed file (BOM, headings,
 * formulas neutralised, truncation line) and the download page / link markup.
 */
import { type AnyExportHandle, EXPORT_KINDS, type ExportKind } from "@cb/core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, headerCells, rowCells } from "./columns";
import { DownloadListButton } from "./download-link";
import { EXPORT_CARD_ORDER, ExportCards } from "./export-cards";
import { exportHref, exportInputFromParams, kindOfSlug, paramsOf } from "./params";
import { csvChunks } from "./stream";
import { allWords, SAMPLE_ROWS } from "./test-fixtures";

/** 2 Nov 2026, 10:00 IST. */
const NOW = new Date("2026-11-02T04:30:00.000Z");
const AREA = "0199c4f6-0000-7000-8000-0000000000aa";
const PERSON = "0199c4f6-0000-7000-8000-0000000000bb";

describe("the page's query → export filters", () => {
  it("reads each page's own parameters, with its defaults", () => {
    expect(exportInputFromParams("dues", {}, NOW)).toEqual({
      kind: "dues",
      filters: { asOfDate: undefined, areaId: undefined, kind: "due", bucket: undefined },
    });
    expect(
      exportInputFromParams(
        "dues",
        { date: "2026-10-31", area: AREA.toUpperCase(), show: "due", age: "d90_plus", page: "3" },
        NOW,
      ).filters,
    ).toEqual({ asOfDate: "2026-10-31", areaId: AREA, kind: "due", bucket: "d90_plus" });
    // Credit list: no age filter (as on the page).
    expect(
      exportInputFromParams("dues", { show: "advance", age: "d0_30" }, NOW).filters,
    ).toMatchObject({ kind: "advance", bucket: undefined });

    expect(exportInputFromParams("bills", {}, NOW).filters).toMatchObject({
      from: "2026-09-01",
      to: "2026-11-01",
    });
    // A month field's `YYYY-MM` works too.
    expect(
      exportInputFromParams("bills", { from: "2026-07", to: "2026-08-01", paid: "unpaid" }, NOW)
        .filters,
    ).toMatchObject({ from: "2026-07-01", to: "2026-08-01", payState: "unpaid" });

    expect(exportInputFromParams("payments", {}, NOW).filters).toEqual({
      from: "2026-11-01",
      to: "2026-11-02",
      collectorId: undefined,
      method: undefined,
      status: "all",
    });
    expect(
      exportInputFromParams(
        "payments",
        { from: "2026-10-05", to: "2026-10-01", method: "upi", collector: PERSON },
        NOW,
      ).filters,
    ).toMatchObject({ from: "2026-11-01", to: "2026-11-02", method: "upi", collectorId: PERSON });

    expect(exportInputFromParams("collections", {}, NOW).filters).toEqual({
      from: "2026-11-02",
      to: "2026-11-02",
      collectorId: undefined,
    });
    expect(exportInputFromParams("handover", {}, NOW).filters).toMatchObject({
      from: "2026-10-27",
      to: "2026-11-02",
    });
    expect(
      exportInputFromParams("connections", { plan: "own", status: "suspended" }, NOW).filters,
    ).toEqual({ date: "2026-11-02", areaId: undefined, status: "suspended", plan: "own" });
    expect(exportInputFromParams("billing_runs", { month: "2026-10" }, NOW).filters).toEqual({
      period: "2026-10-01",
      outcome: undefined,
      areaId: undefined,
    });
    expect(
      exportInputFromParams("customers", { q: " 98765 ", area: "none", status: "inactive" }, NOW)
        .filters,
    ).toEqual({ q: " 98765 ", areaId: "none", status: "inactive" });
    expect(exportInputFromParams("customers", { area: "x" }, NOW).filters).toEqual({
      status: "all",
    });
  });

  it("builds the download link from a page's query, without its page number", () => {
    expect(exportHref("billing_runs", { month: "2026-10-01", page: "2" })).toBe(
      "/api/exports/billing-runs?month=2026-10-01",
    );
    expect(exportHref("dues", { area: AREA, age: undefined, show: "" })).toBe(
      `/api/exports/dues?area=${AREA}`,
    );
    expect(exportHref("customers")).toBe("/api/exports/customers");
    expect(kindOfSlug("billing-runs", EXPORT_KINDS)).toBe("billing_runs");
    expect(kindOfSlug("audit", EXPORT_KINDS)).toBeUndefined();
    expect(paramsOf(new URLSearchParams("a=1&a=2&b=3"))).toEqual({ a: ["1", "2"], b: "3" });
  });
});

describe("columns", () => {
  for (const locale of ["en", "hi"] as const) {
    it(`every heading and value has words in ${locale}`, () => {
      const t = allWords(locale);
      for (const kind of EXPORT_KINDS) {
        const headers = headerCells(kind, t);
        expect(headers.length).toBe(EXPORT_COLUMNS[kind].length);
        for (const header of headers) expect(header).not.toMatch(/^exports\./);
        const cells = rowCells(kind, SAMPLE_ROWS[kind] as never, t);
        expect(cells).toHaveLength(headers.length);
      }
    });
  }

  it("writes rupees, IST times, words for codes, and cash and UPI apart", () => {
    const t = allWords("en");
    const cells = (kind: ExportKind) =>
      Object.fromEntries(
        headerCells(kind, t).map((h, i) => [h, rowCells(kind, SAMPLE_ROWS[kind] as never, t)[i]]),
      );
    expect(cells("customers")).toMatchObject({
      "Customer code": "A-1",
      Customer: "Active",
      "Due (₹)": { number: "0" },
      "Advance (₹)": { number: "125.50" },
    });
    expect(cells("payments")).toMatchObject({
      "Receipt no.": "P-ABC-0001",
      "Money taken at": "2026-10-31 23:50",
      "Reached the office at": "2026-11-01 00:15",
      "Cash (₹)": null,
      "UPI (₹)": { number: "200" },
      "Taken by": "From the old app",
      Where: "By a lineman",
      Status: "Cancelled",
      Check: "To check",
      "Why check": "It came from another phone",
    });
    expect(cells("bills")).toMatchObject({
      Month: "2026-10",
      "Bill type": "Old due",
      "Paid?": "Part paid",
      "Still due (₹)": { number: "300" },
    });
    expect(cells("dues")).toMatchObject({
      "Due Over 90 days (₹)": { number: "500" },
      "Unpaid since": "2026-06",
      Customer: "Closed",
    });
    expect(cells("handover")).toMatchObject({
      Status: "Sent back",
      "Difference (₹)": { number: "-50" },
      "Lineman's reason": "Less cash",
      "Handed over at": "2026-11-01 17:30",
    });
    expect(cells("connections")).toMatchObject({
      Status: "Stopped",
      Plan: "Own amount",
      "Monthly rent (₹)": { number: "250.50" },
    });
    expect(cells("billing_runs")).toMatchObject({
      Result: "Problem",
      Why: "Account total does not match. Call support.",
      Tries: { number: "2" },
    });
    expect(cells("collections")).toMatchObject({
      Who: "From the old app",
      "Cash (₹)": { number: "500" },
      "UPI (₹)": { number: "100" },
    });
  });
});

function fakeHandle(
  kind: ExportKind,
  pages: readonly (readonly unknown[])[],
  truncated = false,
): AnyExportHandle {
  return {
    kind,
    filters: {},
    asOf: NOW,
    truncated,
    async *pages() {
      for (const page of pages) yield page;
    },
  } as unknown as AnyExportHandle;
}

async function csvOf(handle: AnyExportHandle, locale: "en" | "hi" = "en"): Promise<string> {
  let out = "";
  for await (const chunk of csvChunks(handle, allWords(locale))) out += chunk;
  return out;
}

describe("the CSV file", () => {
  it("starts with a BOM and the headings, then every page's rows; formulas are neutralised", async () => {
    const row = SAMPLE_ROWS.customers;
    const csv = await csvOf(fakeHandle("customers", [[row], [{ ...row, name: "आशा, देवी" }]]));
    const lines = csv.split("\r\n");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe("﻿Customer code,Customer name,Phone,Area,Customer,Due (₹),Advance (₹)");
    expect(lines[1]).toBe(`A-1,"'=HYPERLINK(""http://x"")",9876543210,उत्तर,Active,0,125.50`);
    expect(lines[2]).toBe(`A-1,"आशा, देवी",9876543210,उत्तर,Active,0,125.50`);
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });

  it("says in words when rows were left out", async () => {
    const csv = await csvOf(
      fakeHandle("customers", [[SAMPLE_ROWS.customers, SAMPLE_ROWS.customers]], true),
    );
    expect(csv.trimEnd().split("\r\n").at(-1)).toBe(
      "This file stops here: it has the first 2 rows only. Choose fewer days or months.",
    );
  });

  it("has Hindi headings for a Hindi reader", async () => {
    const csv = await csvOf(fakeHandle("payments", [[SAMPLE_ROWS.payments]]), "hi");
    expect(csv.split("\r\n")[0]).toContain("नकद (₹),UPI (₹)");
  });
});

describe("download page and link", () => {
  it("has one form per export, each sending to its file", () => {
    render(<ExportCards t={allWords("en")} now={NOW} today={"2026-11-02" as never} locale="en" />);
    const forms = screen.getAllByRole("form");
    expect(forms).toHaveLength(EXPORT_KINDS.length);
    expect(forms.map((f) => f.getAttribute("action"))).toEqual(
      EXPORT_CARD_ORDER.map((kind) => `/api/exports/${kind.replace("_", "-")}`),
    );
    const payments = screen.getByRole("form", { name: "Choose for Payments" });
    expect(within(payments).getByLabelText("From")).toHaveValue("2026-11-01");
    expect(within(payments).getByRole("button", { name: "Download" })).toBeTruthy();
    const bills = screen.getByRole("form", { name: "Choose for Bills" });
    expect(within(bills).getByLabelText("From month")).toHaveValue("2026-09-01");
  });

  it("works in Hindi", () => {
    render(<ExportCards t={allWords("hi")} now={NOW} today={"2026-11-02" as never} locale="hi" />);
    expect(screen.getAllByRole("button", { name: "डाउनलोड करें" })).toHaveLength(8);
  });

  it("links a report page to its file with the page's filters", () => {
    render(
      <DownloadListButton kind="dues" params={{ area: AREA, page: "4" }} t={allWords("en")} />,
    );
    const link = screen.getByRole("link", { name: /Download this list/ });
    expect(link.getAttribute("href")).toBe(`/api/exports/dues?area=${AREA}`);
    expect(link.hasAttribute("download")).toBe(true);
  });
});

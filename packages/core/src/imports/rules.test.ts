/**
 * Pure import rules (T-084): dates and rents as people write them, grouping lines into
 * customers, the file-only checks, and the field checks that reuse the services' Zod inputs.
 */
import { businessDate } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { IMPORT_FIELDS, type ImportField } from "./columns";
import type { ImportLine } from "./file";
import {
  checkGroups,
  connectionDraftOf,
  customerInputOf,
  groupLines,
  LineProblems,
  parseImportDate,
  parseImportRent,
  spreadGroupProblems,
} from "./rules";

const TODAY = businessDate("2026-10-14");

function line(n: number, values: Partial<Record<ImportField, string>>): ImportLine {
  const all = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ""])) as Record<ImportField, string>;
  return { line: n, values: { ...all, ...values } };
}

describe("parseImportDate", () => {
  it.each([
    ["2026-10-15", "2026-10-15"],
    ["2026/10/5", "2026-10-05"],
    ["2026-10-15T10:30:00", "2026-10-15"],
    ["15/10/2026", "2026-10-15"],
    ["5/1/2026", "2026-01-05"],
    ["15-10-26", "2026-10-15"],
    ["15.10.2026", "2026-10-15"],
    ["15 Oct 2026", "2026-10-15"],
    ["15-Oct-26", "2026-10-15"],
    ["1st September 2026", "2026-09-01"],
    ["Oct 15, 2026", "2026-10-15"],
    ["  15 / 10 / 2026 ", null],
  ])("%s → %s", (text, expected) => {
    expect(parseImportDate(text)).toBe(expected);
  });

  it("reads day first, never month first, and refuses impossible dates", () => {
    expect(parseImportDate("02/03/2026")).toBe("2026-03-02");
    for (const bad of [
      "13/13/2026",
      "31/02/2026",
      "2026-02-30",
      "yesterday",
      "15 Foo 2026",
      "46296",
    ]) {
      expect(parseImportDate(bad), bad).toBeNull();
    }
    expect(parseImportDate("")).toBeNull();
  });
});

describe("parseImportRent", () => {
  it.each([
    ["450", 45_000],
    ["₹450", 45_000],
    ["₹ 1,200", 120_000],
    ["Rs. 450", 45_000],
    ["rs450", 45_000],
    ["INR 450", 45_000],
    ["450/-", 45_000],
    ["450.00", 45_000],
    ["४५०", 45_000],
    ["0", 0],
  ])("%s → %d paise", (text, paise) => {
    expect(parseImportRent(text)).toEqual({ ok: true, paise });
  });

  it("refuses paise, negatives, text and huge numbers; empty is no rent", () => {
    expect(parseImportRent("450.50")).toEqual({ ok: false, problem: "decimal" });
    expect(parseImportRent("-450")).toEqual({ ok: false, problem: "negative" });
    expect(parseImportRent("four fifty")).toEqual({ ok: false, problem: "invalid" });
    expect(parseImportRent("12345678901234")).toEqual({ ok: false, problem: "too_large" });
    expect(parseImportRent("")).toEqual({ ok: true, paise: null });
  });
});

describe("groups", () => {
  it("groups lines by normalised code; lines without a code stand alone", () => {
    const groups = groupLines([
      line(2, { code: "a-1", name: "Ravi" }),
      line(3, { code: "", name: "Nobody" }),
      line(4, { code: " A-1 ", vcNumber: "111" }),
      line(5, { code: "", name: "Nobody again" }),
    ]);
    expect(groups.map((g) => [g.codeKey, g.lines.map((l) => l.line)])).toEqual([
      ["A-1", [2, 4]],
      ["", [3]],
      ["", [5]],
    ]);
  });

  it("flags a code used for two names, details that differ, repeated VCs and > 10 boxes", () => {
    const boxes = Array.from({ length: 11 }, (_, i) =>
      line(20 + i, { code: "9", vcNumber: `VC${i}`, rent: "100" }),
    );
    const groups = groupLines([
      line(2, { code: "1", name: "Ravi Kumar", phone: "9876500001" }),
      line(3, { code: "1", name: "ravi  kumar", phone: "98765 00002", vcNumber: "111-222" }),
      line(4, { code: "2", name: "Sita", vcNumber: "111 222" }),
      line(5, { code: "3", name: "Mohan" }),
      line(6, { code: "3", name: "Sohan" }),
      line(19, { code: "9", name: "Many" }),
      ...boxes,
    ]);
    const problems = new LineProblems();
    checkGroups(groups, problems);
    expect(problems.of(2)).toEqual([]);
    expect(problems.of(3)).toEqual([{ field: "phone", code: "differs", params: { line: 2 } }]);
    expect(problems.of(4)).toEqual([{ field: "vcNumber", code: "repeated", params: { line: 3 } }]);
    expect(problems.of(6)).toEqual([{ field: "name", code: "name_differs", params: { line: 5 } }]);
    expect(problems.of(29)).toEqual([]);
    expect(problems.of(30)).toEqual([{ field: "line", code: "too_many_boxes" }]);
  });

  it("marks every other line of a customer with a problem", () => {
    const [group] = groupLines([
      line(2, { code: "1", name: "Ravi" }),
      line(3, { code: "1", vcNumber: "1" }),
      line(4, { code: "1", vcNumber: "2" }),
    ]);
    if (!group) throw new Error("no group");
    const problems = new LineProblems();
    expect(spreadGroupProblems(group, problems)).toBe(false);
    problems.add(3, { field: "plan", code: "plan_or_rent" });
    expect(spreadGroupProblems(group, problems)).toBe(true);
    expect(problems.of(2)).toEqual([
      { field: "line", code: "same_customer", params: { lines: "3" } },
    ]);
    expect(problems.of(4)).toEqual([
      { field: "line", code: "same_customer", params: { lines: "3" } },
    ]);
  });
});

describe("customerInputOf (CreateCustomerInput)", () => {
  it("builds the service input: phones cleaned, empty text → null", () => {
    const result = customerInputOf(
      line(2, { code: "007", name: "  Ravi ", phone: "+91 98765-43210", address: "" }),
    );
    expect(result).toEqual({
      ok: true,
      input: {
        customerCode: "007",
        name: "Ravi",
        phone: "9876543210",
        altPhone: null,
        address: null,
      },
    });
  });

  it("names the field of each problem", () => {
    const result = customerInputOf(
      line(2, {
        code: "x".repeat(65),
        name: "",
        phone: "12",
        altPhone: "abc",
        address: "a".repeat(301),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        { field: "code", code: "too_long" },
        { field: "name", code: "required" },
        { field: "phone", code: "invalid" },
        { field: "altPhone", code: "invalid" },
        { field: "address", code: "too_long" },
      ]),
    );
    expect(customerInputOf(line(2, { name: "No code" }))).toEqual({
      ok: false,
      problems: [{ field: "code", code: "required" }],
    });
  });
});

describe("connectionDraftOf (ConnectionFields)", () => {
  it("defaults the start day to today and keeps the plan name for the lookup", () => {
    const result = connectionDraftOf(line(3, { vcNumber: " 0001  2345 ", plan: "Basic" }), TODAY);
    expect(result).toEqual({
      ok: true,
      draft: {
        line: 3,
        vcNumber: "0001 2345",
        vcKey: "00012345",
        planName: "Basic",
        rentPaise: null,
        startDate: "2026-10-14",
      },
    });
  });

  it("refuses a box without a VC number, a VC without plan or rent, and bad values", () => {
    const problemsOf = (values: Partial<Record<ImportField, string>>) => {
      const result = connectionDraftOf(line(3, values), TODAY);
      return result.ok ? [] : result.problems;
    };
    expect(problemsOf({ plan: "Basic" })).toEqual([{ field: "vcNumber", code: "box_needed" }]);
    expect(problemsOf({ vcNumber: "1" })).toEqual([{ field: "plan", code: "plan_or_rent" }]);
    expect(problemsOf({ vcNumber: "1", rent: "450.5" })).toEqual([
      { field: "rent", code: "decimal" },
    ]);
    expect(problemsOf({ vcNumber: "1", rent: "200000" })).toEqual([
      { field: "rent", code: "too_large" },
    ]);
    expect(problemsOf({ vcNumber: "1", rent: "1", startDate: "31/02/2026" })).toEqual([
      { field: "startDate", code: "invalid" },
    ]);
    expect(problemsOf({ vcNumber: "1", rent: "1", startDate: "20/10/2026" })).toEqual([
      { field: "startDate", code: "in_future" },
    ]);
    expect(problemsOf({ vcNumber: "1", rent: "1", startDate: "1/1/1999" })).toEqual([
      { field: "startDate", code: "too_old" },
    ]);
    expect(problemsOf({ vcNumber: "वीसी", rent: "1" })).toEqual([
      { field: "vcNumber", code: "invalid" },
    ]);
    // Tomorrow is allowed, as in "Add connection".
    expect(problemsOf({ vcNumber: "1", rent: "0", startDate: "15/10/2026" })).toEqual([]);
  });
});

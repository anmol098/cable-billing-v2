/**
 * The import page (T-084): the template's column names (both languages) are the ones the reader
 * recognises, every problem the core can report has words in English and Hindi, the step runner
 * and result merging, and the wizard: download links → upload → preview with problems → add →
 * result with the problem file.
 */
import {
  fieldForHeader,
  IMPORT_FIELDS,
  type ImportLine,
  type ImportLineResult,
  type ImportPreview,
  type LineProblem,
} from "@cb/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import en from "../../../../../messages/en.json";
import hi from "../../../../../messages/hi.json";
import { countCustomers, fileNameFrom, mergeResults, runSteps } from "./_lib/run";
import type { CheckResponse, StepResponse } from "./_lib/types";
import { FIELD_KEY, FIELDS, type ImportWords, problemText } from "./_lib/words";
import { ImportWizard } from "./import-wizard";

const words = (locale: "en" | "hi"): ImportWords =>
  createTranslator({
    locale,
    messages: locale === "en" ? en : hi,
    namespace: "import",
  }) as unknown as ImportWords;

/** Every (field, code) the core can report (rules.ts, plan.ts, services.ts). */
const PROBLEMS: LineProblem[] = [
  { field: "code", code: "required" },
  { field: "code", code: "too_long" },
  { field: "code", code: "invalid" },
  { field: "name", code: "required" },
  { field: "name", code: "too_long" },
  { field: "name", code: "name_differs", params: { line: 4 } },
  { field: "phone", code: "invalid" },
  { field: "phone", code: "too_long" },
  { field: "phone", code: "differs", params: { line: 2 } },
  { field: "altPhone", code: "invalid" },
  { field: "address", code: "too_long" },
  { field: "address", code: "differs", params: { line: 2 } },
  { field: "area", code: "not_found", params: { area: "Ward 9" } },
  { field: "area", code: "hidden", params: { area: "Old Town" } },
  { field: "area", code: "differs", params: { line: 2 } },
  { field: "area", code: "invalid" },
  { field: "vcNumber", code: "box_needed" },
  { field: "vcNumber", code: "invalid" },
  { field: "vcNumber", code: "too_long" },
  { field: "vcNumber", code: "repeated", params: { line: 3 } },
  { field: "vcNumber", code: "in_use", params: { code: "500", from: "" } },
  { field: "vcNumber", code: "in_use", params: { code: "500", from: "2026-10-15" } },
  { field: "vcNumber", code: "in_use", params: { code: "", from: "" } },
  { field: "vcNumber", code: "retired" },
  { field: "plan", code: "plan_or_rent" },
  { field: "plan", code: "not_found", params: { plan: "Gold" } },
  { field: "plan", code: "retired", params: { plan: "Old" } },
  { field: "plan", code: "invalid" },
  { field: "rent", code: "rent_differs", params: { amount: "₹300" } },
  { field: "rent", code: "decimal" },
  { field: "rent", code: "negative" },
  { field: "rent", code: "invalid" },
  { field: "rent", code: "too_large" },
  { field: "startDate", code: "invalid" },
  { field: "startDate", code: "in_future" },
  { field: "startDate", code: "too_old" },
  { field: "startDate", code: "billed_period" },
  { field: "line", code: "too_many_boxes" },
  { field: "line", code: "same_customer", params: { lines: "3, 5" } },
  { field: "line", code: "invalid" },
  { field: "line", code: "not_saved" },
];

describe("import words", () => {
  it("lists the same fields as the core", () => {
    expect([...FIELDS]).toEqual([...IMPORT_FIELDS]);
  });

  it("the template's column names, in both languages, are recognised by the reader", () => {
    for (const locale of ["en", "hi"] as const) {
      const t = words(locale);
      for (const field of FIELDS) {
        expect(
          fieldForHeader(t(`template.columns.${FIELD_KEY[field]}`)),
          `${locale} ${field}`,
        ).toBe(field);
        // Our own field labels work as headers too (people type them).
        expect(fieldForHeader(t(`field.${FIELD_KEY[field]}`)), `${locale} label ${field}`).toBe(
          field,
        );
      }
      expect(fieldForHeader(t("problem_file.line"))).toBe("ignore");
      expect(fieldForHeader(t("problem_file.problem"))).toBe("ignore");
    }
  });

  it("says every problem in plain words, in English and Hindi", () => {
    for (const locale of ["en", "hi"] as const) {
      const t = words(locale);
      for (const problem of PROBLEMS) {
        const text = problemText(t, problem, locale);
        expect(text, `${locale} ${problem.field}.${problem.code}`).not.toMatch(/[{}]|^import\./);
        expect(text.length).toBeGreaterThan(5);
      }
    }
    const t = words("en");
    expect(problemText(t, { field: "phone", code: "invalid" }, "en")).toBe(
      "Mobile no. is not a phone number.",
    );
    expect(problemText(t, { field: "address", code: "differs", params: { line: 2 } }, "en")).toBe(
      "Address is different on line 2 of the same customer. Write it once, on the first line.",
    );
    expect(
      problemText(
        t,
        { field: "vcNumber", code: "in_use", params: { code: "500", from: "2026-10-15" } },
        "en",
      ),
    ).toBe("This VC is with customer 500. It can start here from 15 Oct 2026.");
    expect(problemText(words("hi"), { field: "rent", code: "decimal" }, "hi")).toBe(
      "किराया: पूरे रुपये लिखें, पैसे नहीं।",
    );
  });
});

const ALL_EMPTY = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ""])) as ImportLine["values"];

function importLine(line: number, values: Partial<ImportLine["values"]>): ImportLine {
  return { line, values: { ...ALL_EMPTY, ...values } };
}

function result(
  line: number,
  group: number,
  status: ImportLineResult["status"],
  extra: Partial<ImportLineResult> = {},
): ImportLineResult {
  return { line, group, status, problems: [], customer: null, hasConnection: false, ...extra };
}

describe("step runner", () => {
  it("counts customers once per group and connections per line", () => {
    expect(
      countCustomers([
        result(2, 0, "ready", { hasConnection: true }),
        result(3, 0, "ready", { hasConnection: true }),
        result(4, 1, "problem", { hasConnection: true }),
        result(5, 2, "exists"),
      ]),
    ).toEqual({ customers: { ready: 1, created: 0, exists: 1, problem: 1 }, connections: 2 });
  });

  it("keeps the preview's group when a step's results come in", () => {
    const merged = mergeResults(new Map([[7, result(7, 12, "ready")]]), [result(7, 0, "created")]);
    expect(merged.get(7)).toMatchObject({ status: "created", group: 12 });
  });

  it("runs steps two at a time and stops after a failed step", async () => {
    const lines = new Map([2, 3, 4, 5].map((n) => [n, importLine(n, { code: String(n) })]));
    let running = 0;
    let most = 0;
    const calls: number[][] = [];
    const importStep = vi.fn(async (sent: ImportLine[]): Promise<StepResponse> => {
      calls.push(sent.map((l) => l.line));
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (sent[0]?.line === 3) return { ok: false, error: "unexpected" };
      return {
        ok: true,
        result: {
          today: "2026-10-14" as never,
          counts: { customers: { ready: 0, created: 1, exists: 0, problem: 0 }, connections: 0 },
          lines: sent.map((l) => result(l.line, 0, "created")),
        },
      };
    });
    const seen: number[] = [];
    const outcome = await runSteps({
      steps: [[2], [3], [4], [5]],
      lines,
      parallel: 2,
      importStep,
      onStep: (results) => seen.push(...results.map((r) => r.line)),
    });
    expect(outcome).toBe("stopped");
    expect(most).toBe(2);
    expect(calls).toEqual([[2], [3], [4]]);
    expect(seen.sort()).toEqual([2, 4]);
  });

  it("reads the download's file name", () => {
    expect(
      fileNameFrom(
        "attachment; filename=\"customers-form.xlsx\"; filename*=UTF-8''grahak%20form.xlsx",
        "x",
      ),
    ).toBe("grahak form.xlsx");
    expect(fileNameFrom('attachment; filename="a.csv"', "x")).toBe("a.csv");
    expect(fileNameFrom(null, "x.csv")).toBe("x.csv");
  });
});

describe("import wizard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const LINES = [
    importLine(2, { code: "101", name: "Ramesh Kumar", vcNumber: "VC1", plan: "Basic" }),
    importLine(3, { code: "101", vcNumber: "VC2", rent: "250" }),
    importLine(4, { code: "102", name: "Sunita", phone: "12" }),
    importLine(5, { code: "500", name: "Old" }),
  ];
  const PREVIEW: ImportPreview = {
    today: "2026-10-14" as never,
    counts: { customers: { ready: 1, created: 0, exists: 1, problem: 1 }, connections: 2 },
    steps: [[2, 3]],
    lines: [
      result(2, 0, "ready", { hasConnection: true }),
      result(3, 0, "ready", { hasConnection: true }),
      result(4, 1, "problem", { problems: [{ field: "phone", code: "invalid" }] }),
      result(5, 2, "exists", { customer: { id: "c500", code: "500", name: "Old" } }),
    ],
  };
  const CHECKED: CheckResponse = {
    ok: true,
    file: { name: "list.xlsx", format: "xlsx", warnings: [], unusedColumns: ["Remarks"] },
    lines: LINES,
    preview: PREVIEW,
  };
  const LIMITS = { rows: 5000, megabytes: 4, fileBytes: 4 * 1024 * 1024, parallelSteps: 2 };

  function stubFetch(response: unknown) {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => response }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** Next is async in the Stepper (it awaits `onNext`). */
  async function next() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /next|आगे/i }));
    });
  }

  async function upload(file = new File(["x"], "list.xlsx")) {
    await next();
    const input = await screen.findByLabelText("The filled form (.xlsx or .csv)");
    fireEvent.change(input, { target: { files: [file] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the file/i }));
    });
  }

  it("step 1 offers the Excel and CSV forms in both languages", () => {
    renderWithIntl(<ImportWizard importStep={vi.fn()} otherLanguage="hi" limits={LIMITS} />);
    expect(screen.getByRole("link", { name: /download excel form/i })).toHaveAttribute(
      "href",
      "/customers/import/template?format=xlsx",
    );
    expect(screen.getByRole("link", { name: /download csv form/i })).toHaveAttribute(
      "href",
      "/customers/import/template?format=csv",
    );
    expect(screen.getByRole("link", { name: "Excel" })).toHaveAttribute(
      "href",
      "/customers/import/template?format=xlsx&lang=hi",
    );
    expect(screen.getByText("Up to 5,000 lines and 4 MB in one file.")).toBeInTheDocument();
  });

  it("stays on the upload step with the file's problem in words", async () => {
    const fetchMock = stubFetch({
      ok: false,
      error: { code: "missing_columns", fields: ["code", "name"] },
    });
    renderWithIntl(<ImportWizard importStep={vi.fn()} otherLanguage="hi" limits={LIMITS} />);
    await next();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the file/i }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the file first.");
    expect(fetchMock).not.toHaveBeenCalled();
    const input = screen.getByLabelText("The filled form (.xlsx or .csv)");
    fireEvent.change(input, { target: { files: [new File(["x"], "list.csv")] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the file/i }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "These columns are missing: Customer code, Name.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/customers/import/check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("previews, adds the ready customers in steps, and shows the result", async () => {
    stubFetch(CHECKED);
    const importStep = vi.fn(
      async (sent: ImportLine[]): Promise<StepResponse> => ({
        ok: true,
        result: {
          today: "2026-10-14" as never,
          counts: { customers: { ready: 0, created: 1, exists: 0, problem: 0 }, connections: 2 },
          lines: sent.map((l) =>
            result(l.line, 0, "created", {
              hasConnection: true,
              customer: { id: "c101", code: "101", name: "Ramesh Kumar" },
            }),
          ),
        },
      }),
    );
    renderWithIntl(<ImportWizard importStep={importStep} otherLanguage="hi" limits={LIMITS} />);
    await upload();

    expect(await screen.findByText("1 customer ready to add")).toBeInTheDocument();
    expect(screen.getByText("with 2 connections (VC)")).toBeInTheDocument();
    expect(screen.getByText("1 already in the app: not changed")).toBeInTheDocument();
    expect(screen.getByText("1 customer has a problem: not added")).toBeInTheDocument();
    expect(screen.getByText("These columns were not used: Remarks.")).toBeInTheDocument();
    // The problem filter is open first, with what to fix.
    const table = screen.getAllByRole("table")[0] as HTMLElement;
    expect(within(table).getByText("Mobile no. is not a phone number.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /all lines/i }));
    expect(within(table).getAllByRole("row")).toHaveLength(5);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add 1 customer" }));
    });
    expect(importStep).toHaveBeenCalledTimes(1);
    expect(importStep.mock.calls[0]?.[0].map((l: ImportLine) => l.line)).toEqual([2, 3]);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument());
    expect(screen.getByText("1 customer added")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download as excel/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open customers" })).toHaveAttribute(
      "href",
      "/customers",
    );
  });

  it("says to upload again when a step fails", async () => {
    stubFetch(CHECKED);
    const importStep = vi.fn(
      async (): Promise<StepResponse> => ({ ok: false, error: "unexpected" }),
    );
    renderWithIntl(<ImportWizard importStep={importStep} otherLanguage="hi" limits={LIMITS} />);
    await upload();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Add 1 customer" }));
    });
    expect(await screen.findByText(/The import stopped/)).toBeInTheDocument();
    expect(screen.getByText("0 customers added")).toBeInTheDocument();
  });

  it("works in Hindi", async () => {
    stubFetch(CHECKED);
    renderWithIntl(<ImportWizard importStep={vi.fn()} otherLanguage="en" limits={LIMITS} />, "hi");
    expect(screen.getByRole("link", { name: "Excel फ़ॉर्म डाउनलोड करें" })).toBeInTheDocument();
    await next();
    const input = await screen.findByLabelText("भरा हुआ फ़ॉर्म (.xlsx या .csv)");
    fireEvent.change(input, { target: { files: [new File(["x"], "list.xlsx")] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "फ़ाइल जाँचें" }));
    });
    expect(await screen.findByText("1 ग्राहक जोड़ने के लिए तैयार")).toBeInTheDocument();
    expect(screen.getAllByText("मोबाइल नंबर सही नहीं है।").length).toBeGreaterThan(0);
  });
});

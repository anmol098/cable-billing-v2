/**
 * Pure rules of the customer import (T-084): reading a date or a rent the way people write them in
 * spreadsheets, grouping lines into customers, and the checks that need no database. The field
 * checks run the **same Zod inputs as the services** (`CreateCustomerInput`, `ConnectionFields`),
 * so a line that passes here fails at import only for a reason the database knows (a VC taken in
 * the meantime, …), and then the service's own error is reported.
 */
import { normalizeCustomerCode, normalizeVcNumber } from "@cb/db";
import {
  type BusinessDate,
  businessDateFromParts,
  isBusinessDate,
  type Paise,
  parseRupeesInput,
} from "@cb/domain";
import type { z } from "zod";
import { ConnectionFields } from "../connections/inputs";
import { CONNECTION_LIMITS, startDateProblem } from "../connections/rules";
import { CreateCustomerInput } from "../customers/customers";
import type { ImportField } from "./columns";
import type { ImportLine } from "./file";

/** What is wrong with one field of one line. `params` fill in the message ("line {line}"). */
export interface LineProblem {
  /** The field, or `line` for the whole line. */
  readonly field: ImportField | "line";
  readonly code: LineProblemCode;
  readonly params?: Readonly<Record<string, string | number>>;
}

export type LineProblemCode =
  // field checks
  | "required"
  | "too_long"
  | "invalid"
  | "decimal"
  | "negative"
  | "too_large"
  | "in_future"
  | "too_old"
  // file checks
  | "name_differs"
  | "differs"
  | "repeated"
  | "too_many_boxes"
  | "box_needed"
  | "plan_or_rent"
  | "same_customer"
  // database checks
  | "not_found"
  | "hidden"
  | "retired"
  | "rent_differs"
  | "in_use"
  | "billed_period"
  // the import step itself
  | "not_saved";

// ---------------------------------------------------------------------------------------------
// Dates and rents as written in spreadsheets
// ---------------------------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function fullYear(text: string): number {
  const year = Number(text);
  return text.length <= 2 ? 2000 + year : year;
}

function dateFrom(year: number, month: number, day: number): BusinessDate | null {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return isBusinessDate(iso) ? businessDateFromParts({ year, month, day }) : null;
}

/**
 * A start day as people write it in India → `YYYY-MM-DD`. Day first (never US month-first):
 * `15/10/2026`, `15-10-26`, `15.10.2026`, `15 Oct 2026`, `15-Oct-26`, `Oct 15, 2026`; also ISO
 * `2026-10-15` (and `2026/10/15`). An Excel date cell already arrives as ISO. `null` = unreadable.
 */
export function parseImportDate(text: string): BusinessDate | null {
  const value = text.trim().replace(/\s+/g, " ");
  if (value === "") return null;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(value);
  if (match) return dateFrom(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(value);
  if (match) return dateFrom(fullYear(match[3] ?? ""), Number(match[2]), Number(match[1]));
  match = /^(\d{1,2})(?:st|nd|rd|th)?[-/. ]([a-z]{3,9})[-/., ]+(\d{2}|\d{4})$/i.exec(value);
  if (match) {
    const month =
      MONTHS[(match[2] ?? "").toLowerCase().slice(0, 4)] ??
      MONTHS[(match[2] ?? "").toLowerCase().slice(0, 3)];
    return month ? dateFrom(fullYear(match[3] ?? ""), month, Number(match[1])) : null;
  }
  match = /^([a-z]{3,9})[-/. ](\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(value);
  if (match) {
    const month =
      MONTHS[(match[1] ?? "").toLowerCase().slice(0, 4)] ??
      MONTHS[(match[1] ?? "").toLowerCase().slice(0, 3)];
    return month ? dateFrom(Number(match[3]), month, Number(match[2])) : null;
  }
  return null;
}

export type RentProblem = "invalid" | "decimal" | "negative" | "too_large";

/**
 * A monthly rent in whole rupees → paise. Accepts what spreadsheets hold: `450`, `₹450`,
 * `Rs. 450`, `INR 450`, `450/-`, `1,200`, `450.00` (a zero decimal part from number formatting).
 * Refuses paise (`450.50`), negatives and text. `null` value = the cell was empty.
 */
export function parseImportRent(
  text: string,
): { ok: true; paise: Paise | null } | { ok: false; problem: RentProblem } {
  const cleaned = text
    .trim()
    .replace(/^(?:rs\.?|inr)\s*/i, "")
    .replace(/\s*\/-$/, "")
    .replace(/\.0+$/, "");
  const parsed = parseRupeesInput(cleaned);
  if (!parsed.ok) {
    return { ok: false, problem: parsed.error === "too-large" ? "too_large" : parsed.error };
  }
  return { ok: true, paise: parsed.value.paise };
}

// ---------------------------------------------------------------------------------------------
// Groups: the lines of one customer
// ---------------------------------------------------------------------------------------------

/** The lines of one customer (same normalised code), in file order. */
export interface CustomerGroup {
  /** The normalised customer code ("" for a line without a code: its own group). */
  readonly codeKey: string;
  readonly lines: readonly ImportLine[];
}

/** Groups lines by normalised customer code; lines without a code are each their own group. */
export function groupLines(lines: readonly ImportLine[]): CustomerGroup[] {
  const groups: { codeKey: string; lines: ImportLine[] }[] = [];
  const byCode = new Map<string, { codeKey: string; lines: ImportLine[] }>();
  for (const line of lines) {
    const codeKey = normalizeCustomerCode(line.values.code);
    if (codeKey === "") {
      groups.push({ codeKey, lines: [line] });
      continue;
    }
    const group = byCode.get(codeKey);
    if (group) {
      group.lines.push(line);
    } else {
      const created = { codeKey, lines: [line] };
      byCode.set(codeKey, created);
      groups.push(created);
    }
  }
  return groups;
}

/** Names compared the way people mean them: case and spacing ignored. */
function sameText(a: string, b: string): boolean {
  const key = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return key(a) === key(b);
}

/** Boxes per customer (the "Add customer" service's limit). */
const MAX_BOXES = CONNECTION_LIMITS.connectionsPerCustomer;

const CUSTOMER_FIELDS = ["name", "phone", "altPhone", "address", "area"] as const;
const CONNECTION_FIELDS = ["vcNumber", "plan", "rent", "startDate"] as const;

/** The connection part of a line is filled in (any of VC, plan, rent, start day). */
export function hasConnection(line: ImportLine): boolean {
  return CONNECTION_FIELDS.some((field) => line.values[field] !== "");
}

/** Problems collected per line number. */
export class LineProblems {
  private readonly byLine = new Map<number, LineProblem[]>();

  add(line: number, problem: LineProblem): void {
    const list = this.byLine.get(line);
    if (list) {
      if (!list.some((p) => p.field === problem.field && p.code === problem.code)) {
        list.push(problem);
      }
    } else {
      this.byLine.set(line, [problem]);
    }
  }

  of(line: number): readonly LineProblem[] {
    return this.byLine.get(line) ?? [];
  }

  has(line: number): boolean {
    return (this.byLine.get(line)?.length ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Field checks (the services' own Zod inputs)
// ---------------------------------------------------------------------------------------------

const CUSTOMER_PATHS: Readonly<Record<string, ImportField>> = {
  customerCode: "code",
  name: "name",
  phone: "phone",
  altPhone: "altPhone",
  address: "address",
};

const CONNECTION_PATHS: Readonly<Record<string, ImportField>> = {
  vcNumber: "vcNumber",
  planId: "plan",
  rentalPaise: "rent",
  startDate: "startDate",
};

function problemCodeOf(issue: z.core.$ZodIssue): LineProblemCode {
  if (issue.code === "too_big") return "too_long";
  if (issue.code === "too_small") return "required";
  if (issue.message === "code_too_long") return "too_long";
  return "invalid";
}

function issuesToProblems(
  issues: readonly z.core.$ZodIssue[],
  paths: Readonly<Record<string, ImportField>>,
): LineProblem[] {
  const problems: LineProblem[] = [];
  for (const issue of issues) {
    const field = paths[String(issue.path[0] ?? "")];
    if (!field) continue;
    if (field === "plan" && issue.message === "plan_or_amount") {
      problems.push({ field, code: "plan_or_rent" });
    } else {
      problems.push({ field, code: problemCodeOf(issue) });
    }
  }
  return problems;
}

/** The customer's input for `customers.create` from its first line (Zod-checked). */
export function customerInputOf(
  line: ImportLine,
):
  | { ok: true; input: z.output<typeof CreateCustomerInput> }
  | { ok: false; problems: LineProblem[] } {
  const v = line.values;
  if (v.code === "") return { ok: false, problems: [{ field: "code", code: "required" }] };
  const parsed = CreateCustomerInput.safeParse({
    customerCode: v.code,
    name: v.name,
    phone: v.phone,
    altPhone: v.altPhone,
    address: v.address,
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, problems: issuesToProblems(parsed.error.issues, CUSTOMER_PATHS) };
}

/** A connection line before its plan name is looked up. */
export interface ConnectionDraft {
  readonly line: number;
  readonly vcNumber: string;
  readonly vcKey: string;
  readonly planName: string;
  readonly rentPaise: Paise | null;
  readonly startDate: BusinessDate;
}

/** Checks a line's connection part without the database. `today` fills an empty start day. */
export function connectionDraftOf(
  line: ImportLine,
  today: BusinessDate,
): { ok: true; draft: ConnectionDraft } | { ok: false; problems: LineProblem[] } {
  const v = line.values;
  const problems: LineProblem[] = [];
  if (v.vcNumber === "") {
    problems.push({ field: "vcNumber", code: "box_needed" });
    return { ok: false, problems };
  }
  const rent = parseImportRent(v.rent);
  if (!rent.ok) problems.push({ field: "rent", code: rent.problem });
  let startDate = today;
  if (v.startDate !== "") {
    const parsed = parseImportDate(v.startDate);
    if (parsed === null) {
      problems.push({ field: "startDate", code: "invalid" });
    } else {
      const dateProblem = startDateProblem({ date: parsed, today });
      if (dateProblem) problems.push({ field: "startDate", code: dateProblem });
      startDate = parsed;
    }
  }
  const paise = rent.ok ? rent.paise : null;
  if (v.plan === "" && rent.ok && paise === null) {
    problems.push({ field: "plan", code: "plan_or_rent" });
  }
  // The service's own schema for the VC number, rent range and date (plan id comes later).
  const shape = ConnectionFields.safeParse({
    vcNumber: v.vcNumber,
    planId: null,
    rentalPaise: paise ?? 0,
    startDate,
  });
  if (!shape.success) {
    for (const problem of issuesToProblems(shape.error.issues, CONNECTION_PATHS)) {
      if (problem.field === "rent" && !rent.ok) continue;
      if (problem.field === "rent") problems.push({ field: "rent", code: "too_large" });
      else problems.push(problem);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    draft: {
      line: line.line,
      vcNumber: shape.success ? shape.data.vcNumber : v.vcNumber,
      vcKey: normalizeVcNumber(v.vcNumber),
      planName: v.plan,
      rentPaise: paise,
      startDate,
    },
  };
}

/** The checks that need only the file: names per code, repeated VCs, too many boxes. */
export function checkGroups(groups: readonly CustomerGroup[], problems: LineProblems): void {
  const vcFirstLine = new Map<string, number>();
  for (const group of groups) {
    const [first, ...rest] = group.lines;
    if (!first) continue;
    for (const line of rest) {
      if (line.values.name !== "" && !sameText(line.values.name, first.values.name)) {
        problems.add(line.line, {
          field: "name",
          code: "name_differs",
          params: { line: first.line },
        });
      }
      for (const field of CUSTOMER_FIELDS) {
        if (field === "name") continue;
        const value = line.values[field];
        if (value !== "" && !sameText(value, first.values[field])) {
          problems.add(line.line, { field, code: "differs", params: { line: first.line } });
        }
      }
    }
    const boxes = group.lines.filter(hasConnection);
    boxes.forEach((line, index) => {
      if (index >= MAX_BOXES) problems.add(line.line, { field: "line", code: "too_many_boxes" });
    });
    // At most one line per box plus one for the details, so a customer always fits in one step.
    group.lines.forEach((line, index) => {
      if (index > MAX_BOXES) problems.add(line.line, { field: "line", code: "too_many_boxes" });
    });
    // A customer line without a box next to box lines of the same customer is fine (it carries
    // the details); a code that appears twice without any box is the same customer twice.
    for (const line of group.lines) {
      const vcKey = normalizeVcNumber(line.values.vcNumber);
      if (vcKey === "") continue;
      const seen = vcFirstLine.get(vcKey);
      if (seen !== undefined) {
        problems.add(line.line, { field: "vcNumber", code: "repeated", params: { line: seen } });
      } else {
        vcFirstLine.set(vcKey, line.line);
      }
    }
  }
}

/** Every line of a group with a problem gets "fix the other line(s) of this customer". */
export function spreadGroupProblems(group: CustomerGroup, problems: LineProblems): boolean {
  const bad = group.lines.filter((line) => problems.has(line.line)).map((line) => line.line);
  if (bad.length === 0) return false;
  for (const line of group.lines) {
    if (!problems.has(line.line)) {
      problems.add(line.line, {
        field: "line",
        code: "same_customer",
        params: { lines: bad.join(", ") },
      });
    }
  }
  return true;
}

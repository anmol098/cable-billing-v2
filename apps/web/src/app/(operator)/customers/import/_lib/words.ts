/**
 * Words of the import (T-084), shared by the page (client) and the file routes (server): field
 * labels and a problem in plain words. Client-safe: only **types** come from `@cb/core` (a value
 * import would pull the database code into the browser bundle).
 */
import type { ImportField, LineProblem } from "@cb/core";
import {
  type BusinessDate,
  type DisplayLocale,
  formatBusinessDate,
  isBusinessDate,
} from "@cb/domain";

/** The import's fields in template order (a test keeps it equal to `@cb/core` `IMPORT_FIELDS`). */
export const FIELDS = [
  "code",
  "name",
  "phone",
  "altPhone",
  "address",
  "area",
  "vcNumber",
  "plan",
  "rent",
  "startDate",
] as const satisfies readonly ImportField[];

/** Field → its key in the `import` namespace (`field.*`, `template.columns.*`, `problem.*`). */
export const FIELD_KEY: Readonly<Record<ImportField | "line", string>> = {
  code: "code",
  name: "name",
  phone: "phone",
  altPhone: "alt_phone",
  address: "address",
  area: "area",
  vcNumber: "vc_number",
  plan: "plan",
  rent: "rent",
  startDate: "start_date",
  line: "line",
};

/** A next-intl translator for the `import` namespace, with string keys (keys are built here). */
export interface ImportWords {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

function dateText(value: string | number | undefined, locale: DisplayLocale): string {
  const text = String(value ?? "");
  return isBusinessDate(text) ? formatBusinessDate(text as BusinessDate, locale) : text;
}

/**
 * One problem in words, e.g. "Mobile no. is not a phone number." A specific message
 * (`problem.<field>.<code>`) wins; otherwise the general one (`problem.any.<code>`) with the field's
 * label; otherwise "<field> is not right."
 */
export function problemText(t: ImportWords, problem: LineProblem, locale: DisplayLocale): string {
  const field = FIELD_KEY[problem.field];
  const params = problem.params ?? {};
  const values: Record<string, string | number> = { ...params, field: t(`field.${field}`) };
  let code: string = problem.code;
  if (problem.field === "vcNumber" && problem.code === "in_use") {
    if (!params.code) code = "in_use_other";
    else if (params.from) code = "in_use_until";
    values.from = dateText(params.from, locale);
  }
  for (const key of [`problem.${field}.${code}`, `problem.any.${code}`]) {
    if (t.has(key)) return t(key, values);
  }
  return t("problem.any.invalid", values);
}

/** All problems of a line, one sentence after another. */
export function problemsText(
  t: ImportWords,
  problems: readonly LineProblem[],
  locale: DisplayLocale,
): string {
  return problems.map((problem) => problemText(t, problem, locale)).join(" ");
}

/** Bytes → whole MB for messages ("4"). */
export function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

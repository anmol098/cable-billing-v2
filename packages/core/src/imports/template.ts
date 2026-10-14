/**
 * The files the import page offers (T-084): the empty template and the "lines with problems"
 * file. The words (headers, sheet names, help lines, problem texts) come from the caller (the web
 * app's i18n namespace `import`), so both languages work; this module only lays them out.
 *
 * - The template has the header row only (no example customers that could be imported by
 *   mistake). The .xlsx adds a second sheet with the help lines; its columns are Text, so codes,
 *   mobile numbers and VC numbers keep leading zeros.
 * - The problem file has the same columns plus "Line" and "Problem" first; the import ignores
 *   those two, so people fix the cells and upload the same file again. CSV cells are protected
 *   against formula injection (`writeCsv`); .xlsx cells are text cells, never formulas.
 */
import { IMPORT_FIELDS, type ImportField } from "./columns";
import { writeCsv } from "./csv";
import { writeXlsx } from "./xlsx/write";

export type ImportFileKind = "xlsx" | "csv";

export interface ImportTemplateWords {
  /** The first sheet's name ("Customers"). */
  readonly sheetName: string;
  readonly headers: Readonly<Record<ImportField, string>>;
  /** The help sheet's name ("How to fill"). */
  readonly helpSheetName: string;
  /** One instruction per row of the help sheet. */
  readonly helpLines: readonly string[];
}

const WIDTHS: Readonly<Record<ImportField, number>> = {
  code: 14,
  name: 26,
  phone: 16,
  altPhone: 16,
  address: 32,
  area: 18,
  vcNumber: 20,
  plan: 18,
  rent: 14,
  startDate: 14,
};

export const IMPORT_CONTENT_TYPES: Readonly<Record<ImportFileKind, string>> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

/** The empty template. */
export function buildImportTemplate(kind: ImportFileKind, words: ImportTemplateWords): Uint8Array {
  const header = IMPORT_FIELDS.map((field) => words.headers[field]);
  if (kind === "csv") return writeCsv([header]);
  return writeXlsx([
    {
      name: words.sheetName,
      rows: [header],
      widths: IMPORT_FIELDS.map((field) => WIDTHS[field]),
    },
    {
      name: words.helpSheetName,
      rows: words.helpLines.map((line) => [line]),
      widths: [110],
      header: false,
    },
  ]);
}

export interface ProblemFileWords {
  readonly sheetName: string;
  readonly headers: Readonly<Record<ImportField, string>>;
  readonly line: string;
  readonly problem: string;
}

export interface ProblemFileRow {
  readonly line: number;
  readonly values: Readonly<Record<ImportField, string>>;
  /** What is wrong, in words. */
  readonly problem: string;
}

/** The lines that were not added, with what is wrong, ready to fix and upload again. */
export function buildProblemFile(
  kind: ImportFileKind,
  words: ProblemFileWords,
  rows: readonly ProblemFileRow[],
): Uint8Array {
  const table = [
    [words.line, words.problem, ...IMPORT_FIELDS.map((field) => words.headers[field])],
    ...rows.map((row) => [
      String(row.line),
      row.problem,
      ...IMPORT_FIELDS.map((field) => row.values[field] ?? ""),
    ]),
  ];
  if (kind === "csv") return writeCsv(table);
  return writeXlsx([
    {
      name: words.sheetName,
      rows: table,
      widths: [8, 48, ...IMPORT_FIELDS.map((field) => WIDTHS[field])],
    },
  ]);
}

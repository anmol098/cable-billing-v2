/**
 * Uploaded file → the import's lines (T-084): format detection, the header row, which column is
 * which field, and every cell as the text the field checks read.
 *
 * Nothing here looks at the database; {@link readImportFile} is pure and safe to run on any
 * bytes (size, row, column, cell and zip limits from {@link IMPORT_LIMITS}).
 */
import { err, ok, type Result } from "@cb/domain";
import {
  fieldForHeader,
  IGNORED_COLUMN,
  IMPORT_FIELDS,
  type ImportField,
  REQUIRED_IMPORT_FIELDS,
} from "./columns";
import { decodeCsvBytes, parseCsv, type TextEncoding, unescapeCsvCell } from "./csv";
import { IMPORT_LIMITS } from "./limits";
import { type Cell, cellText, excelSerialToDate, type Grid, numberText } from "./xlsx/cells";
import { readXlsx, XlsxError } from "./xlsx/read";
import { looksLikeZip } from "./xlsx/zip";

/** One line of the file: its row number and the text of each field ("" when empty). */
export interface ImportLine {
  readonly line: number;
  readonly values: Readonly<Record<ImportField, string>>;
}

export type ImportFileFormat = "xlsx" | "csv";

export interface ImportTable {
  readonly format: ImportFileFormat;
  /** CSV only. `windows-1252` means Hindi letters were probably lost (see `warnings`). */
  readonly encoding: TextEncoding | null;
  /** `not_utf8`: a CSV not saved as UTF-8; Hindi letters may have turned into `?`. */
  readonly warnings: readonly "not_utf8"[];
  /** The header row's number. */
  readonly headerLine: number;
  /** Which fields the file has a column for. */
  readonly fields: readonly ImportField[];
  /** Header texts of columns that were not used (unknown names). */
  readonly unusedColumns: readonly string[];
  /** The data lines, blank lines left out. */
  readonly lines: readonly ImportLine[];
}

export type ImportFileProblemCode =
  | "too_big"
  | "empty"
  | "unreadable"
  | "old_excel"
  | "no_header"
  | "missing_columns"
  | "duplicate_column"
  | "too_many_lines";

export interface ImportFileProblem {
  readonly code: ImportFileProblemCode;
  /** `missing_columns` / `duplicate_column`: which fields. */
  readonly fields?: readonly ImportField[];
}

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

/** Raw rows read at most: the line limit plus room for a title above the header. */
const MAX_GRID_ROWS = IMPORT_LIMITS.rows + IMPORT_LIMITS.headerSearchRows + 1;

function problem(code: ImportFileProblemCode, fields?: readonly ImportField[]) {
  return err<ImportFileProblem>(fields ? { code, fields } : { code });
}

/** Spaces people don't see (no-break, zero-width) → plain; trimmed. */
function tidy(text: string): string {
  return text.replace(/[   ]/g, " ").replace(/[​⁠﻿]/g, "").trim();
}

/** Excel serials for 2000-01-01 … 2099-12-31: a number in the date column in that range is a date. */
const SERIAL_2000 = 36526;
const SERIAL_2100 = 73051;

/** A cell → the text its field reads. */
export function fieldText(field: ImportField, cell: Cell | undefined, csv: boolean): string {
  if (!cell) return "";
  if (field === "startDate") {
    if (cell.kind === "date") return cell.date;
    if (cell.kind === "number" && cell.value >= SERIAL_2000 && cell.value < SERIAL_2100) {
      return excelSerialToDate(cell.value) ?? numberText(cell.value);
    }
  }
  const text = tidy(cellText(cell));
  return csv ? unescapeCsvCell(text) : text;
}

interface HeaderMatch {
  readonly index: number;
  readonly columns: readonly (ImportField | typeof IGNORED_COLUMN | null)[];
  readonly known: number;
}

function findHeader(grid: Grid): HeaderMatch | null {
  let best: HeaderMatch | null = null;
  const searched = grid.slice(0, IMPORT_LIMITS.headerSearchRows);
  searched.forEach((row, index) => {
    const columns = row.cells.map((cell) =>
      cell && cell.kind === "text" ? fieldForHeader(cell.text) : null,
    );
    const known = columns.filter((field) => field !== null && field !== IGNORED_COLUMN).length;
    if (known > 0 && (!best || known > best.known)) best = { index, columns, known };
  });
  return best;
}

/** Reads an uploaded file into lines, or says in one code what is wrong with the whole file. */
export function readImportFile(bytes: Uint8Array): Result<ImportTable, ImportFileProblem> {
  if (bytes.length > IMPORT_LIMITS.fileBytes) return problem("too_big");
  if (bytes.length === 0) return problem("empty");
  if (OLE_SIGNATURE.every((byte, index) => bytes[index] === byte)) return problem("old_excel");

  let grid: Grid;
  let format: ImportFileFormat;
  let encoding: TextEncoding | null = null;
  if (looksLikeZip(bytes)) {
    format = "xlsx";
    try {
      grid = readXlsx(bytes, {
        partBytes: IMPORT_LIMITS.xlsxPartBytes,
        maxRows: MAX_GRID_ROWS,
        maxColumns: IMPORT_LIMITS.columns,
        maxCellChars: IMPORT_LIMITS.cellChars,
      });
    } catch (error) {
      if (error instanceof XlsxError && error.reason === "too_big") return problem("too_big");
      return problem("unreadable");
    }
  } else {
    format = "csv";
    const decoded = decodeCsvBytes(bytes);
    encoding = decoded.encoding;
    // Binary that is not a spreadsheet (a photo, a PDF): NUL bytes in "text".
    if (decoded.text.includes("\u0000")) return problem("unreadable");
    grid = parseCsv(decoded.text, {
      maxRows: MAX_GRID_ROWS,
      maxColumns: IMPORT_LIMITS.columns,
      maxCellChars: IMPORT_LIMITS.cellChars,
    });
  }
  if (grid.length === 0) return problem("empty");

  const header = findHeader(grid);
  if (!header) return problem("no_header");
  const seen = new Set<ImportField>();
  const duplicates: ImportField[] = [];
  const unusedColumns: string[] = [];
  const headerRow = grid[header.index];
  header.columns.forEach((field, index) => {
    if (field === null) {
      const cell = headerRow?.cells[index];
      const text = cell ? tidy(cellText(cell)) : "";
      if (text !== "") unusedColumns.push(text);
    } else if (field !== IGNORED_COLUMN) {
      if (seen.has(field)) duplicates.push(field);
      seen.add(field);
    }
  });
  if (duplicates.length > 0) return problem("duplicate_column", duplicates);
  const missing = REQUIRED_IMPORT_FIELDS.filter((field) => !seen.has(field));
  if (missing.length > 0) return problem("missing_columns", missing);

  const csv = format === "csv";
  const lines: ImportLine[] = [];
  for (const row of grid.slice(header.index + 1)) {
    const values = {} as Record<ImportField, string>;
    for (const field of IMPORT_FIELDS) values[field] = "";
    header.columns.forEach((field, index) => {
      if (field === null || field === IGNORED_COLUMN) return;
      values[field] = fieldText(field, row.cells[index], csv);
    });
    if (IMPORT_FIELDS.every((field) => values[field] === "")) continue;
    lines.push({ line: row.line, values });
  }
  if (lines.length > IMPORT_LIMITS.rows || grid.length >= MAX_GRID_ROWS) {
    return problem("too_many_lines");
  }
  if (lines.length === 0) return problem("empty");
  return ok({
    format,
    encoding,
    warnings: encoding === "windows-1252" ? ["not_utf8"] : [],
    headerLine: headerRow?.line ?? 1,
    fields: IMPORT_FIELDS.filter((field) => seen.has(field)),
    unusedColumns,
    lines,
  });
}

/**
 * CSV for the customer import (T-084): reading what Excel, LibreOffice and Google Sheets save,
 * and writing the template / problem file safely.
 *
 * Reading:
 * - **Encoding**: a UTF-8 or UTF-16 byte-order mark wins; UTF-16 without a mark is recognised by
 *   its zero bytes; otherwise strict UTF-8, and if the bytes are not UTF-8 they are read as
 *   Windows-1252 ("CSV (comma delimited)" from Excel on Windows) and the result says so, because
 *   Hindi letters do not survive that format.
 * - **Separator**: comma, semicolon or tab, whichever the header line uses most (outside quotes).
 * - RFC 4180 quoting (`"a, b"`, `""` inside quotes, line breaks inside quotes), CRLF / LF / CR.
 *
 * Writing ({@link writeCsv}): UTF-8 with a byte-order mark (so Excel shows Hindi), CRLF, quotes
 * where needed, and **formula-injection protection**: a cell that starts with `=`, `+`, `-`, `@`,
 * tab or carriage return gets a leading `'` (OWASP "CSV injection"), so a spreadsheet shows it as
 * text instead of running it. {@link unescapeCsvCell} removes that `'` again when such a file is
 * uploaded back.
 */
import { type Cell, type Grid, type GridRow, isBlankCell, textCell } from "./xlsx/cells";

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
}

/** Decodes uploaded CSV bytes (see the module comment). */
export function decodeCsvBytes(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }
  if (bytes.length >= 4 && bytes[0] !== 0 && bytes[1] === 0 && bytes[3] === 0) {
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0 && bytes[1] !== 0) {
    return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

const SEPARATORS = [",", ";", "\t"] as const;

/** The separator the first non-empty line uses most, outside quotes (comma when none). */
export function detectSeparator(text: string): string {
  let line = "";
  for (const candidate of text.split(/\r\n|\n|\r/)) {
    if (candidate.trim() !== "") {
      line = candidate;
      break;
    }
  }
  const counts = new Map<string, number>(SEPARATORS.map((s) => [s, 0]));
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best = ",";
  let bestCount = 0;
  for (const separator of SEPARATORS) {
    const count = counts.get(separator) ?? 0;
    if (count > bestCount) {
      best = separator;
      bestCount = count;
    }
  }
  return best;
}

export interface CsvParseLimits {
  /** Rows to read at most (the caller asks for one more than it allows). */
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellChars: number;
}

/** Parses CSV text into the non-empty rows of text cells (each with its record number). */
export function parseCsv(text: string, limits: CsvParseLimits, separator?: string): Grid {
  const sep = separator ?? detectSeparator(text);
  const rows: GridRow[] = [];
  let row: Cell[] = [];
  let line = 1;
  let field = "";
  let quoted = false;
  let index = 0;
  const length = text.length;

  const endField = () => {
    if (row.length < limits.maxColumns) row.push(textCell(field.slice(0, limits.maxCellChars)));
    field = "";
  };
  const endRow = () => {
    endField();
    if (!row.every(isBlankCell)) rows.push({ line, cells: row });
    row = [];
    line += 1;
  };

  while (index < length) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field.trim() === "") {
      field = "";
      quoted = true;
      index += 1;
    } else if (char === sep) {
      endField();
      index += 1;
    } else if (char === "\r" || char === "\n") {
      endRow();
      if (rows.length >= limits.maxRows) return rows;
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
    } else {
      field += char;
      index += 1;
    }
  }
  if (field !== "" || row.length > 0 || quoted) endRow();
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** A cell value made safe for a spreadsheet: a leading `'` before `=`, `+`, `-`, `@`, tab, CR. */
export function escapeCsvCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** Undoes {@link escapeCsvCell} on an uploaded cell: `'=1` → `=1`, `'+91…` → `+91…`. */
export function unescapeCsvCell(value: string): string {
  return value.length > 1 && value[0] === "'" && FORMULA_START.test(value.slice(1))
    ? value.slice(1)
    : value;
}

function quoteCsv(value: string): string {
  return /[",;\t\r\n]/.test(value) || value !== value.trim()
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** CSV text (with a UTF-8 byte-order mark) for `rows`; every cell escaped and quoted as needed. */
export function writeCsv(rows: readonly (readonly string[])[]): Uint8Array {
  const text = rows
    .map((row) => row.map((value) => quoteCsv(escapeCsvCell(value))).join(","))
    .join("\r\n");
  return new TextEncoder().encode(`﻿${text}\r\n`);
}

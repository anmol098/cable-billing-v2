/**
 * CSV text for exports (T-082, FR-029). Pure.
 *
 * - **UTF-8 with a byte-order mark** ({@link CSV_BOM}) and CRLF line ends: Excel on Windows opens
 *   the file as UTF-8 only when it starts with a BOM, otherwise Hindi names turn into mojibake.
 * - **Formula injection** (OWASP "CSV injection"): a text cell that a spreadsheet could read as a
 *   formula gets a leading `'`. That is a cell starting with `=`, `+`, `-`, `@`, a tab, CR or LF,
 *   or one of `=`, `+`, `-`, `@` after leading spaces. Names, notes, addresses and codes are typed
 *   by people (and a lineman's phone), so every text cell goes through {@link neutraliseCsvText}.
 * - **Numbers** we make ourselves (rupees, counts) are {@link CsvNumber} cells: checked against a
 *   strict pattern and written bare, so `-50` stays a number. Anything else is text.
 * - **Money**: integer paise → rupees with `paiseToRupeeDigits` (string maths, no floats): whole
 *   rupees as `450`, an amount with paise as `12.50`, no grouping commas, `-` for negatives.
 * - **Times** are IST wall-clock (`2026-10-14 15:30`); business dates stay `YYYY-MM-DD`.
 */
import { IST_OFFSET_MINUTES, paiseToRupeeDigits } from "@cb/domain";

/** The UTF-8 byte-order mark Excel needs to read the file as UTF-8. */
export const CSV_BOM = "﻿";

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** A number cell: digits, an optional `-` and an optional 2-digit fraction (rupees). */
export interface CsvNumber {
  readonly number: string;
}

/** One cell: text (neutralised and quoted as needed), a number, or empty. */
export type CsvCell = string | CsvNumber | null | undefined;

const NUMBER = /^-?\d{1,18}(\.\d{2})?$/;
const FORMULA_START = /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** A text cell made safe for a spreadsheet: a leading `'` when it could start a formula. */
export function neutraliseCsvText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One cell as CSV text. */
export function csvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return quote(neutraliseCsvText(cell));
  // Only numbers we made reach here; anything unexpected is written as (neutralised) text.
  return NUMBER.test(cell.number) ? cell.number : quote(neutraliseCsvText(cell.number));
}

/** One CSV line, ending in CRLF. */
export function csvLine(cells: readonly CsvCell[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** Integer paise → a rupee number cell (`45000` → `450`, `1250` → `12.50`); null → empty. */
export function rupeesCell(paise: number | bigint | null | undefined): CsvNumber | null {
  if (paise === null || paise === undefined) return null;
  return { number: paiseToRupeeDigits(typeof paise === "bigint" ? Number(paise) : paise) };
}

/** A count → a number cell. */
export function countCell(count: number | null | undefined): CsvNumber | null {
  if (count === null || count === undefined || !Number.isSafeInteger(count)) return null;
  return { number: String(count) };
}

/** An instant → IST wall-clock `YYYY-MM-DD HH:mm`. */
export function istDateTime(at: Date): string {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)}`;
}

/** `<kind>-YYYY-MM-DD-HHmm` (IST) for a file name, e.g. `dues-2026-10-14-1530`. */
export function exportFileStem(kind: string, asOf: Date): string {
  const time = istDateTime(asOf);
  return `${kind.replace(/_/g, "-")}-${time.slice(0, 10)}-${time.slice(11, 13)}${time.slice(14, 16)}`;
}

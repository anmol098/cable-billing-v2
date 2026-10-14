/**
 * Cells as read from a spreadsheet (T-084): the grid the CSV and XLSX readers produce, before the
 * import decides what each column means.
 */

/** One cell: text, a number, or a date (an Excel date cell, already as `YYYY-MM-DD`). */
export type Cell =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "date"; readonly date: string };

/** One row that has at least one non-empty cell. */
export interface GridRow {
  /** The row's number as a spreadsheet shows it (1-based; CSV: the record number). */
  readonly line: number;
  /** Cells by column (0-based); a missing cell is `undefined`. */
  readonly cells: readonly (Cell | undefined)[];
}

/** The non-empty rows of a sheet, top to bottom. Empty rows are left out. */
export type Grid = readonly GridRow[];

/** True when the cell holds nothing visible (missing, or text that is only spaces). */
export function isBlankCell(cell: Cell | undefined): boolean {
  return cell === undefined || (cell.kind === "text" && cell.text.trim() === "");
}

export const textCell = (text: string): Cell => ({ kind: "text", text });

/**
 * A number as people write it: integers without exponent or `.0` (`9876543210`, not
 * `9.87654321E9`), other numbers with up to 10 decimals, trailing zeros dropped.
 */
export function numberText(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) {
    return Math.abs(value) < 1e21 ? BigInt(value).toString() : String(value);
  }
  return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

/** The cell as text (numbers as {@link numberText}, dates as `YYYY-MM-DD`). */
export function cellText(cell: Cell | undefined): string {
  if (!cell) return "";
  if (cell.kind === "text") return cell.text;
  if (cell.kind === "number") return numberText(cell.value);
  return cell.date;
}

const DAY_MS = 86_400_000;
/** Excel's day 0 in the 1900 date system is 1899-12-31, but Excel counts 1900-02-29 (Lotus bug),
 * so serials from 61 on are one day ahead: day 1 → 1900-01-01, day 61 → 1900-03-01. */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** An Excel serial date (whole days; the time of day is dropped) → `YYYY-MM-DD`, or null. */
export function excelSerialToDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const days = Math.floor(serial);
  const ms = date1904 ? EPOCH_1904 + days * DAY_MS : EPOCH_1900 + days * DAY_MS;
  if (!date1904 && days < 61) {
    // Before the phantom 1900-02-29 the 1899-12-30 epoch is one day early.
    return new Date(ms + DAY_MS).toISOString().slice(0, 10);
  }
  return new Date(ms).toISOString().slice(0, 10);
}

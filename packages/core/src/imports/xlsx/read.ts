/**
 * Reads the first visible worksheet of an .xlsx file into a {@link Grid} (T-084).
 *
 * What it understands: shared strings (incl. rich text), inline strings, formula results (the
 * cached value; formulas are never evaluated), numbers, booleans (as text), error cells (empty),
 * ISO date cells, and number cells with a date format (→ `YYYY-MM-DD`, 1900 and 1904 date
 * systems). Every part is read with a size limit, and reading stops after `maxRows` rows.
 */
import {
  type Cell,
  excelSerialToDate,
  type Grid,
  type GridRow,
  isBlankCell,
  textCell,
} from "./cells";
import { scanXml, type XmlAttributes, XmlError } from "./xml";
import { openZip, ZipError } from "./zip";

export interface XlsxReadLimits {
  /** Largest uncompressed worksheet / shared strings part, in bytes. */
  readonly partBytes: number;
  /** Rows to read at most (the caller asks for one more than it allows, to detect "too many"). */
  readonly maxRows: number;
  /** Columns to read at most (cells further right are ignored). */
  readonly maxColumns: number;
  /** Longest cell text kept (longer text is cut; the field checks then refuse it). */
  readonly maxCellChars: number;
}

export class XlsxError extends Error {
  constructor(
    readonly reason: "unreadable" | "too_big" | "no_sheet",
    message: string,
  ) {
    super(message);
    this.name = "XlsxError";
  }
}

const SMALL_PART = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8");

type Zip = ReturnType<typeof openZip>;

function readText(zip: Zip, name: string, maxBytes: number): string | null {
  const bytes = zip.read(name, maxBytes);
  return bytes === null ? null : utf8.decode(bytes);
}

/** `worksheets/sheet1.xml` relative to `xl/`, or an absolute `/xl/…` target → a part name. */
function partName(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `xl/${target}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

interface Workbook {
  readonly sheetPart: string;
  readonly date1904: boolean;
}

function readWorkbook(zip: Zip): Workbook {
  const workbook = readText(zip, "xl/workbook.xml", SMALL_PART);
  if (workbook === null) throw new XlsxError("unreadable", "no workbook part");
  const sheets: { id: string; hidden: boolean }[] = [];
  let date1904 = false;
  scanXml(workbook, {
    open(name, attributes) {
      if (name === "sheet") {
        const id = attributes["r:id"] ?? relationshipId(attributes);
        if (id) sheets.push({ id, hidden: (attributes.state ?? "visible") !== "visible" });
      } else if (name === "workbookPr") {
        const value = attributes.date1904;
        date1904 = value === "1" || value === "true";
      }
    },
  });
  const rels = readText(zip, "xl/_rels/workbook.xml.rels", SMALL_PART);
  if (rels === null) throw new XlsxError("unreadable", "no workbook relationships");
  const targets = new Map<string, string>();
  scanXml(rels, {
    open(name, attributes) {
      if (name === "Relationship" && attributes.Id && attributes.Target) {
        targets.set(attributes.Id, attributes.Target);
      }
    },
  });
  const sheet = sheets.find((candidate) => !candidate.hidden) ?? sheets[0];
  const target = sheet ? targets.get(sheet.id) : undefined;
  if (!target) throw new XlsxError("no_sheet", "no worksheet");
  return { sheetPart: partName(target), date1904 };
}

/** Some writers use another prefix for the relationships namespace (`ns1:id`). */
function relationshipId(attributes: XmlAttributes): string | undefined {
  for (const [key, value] of Object.entries(attributes)) {
    if (key.endsWith(":id")) return value;
  }
  return undefined;
}

function readSharedStrings(zip: Zip, limits: XlsxReadLimits): string[] {
  const xml = readText(zip, "xl/sharedStrings.xml", limits.partBytes);
  if (xml === null) return [];
  const strings: string[] = [];
  let current: string[] | null = null;
  let inText = false;
  let inPhonetic = 0;
  scanXml(xml, {
    open(name, _attributes, selfClosing) {
      if (name === "si") current = [];
      else if (name === "rPh") inPhonetic += selfClosing ? 0 : 1;
      else if (name === "t" && !selfClosing) inText = true;
    },
    close(name) {
      if (name === "si") {
        strings.push((current ?? []).join("").slice(0, limits.maxCellChars));
        current = null;
      } else if (name === "rPh") {
        inPhonetic = Math.max(0, inPhonetic - 1);
      } else if (name === "t") {
        inText = false;
      }
    },
    text(text) {
      if (inText && inPhonetic === 0 && current) current.push(text);
    },
  });
  return strings;
}

/** Built-in number formats that show a date (ECMA-376 §18.8.30 and common locale variants). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58,
]);

/** A custom format code that shows a date (has d / m / y outside quotes and brackets). */
export function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "");
  if (/^general$/i.test(bare.trim())) return false;
  // `m` alone is ambiguous (month or minute): a date only when there is no hour or second.
  return /[dy]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare));
}

/** For each cell style index: does it show a date? */
function readDateStyles(zip: Zip): boolean[] {
  const xml = readText(zip, "xl/styles.xml", SMALL_PART);
  if (xml === null) return [];
  const custom = new Map<number, boolean>();
  const styles: boolean[] = [];
  let inCellXfs = false;
  scanXml(xml, {
    open(name, attributes) {
      if (name === "numFmt") {
        const id = Number(attributes.numFmtId);
        if (Number.isInteger(id)) custom.set(id, isDateFormatCode(attributes.formatCode ?? ""));
      } else if (name === "cellXfs") {
        inCellXfs = true;
      } else if (name === "xf" && inCellXfs) {
        const id = Number(attributes.numFmtId ?? "0");
        styles.push(custom.get(id) ?? BUILTIN_DATE_FORMATS.has(id));
      }
    },
    close(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
  });
  return styles;
}

/** `B12` → column index 1 (0-based); `null` when there is no column part. */
function columnOf(reference: string | undefined): number | null {
  if (!reference) return null;
  let column = 0;
  let index = 0;
  for (; index < reference.length; index += 1) {
    const code = reference.charCodeAt(index);
    if (code >= 65 && code <= 90) column = column * 26 + (code - 64);
    else if (code >= 97 && code <= 122) column = column * 26 + (code - 96);
    else break;
  }
  return index === 0 ? null : column - 1;
}

function rowOf(reference: string | undefined): number | null {
  if (!reference) return null;
  const match = /(\d+)$/.exec(reference);
  return match ? Number(match[1]) - 1 : null;
}

interface PendingCell {
  column: number;
  type: string;
  style: number;
  value: string[];
  inline: string[];
}

function finishCell(
  cell: PendingCell,
  shared: readonly string[],
  dateStyles: readonly boolean[],
  date1904: boolean,
  maxChars: number,
): Cell | undefined {
  const value = cell.value.join("");
  switch (cell.type) {
    case "s": {
      const text = shared[Number(value)];
      return text === undefined ? undefined : textCell(text);
    }
    case "inlineStr":
      return textCell(cell.inline.join("").slice(0, maxChars));
    case "str":
      return textCell(value.slice(0, maxChars));
    case "b":
      return textCell(value === "1" ? "TRUE" : "FALSE");
    case "e":
      return undefined;
    case "d":
      return /^\d{4}-\d{2}-\d{2}/.test(value)
        ? { kind: "date", date: value.slice(0, 10) }
        : undefined;
    default: {
      if (value.trim() === "") return undefined;
      const number = Number(value);
      if (!Number.isFinite(number)) return textCell(value.slice(0, maxChars));
      if (dateStyles[cell.style]) {
        const date = excelSerialToDate(number, date1904);
        if (date) return { kind: "date", date };
      }
      return { kind: "number", value: number };
    }
  }
}

/** Reads the first visible worksheet. Throws {@link XlsxError}. */
export function readXlsx(data: Uint8Array, limits: XlsxReadLimits): Grid {
  try {
    const zip = openZip(data);
    const { sheetPart, date1904 } = readWorkbook(zip);
    const shared = readSharedStrings(zip, limits);
    const dateStyles = readDateStyles(zip);
    const xml = readText(zip, sheetPart, limits.partBytes);
    if (xml === null) throw new XlsxError("no_sheet", "worksheet part missing");

    const rows: GridRow[] = [];
    let row: (Cell | undefined)[] | null = null;
    let rowLine = 0;
    let nextRow = 0;
    let nextColumn = 0;
    let cell: PendingCell | null = null;
    let inValue = false;
    let inInlineText = false;
    let inSheetData = false;
    let stopped = false;
    scanXml(xml, {
      open(name, attributes, selfClosing) {
        if (stopped) return;
        if (name === "sheetData") {
          inSheetData = true;
        } else if (name === "row" && inSheetData) {
          const index = attributes.r ? Number(attributes.r) - 1 : nextRow;
          if (!Number.isInteger(index) || index < nextRow) throw new XmlError("rows out of order");
          if (rows.length >= limits.maxRows) {
            stopped = true;
            return;
          }
          row = [];
          rowLine = index + 1;
          nextRow = index + 1;
          nextColumn = 0;
        } else if (name === "c" && row) {
          const column = columnOf(attributes.r) ?? nextColumn;
          const at = rowOf(attributes.r);
          if (at !== null && at !== nextRow - 1) throw new XmlError("cell outside its row");
          nextColumn = column + 1;
          cell = selfClosing
            ? null
            : {
                column,
                type: attributes.t ?? "n",
                style: Number(attributes.s ?? "0"),
                value: [],
                inline: [],
              };
        } else if (name === "v" && cell) {
          inValue = !selfClosing;
        } else if (name === "t" && cell && cell.type === "inlineStr") {
          inInlineText = !selfClosing;
        }
      },
      close(name) {
        if (stopped) return;
        if (name === "v") inValue = false;
        else if (name === "t") inInlineText = false;
        else if (name === "c" && cell && row) {
          if (cell.column < limits.maxColumns) {
            const value = finishCell(cell, shared, dateStyles, date1904, limits.maxCellChars);
            if (value) row[cell.column] = value;
          }
          cell = null;
        } else if (name === "row") {
          if (row && !row.every(isBlankCell)) rows.push({ line: rowLine, cells: row });
          row = null;
        } else if (name === "sheetData") {
          inSheetData = false;
        }
      },
      text(text) {
        if (!cell) return;
        if (inValue) cell.value.push(text);
        else if (inInlineText) cell.inline.push(text);
      },
    });
    return rows;
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    if (error instanceof ZipError) {
      throw new XlsxError(error.reason === "too_big" ? "too_big" : "unreadable", error.message);
    }
    if (error instanceof XmlError) throw new XlsxError("unreadable", error.message);
    throw new XlsxError("unreadable", "unexpected");
  }
}

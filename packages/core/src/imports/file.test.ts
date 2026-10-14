/**
 * Reading uploaded files (T-084): CSV encodings and separators, quoting, blank lines, Hindi and
 * English headers, the header row below a title, numbers-as-text and leading zeros, Excel dates,
 * the CSV-injection escape round trip, and every whole-file problem.
 */
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { fieldForHeader, headerKey, IMPORT_FIELDS } from "./columns";
import {
  decodeCsvBytes,
  detectSeparator,
  escapeCsvCell,
  parseCsv,
  unescapeCsvCell,
  writeCsv,
} from "./csv";
import { readImportFile } from "./file";
import { IMPORT_LIMITS } from "./limits";
import { buildImportTemplate, buildProblemFile } from "./template";
import { cellText } from "./xlsx/cells";
import { writeXlsx } from "./xlsx/write";

const utf8 = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function utf16le(text: string, bom = true): Uint8Array {
  const out = new Uint8Array((bom ? 2 : 0) + text.length * 2);
  let at = 0;
  if (bom) {
    out[0] = 0xff;
    out[1] = 0xfe;
    at = 2;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[at++] = code & 0xff;
    out[at++] = code >> 8;
  }
  return out;
}

function lines(bytes: Uint8Array) {
  const result = readImportFile(bytes);
  if (!result.ok) throw new Error(`readImportFile: ${JSON.stringify(result.error)}`);
  return result.value;
}

const HEADERS = {
  code: "Customer code",
  name: "Name",
  phone: "Mobile no.",
  altPhone: "Other mobile no.",
  address: "Address",
  area: "Area",
  vcNumber: "VC number",
  plan: "Plan",
  rent: "Rent (₹ per month)",
  startDate: "Start day",
} as const;

describe("headers", () => {
  it("matches headers ignoring case, spaces, punctuation, * and (₹)", () => {
    expect(headerKey(" Customer Code * ")).toBe("customercode");
    expect(fieldForHeader("CUSTOMER-CODE")).toBe("code");
    expect(fieldForHeader("Rent (₹ per month)")).toBe("rent");
    expect(fieldForHeader("Mobile No.")).toBe("phone");
    expect(fieldForHeader("STB No")).toBe("vcNumber");
    expect(fieldForHeader("Package")).toBe("plan");
    expect(fieldForHeader("Problem")).toBe("ignore");
    expect(fieldForHeader("Remarks")).toBeNull();
    expect(fieldForHeader("")).toBeNull();
  });

  it("matches Hindi headers, with and without nukta", () => {
    expect(fieldForHeader("ग्राहक कोड")).toBe("code");
    expect(fieldForHeader("नाम")).toBe("name");
    expect(fieldForHeader("मोबाइल नंबर")).toBe("phone");
    expect(fieldForHeader("फ़ोन")).toBe("phone");
    expect(fieldForHeader("फोन")).toBe("phone");
    expect(fieldForHeader("दूसरा मोबाइल नंबर")).toBe("altPhone");
    expect(fieldForHeader("VC नंबर")).toBe("vcNumber");
    expect(fieldForHeader("किराया (₹ हर महीने)")).toBe("rent");
    expect(fieldForHeader("शुरू का दिन")).toBe("startDate");
  });
});

describe("CSV decoding", () => {
  it("reads UTF-8 with and without a byte-order mark", () => {
    expect(decodeCsvBytes(utf8("﻿नाम")).text).toBe("नाम");
    expect(decodeCsvBytes(utf8("नाम"))).toEqual({ text: "नाम", encoding: "utf-8" });
  });

  it("reads UTF-16 (Excel 'Unicode text'), with or without the mark", () => {
    expect(decodeCsvBytes(utf16le("Name\tनाम"))).toEqual({
      text: "Name\tनाम",
      encoding: "utf-16le",
    });
    expect(decodeCsvBytes(utf16le("Name,x", false)).encoding).toBe("utf-16le");
  });

  it("falls back to Windows-1252 for bytes that are not UTF-8, and says so", () => {
    const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]); // "Café" in Windows-1252
    expect(decodeCsvBytes(bytes)).toEqual({ text: "Café", encoding: "windows-1252" });
  });
});

describe("CSV parsing", () => {
  const limits = { maxRows: 100, maxColumns: 60, maxCellChars: 1000 };
  const grid = (text: string) =>
    parseCsv(text, limits).map((row) => [row.line, row.cells.map((cell) => cellText(cell))]);

  it("detects the separator from the header line", () => {
    expect(detectSeparator("a;b;c\n1,2;3")).toBe(";");
    expect(detectSeparator("a\tb\tc")).toBe("\t");
    expect(detectSeparator('"a,b";c')).toBe(";");
    expect(detectSeparator("one")).toBe(",");
  });

  it("handles quotes, doubled quotes, line breaks in quotes, CR/LF/CRLF and blank lines", () => {
    expect(grid('a,"b, c","say ""hi"""\r\n\r\n"two\nlines",x\r3,  \n,,\n')).toEqual([
      [1, ["a", "b, c", 'say "hi"']],
      [3, ["two\nlines", "x"]],
      [4, ["3", "  "]],
    ]);
  });

  it("stops at maxRows non-empty rows and maxColumns", () => {
    const rows = parseCsv("1,2,3\n4,5,6\n7,8,9\n", { ...limits, maxRows: 2, maxColumns: 2 });
    expect(rows.map((row) => row.cells.length)).toEqual([2, 2]);
  });
});

describe("CSV injection", () => {
  it("prefixes cells that a spreadsheet would run, and undoes it on upload", () => {
    for (const value of ["=1+1", "+91 98765", "-5", "@SUM(A1)", "\tx", "\rx"]) {
      expect(escapeCsvCell(value)).toBe(`'${value}`);
      expect(unescapeCsvCell(escapeCsvCell(value))).toBe(value);
    }
    expect(escapeCsvCell("Ramesh")).toBe("Ramesh");
    expect(unescapeCsvCell("'Ramesh")).toBe("'Ramesh");
  });

  it("writes UTF-8 with a mark, CRLF, quoting, and escaped formulas", () => {
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      writeCsv([
        ["a", "b,c", 'q"q'],
        ['=HYPERLINK("x")', " sp", "रमेश"],
      ]),
    );
    expect(text).toBe('﻿a,"b,c","q""q"\r\n"\'=HYPERLINK(""x"")"," sp",रमेश\r\n');
  });
});

describe("readImportFile", () => {
  it("reads a CSV with English headers, a title above, blank lines, and keeps leading zeros", () => {
    const csv = [
      "My customers,,",
      "",
      "Customer code,Name,Mobile no.,VC number,Rent,Remarks",
      "007,Ramesh Kumar,09876543210,000123,450,good",
      ",,,,,",
      "8,Sunita, +91 98765 43211 ,,,",
    ].join("\n");
    const table = lines(utf8(csv));
    expect(table.format).toBe("csv");
    expect(table.headerLine).toBe(3);
    expect(table.fields).toEqual(["code", "name", "phone", "vcNumber", "rent"]);
    expect(table.unusedColumns).toEqual(["Remarks"]);
    expect(table.warnings).toEqual([]);
    expect(table.lines.map((l) => l.line)).toEqual([4, 6]);
    expect(table.lines[0]?.values).toMatchObject({
      code: "007",
      name: "Ramesh Kumar",
      phone: "09876543210",
      vcNumber: "000123",
      rent: "450",
      startDate: "",
    });
    expect(table.lines[1]?.values.phone).toBe("+91 98765 43211");
  });

  it("reads a semicolon CSV saved by Excel in a European locale, and a Windows-1252 CSV", () => {
    const table = lines(utf8("Code;Name;Area\n1;Ravi;North\n"));
    expect(table.lines[0]?.values).toMatchObject({ code: "1", name: "Ravi", area: "North" });
    const ansi = new Uint8Array([...utf8("Code,Name\n2,Caf"), 0xe9, 0x0a]);
    const read = lines(ansi);
    expect(read.warnings).toEqual(["not_utf8"]);
    expect(read.lines[0]?.values.name).toBe("Café");
  });

  it("reads a UTF-16 tab-separated file with Hindi headers", () => {
    const table = lines(utf16le("ग्राहक कोड\tनाम\tएरिया\r\n12\tरमेश\tवार्ड 5\r\n"));
    expect(table.lines[0]?.values).toMatchObject({ code: "12", name: "रमेश", area: "वार्ड 5" });
  });

  it("reads an .xlsx with Hindi headers: numbers as text, dates, blank lines left out", () => {
    const table = lines(fixture("openpyxl-hindi.xlsx"));
    expect(table.format).toBe("xlsx");
    expect(table.headerLine).toBe(2);
    expect(table.lines.map((l) => l.line)).toEqual([3, 4, 6, 7, 8]);
    expect(table.lines[0]?.values).toEqual({
      code: "7",
      name: "रमेश कुमार",
      phone: "9876543210",
      altPhone: "",
      address: "गली 4",
      area: "वार्ड 5",
      vcNumber: "000123456789",
      plan: "बेसिक",
      rent: "450",
      startDate: "2026-10-01",
    });
    expect(table.lines[1]?.values).toMatchObject({
      code: "007",
      phone: "09876543211",
      vcNumber: "1234567890123",
      rent: "450",
      startDate: "15/10/2026",
    });
    // Spaces people can't see are tidied at the ends; inner spaces are the services' business.
    expect(table.lines[2]?.values.name).toBe("Mohan  Lal");
    expect(table.lines[3]?.values).toMatchObject({
      code: "A-12",
      vcNumber: "VC-77",
      startDate: "2026-09-30",
    });
  });

  it("reads a number cell in the start-day column as an Excel date (not a CSV number)", () => {
    const sheet =
      "<worksheet><sheetData>" +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Code</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c><c r="C1" t="inlineStr"><is><t>Start day</t></is></c></row>' +
      '<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>A</t></is></c><c r="C2"><v>46296</v></c></row>' +
      "</sheetData></worksheet>";
    const xlsx = zipSync({
      "xl/workbook.xml": strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
    });
    expect(lines(xlsx).lines[0]?.values.startDate).toBe("2026-10-01");
    expect(lines(utf8("Code,Name,Start day\n1,A,46296\n")).lines[0]?.values.startDate).toBe(
      "46296",
    );
  });

  it("un-escapes cells of our own CSV problem file and ignores its Line/Problem columns", () => {
    const problemFile = buildProblemFile(
      "csv",
      { sheetName: "Problems", headers: HEADERS, line: "Line", problem: "Problem" },
      [
        {
          line: 7,
          problem: "Mobile no.: not a phone number",
          values: {
            ...Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ""])),
            code: "=5",
            name: "-Ravi",
            phone: "+91 98765 00001",
          } as Record<(typeof IMPORT_FIELDS)[number], string>,
        },
      ],
    );
    const table = lines(problemFile);
    expect(table.unusedColumns).toEqual([]);
    expect(table.lines[0]?.values).toMatchObject({
      code: "=5",
      name: "-Ravi",
      phone: "+91 98765 00001",
    });
  });

  it("reads back its own templates (both formats, both languages)", () => {
    const hindi = {
      code: "ग्राहक कोड",
      name: "नाम",
      phone: "मोबाइल नंबर",
      altPhone: "दूसरा मोबाइल नंबर",
      address: "पता",
      area: "एरिया",
      vcNumber: "VC नंबर",
      plan: "प्लान",
      rent: "किराया (₹ हर महीने)",
      startDate: "शुरू का दिन",
    };
    for (const headers of [HEADERS, hindi]) {
      for (const kind of ["xlsx", "csv"] as const) {
        const template = buildImportTemplate(kind, {
          sheetName: "Customers",
          headers,
          helpSheetName: "How to fill",
          helpLines: ["One line per box."],
        });
        // An empty template is "empty"; with one customer typed in it reads every column.
        expect(readImportFile(template)).toEqual({ ok: false, error: { code: "empty" } });
        const filled =
          kind === "csv"
            ? utf8(`${new TextDecoder().decode(template)}1,Ravi,,,,,,,,\n`)
            : writeXlsx([{ name: "S", rows: [Object.values(headers), ["1", "Ravi"]] }]);
        const table = lines(filled);
        expect(table.fields).toEqual([...IMPORT_FIELDS]);
        expect(table.lines[0]?.values).toMatchObject({ code: "1", name: "Ravi" });
      }
    }
  });

  it("names whole-file problems", () => {
    const check = (bytes: Uint8Array) => {
      const result = readImportFile(bytes);
      return result.ok ? "ok" : result.error;
    };
    expect(check(new Uint8Array(0))).toEqual({ code: "empty" });
    expect(check(new Uint8Array(IMPORT_LIMITS.fileBytes + 1))).toEqual({ code: "too_big" });
    expect(check(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toEqual({
      code: "old_excel",
    });
    expect(check(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toEqual({ code: "unreadable" });
    expect(check(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))).toEqual({
      code: "unreadable",
    });
    expect(check(utf8("\n\n,,\n"))).toEqual({ code: "empty" });
    expect(check(utf8("Phone,Remarks\n1,2\n"))).toEqual({
      code: "missing_columns",
      fields: ["code", "name"],
    });
    expect(check(utf8("Hello,World\n1,2\n"))).toEqual({ code: "no_header" });
    expect(check(utf8("Code,Name,Mobile,Phone\n1,a,2,3\n"))).toEqual({
      code: "duplicate_column",
      fields: ["phone"],
    });
    expect(check(utf8("Code,Name\n"))).toEqual({ code: "empty" });
    const many = `Code,Name\n${Array.from({ length: IMPORT_LIMITS.rows + 1 }, (_, i) => `${i},N`).join("\n")}`;
    expect(check(utf8(many))).toEqual({ code: "too_many_lines" });
    const exactly = `Code,Name\n${Array.from({ length: IMPORT_LIMITS.rows }, (_, i) => `${i},N`).join("\n")}`;
    expect(check(utf8(exactly))).toBe("ok");
  });
});

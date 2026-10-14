/**
 * The .xlsx reader and writer (T-084): files written by openpyxl and LibreOffice (fixtures with
 * synthetic data), our own writer round-tripping, dates, numbers as text, hidden sheets, formula
 * cells, and the zip-bomb / malformed-XML guards.
 */
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { cellText, excelSerialToDate, type Grid, numberText } from "./cells";
import { isDateFormatCode, readXlsx, XlsxError } from "./read";
import { columnName, writeXlsx } from "./write";
import { decodeEntities, escapeXml, scanXml, XmlError } from "./xml";
import { openZip, ZipError } from "./zip";

const LIMITS = { partBytes: 8 * 1024 * 1024, maxRows: 100, maxColumns: 60, maxCellChars: 1000 };

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

/** Rows as text, with their line numbers. */
function texts(grid: Grid): [number, string[]][] {
  return grid.map((row) => [row.line, Array.from(row.cells, (cell) => cellText(cell))]);
}

/** A minimal workbook from raw parts (sheet XML given), zipped with fflate. */
function workbook(sheet: string, extra: Record<string, string> = {}): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(
      `<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  for (const [name, text] of Object.entries(extra)) parts[name] = strToU8(text);
  return zipSync(parts);
}

describe("xml scanner", () => {
  it("decodes the predefined entities and character references", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#2352; &#x930;")).toBe(
      "a & b <c> \"d\" 'e' र र",
    );
  });

  it("refuses DOCTYPE (no entity expansion) and unknown entities", () => {
    expect(() => scanXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>', {})).toThrow(XmlError);
    expect(() => scanXml("<x>&nbsp;</x>", { text: () => {} })).toThrow(XmlError);
  });

  it("reads attributes with > inside quotes, CDATA, comments and prefixes", () => {
    const seen: string[] = [];
    scanXml(
      '<?xml version="1.0"?><x:a f="[>=100]0" g=\'1\'><!-- c --><b/><![CDATA[<raw>]]>t</x:a>',
      {
        open: (name, attributes, self) =>
          seen.push(`open ${name} ${JSON.stringify(attributes)} ${self}`),
        close: (name) => seen.push(`close ${name}`),
        text: (text) => seen.push(`text ${text}`),
      },
    );
    expect(seen).toEqual([
      'open a {"f":"[>=100]0","g":"1"} false',
      "open b {} true",
      "close b",
      "text <raw>",
      "text t",
      "close a",
    ]);
  });

  it("throws on mismatched or unclosed tags", () => {
    expect(() => scanXml("<a><b></a>", {})).toThrow(XmlError);
    expect(() => scanXml("<a>", {})).toThrow(XmlError);
  });

  it("escapes text and drops characters XML cannot hold", () => {
    expect(escapeXml('a<b>&"c"\u0001\u001b')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
  });
});

describe("cells", () => {
  it("writes numbers the way people typed them", () => {
    expect(numberText(9876543210)).toBe("9876543210");
    expect(numberText(1234567890123)).toBe("1234567890123");
    expect(numberText(450)).toBe("450");
    expect(numberText(450.5)).toBe("450.5");
    expect(numberText(0.1 + 0.2)).toBe("0.3");
  });

  it("turns Excel serial dates into ISO dates (1900 and 1904 systems)", () => {
    expect(excelSerialToDate(1)).toBe("1900-01-01");
    expect(excelSerialToDate(61)).toBe("1900-03-01");
    expect(excelSerialToDate(46296)).toBe("2026-10-01");
    expect(excelSerialToDate(46296.75)).toBe("2026-10-01");
    expect(excelSerialToDate(44834, true)).toBe("2026-10-01");
    expect(excelSerialToDate(0)).toBeNull();
    expect(excelSerialToDate(Number.NaN)).toBeNull();
  });

  it("knows which number formats are dates", () => {
    for (const code of ["dd/mm/yyyy", "d-mmm-yy", "[$-409]mmmm d, yyyy", "yyyy-mm-dd h:mm"]) {
      expect(isDateFormatCode(code), code).toBe(true);
    }
    for (const code of ["General", "0.00", "#,##0", '"₹"#,##0', "@", "h:mm:ss", "0%"]) {
      expect(isDateFormatCode(code), code).toBe(false);
    }
  });
});

describe("readXlsx: real files", () => {
  it("reads an openpyxl file: Hindi, shared strings, dates, numbers, the first visible sheet", () => {
    const grid = readXlsx(fixture("openpyxl-hindi.xlsx"), LIMITS);
    const rows = texts(grid);
    // The hidden sheet "Old" comes first in the workbook and is skipped.
    expect(rows.map(([line]) => line)).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(rows[1]?.[1].slice(0, 2)).toEqual(["ग्राहक कोड", "नाम"]);
    expect(rows[2]?.[1]).toEqual([
      "7",
      "रमेश कुमार",
      "9876543210",
      "गली 4",
      "वार्ड 5",
      "000123456789",
      "बेसिक",
      "450",
      "2026-10-01",
    ]);
    // Text that looks like a number keeps its zeros; a big number has no exponent.
    expect(rows[3]?.[1].slice(0, 3)).toEqual(["007", "Sunita Devi", "09876543211"]);
    expect(rows[3]?.[1][5]).toBe("1234567890123");
    expect(rows[3]?.[1][8]).toBe("15/10/2026");
    // A date with a time keeps only the day.
    expect(rows[5]?.[1][8]).toBe("2026-09-30");
    // A formula without a saved result is empty (formulas are never run).
    expect(rows[6]?.[1][7] ?? "").toBe("");
    expect(grid[2]?.cells[8]).toEqual({ kind: "date", date: "2026-10-01" });
    expect(grid[2]?.cells[0]).toEqual({ kind: "number", value: 7 });
  });

  it("reads the same sheet saved again by LibreOffice", () => {
    const rows = texts(readXlsx(fixture("libreoffice-hindi.xlsx"), LIMITS));
    expect(rows[2]?.[1].slice(0, 3)).toEqual(["7", "रमेश कुमार", "9876543210"]);
    expect(rows[2]?.[1][8]).toBe("2026-10-01");
    expect(rows[3]?.[1][0]).toBe("007");
  });

  it("reads a custom date format (dd-mmm-yy)", () => {
    const rows = texts(readXlsx(fixture("english-dates.xlsx"), LIMITS));
    expect(rows[1]?.[1]).toEqual([
      "101",
      "Ravi",
      "9876500001",
      "North",
      "11112222",
      "Basic",
      "",
      "2026-10-02",
    ]);
  });
});

describe("readXlsx: edge cases", () => {
  it("handles inline strings, rich text, booleans, errors, gaps and cells without r", () => {
    const sheet = `<worksheet><sheetData>
      <row r="2"><c r="B2" t="inlineStr"><is><t>in</t><r><t>line</t></r></is></c><c t="b"><v>1</v></c><c t="e"><v>#N/A</v></c></row>
      <row r="5"><c r="A5" t="s"><v>0</v></c><c r="D5" t="str"><f>A5</f><v>calc</v></c></row>
      <row r="6"><c r="A6" s="0"/></row>
    </sheetData></worksheet>`;
    const shared = `<sst><si><r><t>Ra</t></r><r><t>mesh</t></r><rPh><t>ignored</t></rPh></si></sst>`;
    const grid = readXlsx(workbook(sheet, { "xl/sharedStrings.xml": shared }), LIMITS);
    expect(texts(grid)).toEqual([
      [2, ["", "inline", "TRUE"]],
      [5, ["Ramesh", "", "", "calc"]],
    ]);
  });

  it("stops after maxRows non-empty rows and ignores columns past maxColumns", () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) =>
        `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="C${i + 1}"><v>9</v></c></row>`,
    ).join("");
    const grid = readXlsx(workbook(`<worksheet><sheetData>${rows}</sheetData></worksheet>`), {
      ...LIMITS,
      maxRows: 3,
      maxColumns: 2,
    });
    expect(texts(grid)).toEqual([
      [1, ["0"]],
      [2, ["1"]],
      [3, ["2"]],
    ]);
  });

  it("refuses a zip bomb (a part that inflates past its limit, whatever its header says)", () => {
    const big = new Uint8Array(20 * 1024 * 1024).fill(0x20);
    const zip = zipSync({
      "xl/workbook.xml": strToU8(
        `<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      "xl/worksheets/sheet1.xml": big,
    });
    expect(zip.length).toBeLessThan(100_000);
    expect(() => readXlsx(zip, { ...LIMITS, partBytes: 1024 * 1024 })).toThrow(
      expect.objectContaining({ reason: "too_big" }),
    );
    expect(() => openZip(zip).read("xl/worksheets/sheet1.xml", 1000)).toThrow(ZipError);
  });

  it("calls broken files unreadable", () => {
    const broken = [
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
      zipSync({ "hello.txt": strToU8("hi") }),
      workbook("<worksheet><sheetData><row><c><v>1</v></row></sheetData></worksheet>"),
      workbook('<!DOCTYPE x [<!ENTITY a "b">]><worksheet/>'),
    ];
    for (const bytes of broken) {
      expect(() => readXlsx(bytes, LIMITS)).toThrow(XlsxError);
    }
  });
});

describe("writeXlsx", () => {
  it("names columns like Excel", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("round-trips through the reader: text cells, Hindi, leading zeros, formula-like text", () => {
    const rows = [
      ["ग्राहक कोड", "नाम", "Mobile no."],
      ["007", "रमेश <कुमार> & sons", "09876543210"],
      ["=1+1", "+91 98765", "@SUM(A1)"],
    ];
    const bytes = writeXlsx([
      { name: "Customers", rows },
      { name: "How to fill", rows: [["One line per box."]], header: false },
    ]);
    const grid = readXlsx(bytes, LIMITS);
    expect(texts(grid).map(([, cells]) => cells)).toEqual(rows);
    // Every cell is a text (inline string) cell: nothing is a formula.
    const xml = new TextDecoder().decode(
      openZip(bytes).read("xl/worksheets/sheet1.xml", 1_000_000) ?? new Uint8Array(),
    );
    expect(xml).not.toContain("<f>");
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain('state="frozen"');
  });

  it("writes the same bytes for the same input", () => {
    const sheets = [{ name: "A", rows: [["x"]] }];
    expect(writeXlsx(sheets)).toEqual(writeXlsx(sheets));
  });
});

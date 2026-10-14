/**
 * Writes a small .xlsx workbook (T-084): the import template and the problem file.
 *
 * Every cell is written as a **text** cell (an inline string) in a column formatted as Text
 * (`@`), so Excel never evaluates anything in it (no formula injection from a customer's name),
 * and codes, mobile numbers and VC numbers typed later keep their leading zeros. The first row is
 * bold and frozen. No colours: the file follows the app's hyper-minimal look.
 */
import { escapeXml } from "./xml";
import { zipTextParts } from "./zip";

export interface XlsxSheet {
  /** The tab name (cut to Excel's 31 characters; `[]:*?/\` removed). */
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
  /** Column widths in characters (default 18). */
  readonly widths?: readonly number[];
  /** Bold and freeze the first row. Default true. */
  readonly header?: boolean;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** `0` → `A`, `27` → `AB`. */
export function columnName(index: number): string {
  let name = "";
  let rest = index + 1;
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

function sheetName(name: string, index: number): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned === "" ? `Sheet${index + 1}` : cleaned;
}

/** Style ids in styles.xml: 0 default, 1 text, 2 bold text. */
const STYLE_TEXT = 1;
const STYLE_HEADER = 2;

function sheetXml(sheet: XlsxSheet): string {
  const header = sheet.header ?? true;
  const columns = Math.max(1, ...sheet.rows.map((row) => row.length));
  const cols = Array.from({ length: columns }, (_, index) => {
    const width = sheet.widths?.[index] ?? 18;
    const n = index + 1;
    return `<col min="${n}" max="${n}" width="${width}" style="${STYLE_TEXT}" customWidth="1"/>`;
  }).join("");
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const style = header && rowIndex === 0 ? STYLE_HEADER : STYLE_TEXT;
      const cells = row
        .map((value, columnIndex) => {
          if (value === "") return "";
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const pane = header
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    : "";
  return (
    `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols>` +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

const STYLES_XML =
  `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** Builds the workbook. The first sheet is the one people fill in and the import reads. */
export function writeXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new TypeError("writeXlsx: at least one sheet");
  const parts: Record<string, string> = {};
  const overrides = sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  parts["[Content_Types].xml"] =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    `${overrides}</Types>`;
  parts["_rels/.rels"] =
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";
  const used = new Set<string>();
  const sheetEntries = sheets
    .map((sheet, index) => {
      let name = sheetName(sheet.name, index);
      while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${index + 1}`;
      used.add(name.toLowerCase());
      return `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`;
    })
    .join("");
  parts["xl/workbook.xml"] =
    `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetEntries}</sheets></workbook>`;
  const sheetRels = sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  parts["xl/_rels/workbook.xml.rels"] =
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">${sheetRels}` +
    `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    "</Relationships>";
  parts["xl/styles.xml"] = STYLES_XML;
  sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheet);
  });
  return zipTextParts(parts);
}

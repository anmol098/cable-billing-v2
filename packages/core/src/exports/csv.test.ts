import { describe, expect, it } from "vitest";
import {
  CSV_BOM,
  countCell,
  csvCell,
  csvLine,
  exportFileStem,
  istDateTime,
  neutraliseCsvText,
  rupeesCell,
} from "./csv";

describe("CSV export cells (T-082)", () => {
  it("neutralises every cell a spreadsheet could read as a formula", () => {
    for (const value of [
      "=1+1",
      "+919876543210",
      "-2+3",
      "@SUM(A1:A2)",
      "\t=1",
      "\r=1",
      "\n=1",
      '  =HYPERLINK("http://x")',
      " +1",
    ]) {
      expect(neutraliseCsvText(value), JSON.stringify(value)).toBe(`'${value}`);
    }
    for (const value of ["Asha Devi", "आशा देवी", "A-1", "9876543210", "", "50", "R-2610-00001"]) {
      expect(neutraliseCsvText(value)).toBe(value);
    }
  });

  it("quotes commas, quotes, line breaks and edge spaces; keeps Hindi as is", () => {
    expect(csvCell("Rao, Bina")).toBe('"Rao, Bina"');
    expect(csvCell('5" dish')).toBe('"5"" dish"');
    expect(csvCell("line 1\nline 2")).toBe('"line 1\nline 2"');
    expect(csvCell(" padded ")).toBe('" padded "');
    expect(csvCell("आशा देवी")).toBe("आशा देवी");
    // Neutralised, then quoted: the quote can't hide the formula from the escape.
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell("  =1")).toBe("'  =1");
  });

  it("writes numbers we made bare and anything else as text", () => {
    expect(csvCell({ number: "-50" })).toBe("-50");
    expect(csvCell({ number: "12.50" })).toBe("12.50");
    expect(csvCell({ number: "-1+1" })).toBe("'-1+1");
    expect(csvCell({ number: "1e5" })).toBe("1e5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("turns paise into rupees with string maths (no floats, no grouping)", () => {
    expect(rupeesCell(45_000)).toEqual({ number: "450" });
    expect(rupeesCell(1_250)).toEqual({ number: "12.50" });
    expect(rupeesCell(-5_000)).toEqual({ number: "-50" });
    expect(rupeesCell(0)).toEqual({ number: "0" });
    expect(rupeesCell(12_345_678_901)).toEqual({ number: "123456789.01" });
    expect(rupeesCell(10n)).toEqual({ number: "0.10" });
    expect(rupeesCell(null)).toBeNull();
    expect(() => rupeesCell(0.5)).toThrow(RangeError);
    expect(countCell(3)).toEqual({ number: "3" });
    expect(countCell(null)).toBeNull();
  });

  it("ends lines in CRLF and starts files with a UTF-8 BOM", () => {
    expect(csvLine(["a", { number: "1" }, null, "b,c"])).toBe('a,1,,"b,c"\r\n');
    expect(CSV_BOM).toBe("﻿");
    expect(new TextEncoder().encode(CSV_BOM)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });

  it("shows instants in IST and names files by the IST time", () => {
    expect(istDateTime(new Date("2026-10-31T18:45:00Z"))).toBe("2026-11-01 00:15");
    expect(istDateTime(new Date("2026-10-14T10:00:59Z"))).toBe("2026-10-14 15:30");
    expect(exportFileStem("billing_runs", new Date("2026-10-31T18:45:00Z"))).toBe(
      "billing-runs-2026-11-01-0015",
    );
  });
});

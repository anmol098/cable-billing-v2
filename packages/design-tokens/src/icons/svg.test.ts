import { describe, expect, it } from "vitest";
import { elementToPath, formatNumber, IconConversionError, normalizePathData } from "./svg";

const path = (tag: string, attributes: Record<string, string>) =>
  elementToPath([tag, attributes]).pathData;

describe("formatNumber", () => {
  it("rounds to 4 decimals without trailing zeros or -0", () => {
    expect(formatNumber(2)).toBe("2");
    expect(formatNumber(0.01)).toBe("0.01");
    expect(formatNumber(1 / 3)).toBe("0.3333");
    expect(formatNumber(-0.00001)).toBe("0");
    expect(() => formatNumber(Number.NaN)).toThrow(IconConversionError);
  });
});

describe("normalizePathData", () => {
  it("splits Lucide's minified syntax into explicit tokens", () => {
    expect(normalizePathData("M6 12h.01M18 12h.01")).toBe("M6 12 h0.01 M18 12 h0.01");
    expect(normalizePathData("M21 16h-3a2 2 0 0 0-2 2v3")).toBe("M21 16 h-3 a2 2 0 0 0 -2 2 v3");
    expect(normalizePathData("m16 9-5.5 5.5L8 12")).toBe("m16 9 l-5.5 5.5 L8 12");
  });

  it("reads packed arc flags (a1 1 0 011 1)", () => {
    expect(normalizePathData("M0 0a1 1 0 011 1")).toBe("M0 0 a1 1 0 0 1 1 1");
    expect(normalizePathData("M0 0A1,1,0,1,0,2,2")).toBe("M0 0 A1 1 0 1 0 2 2");
  });

  it("repeats implicit commands explicitly; extra moveto pairs become lineto", () => {
    expect(normalizePathData("M1 1 2 2 3 3")).toBe("M1 1 L2 2 L3 3");
    expect(normalizePathData("m1 1 2 2")).toBe("m1 1 l2 2");
    expect(normalizePathData("M0 0c1 1 2 2 3 3 4 4 5 5 6 6z")).toBe(
      "M0 0 c1 1 2 2 3 3 c4 4 5 5 6 6 z",
    );
  });

  it("supports every command and exponents", () => {
    expect(normalizePathData("M0 0L1 1H2V3C1 1 1 1 1 1S2 2 2 2Q3 3 3 3T4 4A1 1 0 0 0 5 5Z")).toBe(
      "M0 0 L1 1 H2 V3 C1 1 1 1 1 1 S2 2 2 2 Q3 3 3 3 T4 4 A1 1 0 0 0 5 5 Z",
    );
    expect(normalizePathData("M1e1 -2.5E-1")).toBe("M10 -0.25");
  });

  it("rejects invalid path data", () => {
    expect(() => normalizePathData("")).toThrow("empty");
    expect(() => normalizePathData("L1 1")).toThrow("must start with M");
    expect(() => normalizePathData("M1 1 X2 2")).toThrow('unknown command "X"');
    expect(() => normalizePathData("M1")).toThrow("expected a number");
    expect(() => normalizePathData("M0 0 a1 1 0 2 0 1 1")).toThrow("arc flag");
    expect(() => normalizePathData("M0 0z 1 1")).toThrow('numbers after "z"');
  });
});

describe("elementToPath", () => {
  it("circle → two half arcs, closed", () => {
    expect(path("circle", { cx: "12", cy: "12", r: "10" })).toBe(
      "M2 12 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 Z",
    );
  });

  it("ellipse → two half arcs with both radii; a missing radius copies the other", () => {
    expect(path("ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" })).toBe(
      "M3 5 a9 3 0 1 0 18 0 a9 3 0 1 0 -18 0 Z",
    );
    expect(path("ellipse", { cx: "1", cy: "1", rx: "1" })).toBe(
      "M0 1 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0 Z",
    );
  });

  it("rect without radius → closed box", () => {
    expect(path("rect", { x: "3", y: "4", width: "18", height: "16" })).toBe("M3 4 H21 V20 H3 Z");
  });

  it("rect with rx → rounded corners (ry defaults to rx)", () => {
    expect(path("rect", { width: "20", height: "12", x: "2", y: "6", rx: "2" })).toBe(
      "M4 6 H20 A2 2 0 0 1 22 8 V16 A2 2 0 0 1 20 18 H4 A2 2 0 0 1 2 16 V8 A2 2 0 0 1 4 6 Z",
    );
  });

  it("rect with different rx/ry, capped at half the size", () => {
    expect(path("rect", { x: "0", y: "0", width: "10", height: "4", rx: "3", ry: "5" })).toBe(
      "M3 0 H7 A3 2 0 0 1 10 2 V2 A3 2 0 0 1 7 4 H3 A3 2 0 0 1 0 2 V2 A3 2 0 0 1 3 0 Z",
    );
    expect(path("rect", { width: "4", height: "4", ry: "1" })).toBe(
      "M1 0 H3 A1 1 0 0 1 4 1 V3 A1 1 0 0 1 3 4 H1 A1 1 0 0 1 0 3 V1 A1 1 0 0 1 1 0 Z",
    );
  });

  it("line, polyline, polygon", () => {
    expect(path("line", { x1: "12", x2: "12", y1: "2", y2: "22" })).toBe("M12 2 L12 22");
    expect(path("polyline", { points: "22 12 18 12 15 21 9 3 6 12 2 12" })).toBe(
      "M22 12 L18 12 L15 21 L9 3 L6 12 L2 12",
    );
    expect(path("polygon", { points: "3,11 22,2 13,21" })).toBe("M3 11 L22 2 L13 21 Z");
  });

  it("marks fill=currentColor elements as filled", () => {
    expect(elementToPath(["circle", { cx: "1", cy: "1", r: ".5", fill: "currentColor" }])).toEqual({
      pathData: "M0.5 1 a0.5 0.5 0 1 0 1 0 a0.5 0.5 0 1 0 -1 0 Z",
      filled: true,
    });
    expect(elementToPath(["path", { d: "M0 0h1", fill: "none" }]).filled).toBe(false);
  });

  it("refuses what it cannot convert faithfully", () => {
    expect(() => path("text", {})).toThrow("unsupported element <text>");
    expect(() => path("path", { d: "M0 0h1", transform: "rotate(45)" })).toThrow(
      'unsupported attribute "transform"',
    );
    expect(() => path("path", { d: "M0 0h1", fill: "red" })).toThrow("fill must be");
    expect(() => path("circle", { cx: "1", cy: "1", r: "0" })).toThrow("r must be > 0");
    expect(() => path("rect", { width: "1" })).toThrow('missing "height"');
    expect(() => path("rect", { width: "1px", height: "1" })).toThrow("not a plain number");
    expect(() => path("polyline", { points: "1 2 3" })).toThrow("at least two x,y pairs");
  });
});

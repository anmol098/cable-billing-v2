import { describe, expect, it } from "vitest";
import { loadTokens } from "./fs";
import { KOTLIN_PACKAGE, renderTokensKt } from "./kotlin";

// We cannot compile Kotlin here (no Android SDK in this environment), so these are
// string-level checks on the generated file. T-008 compiles it in the Android build.
const kt = renderTokensKt(loadTokens());

/** Body of `object <name> { … }` inside Tokens. */
function objectBody(name: string): string[] {
  const lines = kt.split("\n");
  const start = lines.indexOf(`    object ${name} {`);
  expect(start, `object ${name} exists`).toBeGreaterThan(-1);
  const end = lines.indexOf("    }", start);
  return lines.slice(start + 1, end).map((line) => line.trim());
}

describe("Tokens.kt", () => {
  it("starts with the GENERATED header, file annotation, package and imports", () => {
    const lines = kt.split("\n");
    expect(lines[0]).toMatch(/^\/\/ GENERATED .*DO NOT EDIT\.$/);
    expect(kt).toContain('@file:Suppress("ktlint", "MagicNumber")\n\npackage ');
    expect(kt).toContain(`package ${KOTLIN_PACKAGE}\n`);
    expect(kt).toContain("import androidx.compose.ui.graphics.Color as ComposeColor\n");
    expect(kt).toContain("import androidx.compose.ui.unit.dp\n");
    expect(kt).toContain("import androidx.compose.ui.unit.sp\n");
    expect(kt.endsWith("}\n")).toBe(true);
  });

  it("has the Color, Radius, Border, Space, Type, Size objects (plus Font, Weight, Elevation)", () => {
    for (const name of ["Color", "Font", "Weight", "Type", "Radius", "Border", "Space", "Size"]) {
      expect(kt).toContain(`\n    object ${name} {\n`);
    }
    expect(kt).toContain("\n    object Elevation {\n");
  });

  it("emits colours as Compose ARGB, including semantic colours", () => {
    const color = objectBody("Color");
    expect(color).toContain("val Bg = ComposeColor(0xFFFFFFFF)");
    expect(color).toContain("val TextMuted = ComposeColor(0xFF6B6B6B)");
    expect(color).toContain("val Accent = ComposeColor(0xFF111111)");
    expect(color).toContain("val Cash = ComposeColor(0xFF15803D)");
    expect(color).toContain("val Upi = ComposeColor(0xFF1D4ED8)");
    expect(color).toContain("val Pending = ComposeColor(0xFFB45309)");
  });

  it("uses the Android scale: sp for text, dp for lengths", () => {
    expect(objectBody("Type")).toEqual([
      "val Sm = 16.sp",
      "val Base = 18.sp",
      "val Lg = 22.sp",
      "val Xl = 26.sp",
      "val Xxl = 32.sp",
      "val Amount = 44.sp",
    ]);
    expect(objectBody("Radius")).toContain("val Md = 8.dp");
    expect(objectBody("Border")).toEqual(["val Hairline = 1.dp", "val Strong = 2.dp"]);
    expect(objectBody("Space")).toContain("val Base = 4.dp");
    expect(objectBody("Size")).toEqual(["val TouchMin = 56.dp", "val PrimaryButton = 64.dp"]);
    expect(objectBody("Elevation")).toEqual(["val None = 0.dp"]);
  });

  it("emits font weights and the tabular-figures feature", () => {
    expect(objectBody("Weight")).toEqual([
      "val Regular = FontWeight(400)",
      "val Strong = FontWeight(600)",
    ]);
    expect(objectBody("Font")).toContain("val NumericFeatureSettings = \"'tnum'\"");
  });

  it("is syntactically plausible Kotlin", () => {
    expect(kt.split("{").length).toBe(kt.split("}").length);
    for (const line of kt.split("\n").filter((l) => l.trim().startsWith("val "))) {
      expect(line).toMatch(/^ {8}val [A-Z][A-Za-z0-9]* = \S/);
    }
    expect(kt).not.toMatch(/\t|[ ]+\n/); // no tabs, no trailing spaces
  });
});

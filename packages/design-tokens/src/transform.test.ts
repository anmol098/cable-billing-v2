import { describe, expect, it } from "vitest";
import {
  composeFontFeatures,
  cssFontFamily,
  cssFontFeatures,
  dp,
  formatNumber,
  hexToArgb,
  hexToComposeColor,
  hexToCss,
  kebabCase,
  kotlinString,
  pascalCase,
  pxToCss,
  pxToRem,
  sp,
} from "./transform";

describe("px → rem", () => {
  it.each([
    [16, "1rem"],
    [14, "0.875rem"],
    [18, "1.125rem"],
    [22, "1.375rem"],
    [36, "2.25rem"],
    [4, "0.25rem"],
    [44, "2.75rem"],
    [0, "0rem"],
    [9999, "624.9375rem"],
  ])("%d px → %s", (px, rem) => {
    expect(pxToRem(px)).toBe(rem);
  });

  it("prints px for hairlines", () => {
    expect(pxToCss(1)).toBe("1px");
    expect(pxToCss(2)).toBe("2px");
  });

  it("formats numbers without float noise", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(8)).toBe("8");
    expect(() => formatNumber(Number.NaN)).toThrow();
  });
});

describe("dp / sp", () => {
  it("emits Compose unit literals", () => {
    expect(dp(8)).toBe("8.dp");
    expect(dp(0)).toBe("0.dp");
    expect(dp(0.5)).toBe("0.5.dp");
    expect(sp(18)).toBe("18.sp");
    expect(sp(44)).toBe("44.sp");
  });
});

describe("hex colours", () => {
  it("→ Compose Color(0xAARRGGBB)", () => {
    expect(hexToComposeColor("#15803D")).toBe("Color(0xFF15803D)");
    expect(hexToComposeColor("#ffffff")).toBe("Color(0xFFFFFFFF)");
    expect(hexToComposeColor("#15803D", "ComposeColor")).toBe("ComposeColor(0xFF15803D)");
  });

  it("moves CSS alpha (#RRGGBBAA) to the front for Compose", () => {
    expect(hexToArgb("#15803D80")).toBe("0x8015803D");
  });

  it("upper-cases colours for CSS", () => {
    expect(hexToCss("#b91c1c")).toBe("#B91C1C");
  });

  it.each(["red", "#FFF", "15803D", "#15803G", "rgb(0,0,0)"])("rejects %s", (value) => {
    expect(() => hexToComposeColor(value)).toThrow(/not a hex colour/);
  });
});

describe("names", () => {
  it("camelCase → kebab-case for CSS", () => {
    expect(kebabCase("textMuted")).toBe("text-muted");
    expect(kebabCase("touchMin")).toBe("touch-min");
    expect(kebabCase("bg")).toBe("bg");
    expect(kebabCase("2xl")).toBe("2xl");
  });

  it("camelCase → PascalCase for Kotlin", () => {
    expect(pascalCase("textMuted")).toBe("TextMuted");
    expect(pascalCase("bg")).toBe("Bg");
    expect(pascalCase("2xl")).toBe("Xxl");
    expect(pascalCase("3xl")).toBe("Xxxl");
    expect(() => pascalCase("1abc")).toThrow();
  });
});

describe("fonts", () => {
  it("quotes CSS family names that need it", () => {
    expect(cssFontFamily(["Inter", "Noto Sans Devanagari", "system-ui", "sans-serif"])).toBe(
      'Inter, "Noto Sans Devanagari", system-ui, sans-serif',
    );
  });

  it("formats font features per platform", () => {
    expect(cssFontFeatures(["tnum"])).toBe('"tnum"');
    expect(cssFontFeatures(["tnum", "lnum"])).toBe('"tnum", "lnum"');
    expect(composeFontFeatures(["tnum", "lnum"])).toBe("'tnum', 'lnum'");
  });

  it("escapes Kotlin strings", () => {
    expect(kotlinString("Inter")).toBe('"Inter"');
    expect(kotlinString('a"b$c')).toBe('"a\\"b\\$c"');
  });
});

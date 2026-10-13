import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cn,
  THEME_BORDER_WIDTHS,
  THEME_COLORS,
  THEME_FONT_WEIGHTS,
  THEME_FONTS,
  THEME_RADII,
  THEME_SIZES,
  THEME_TEXT_SIZES,
} from "./cn";

const themeCss = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

/** Names of `--<prefix>-<name>:` variables in the generated theme (no nested `--x--y` keys). */
function themeNames(prefix: string): string[] {
  const names = [...themeCss.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9-]+):`, "gm"))]
    .map((match) => match[1] ?? "")
    .filter((name) => !name.includes("--"));
  return [...new Set(names)].sort();
}

describe("cn token lists match the generated theme.css", () => {
  it.each([
    ["color", THEME_COLORS],
    ["text", THEME_TEXT_SIZES],
    ["font", THEME_FONTS],
    ["font-weight", THEME_FONT_WEIGHTS],
    ["radius", THEME_RADII],
  ] as const)("--%s-*", (prefix, names) => {
    const fromTheme = themeNames(prefix).filter((name) =>
      // `--font-weight-*` also matches `--font-*`; keep each list to its own namespace.
      prefix === "font" ? !name.startsWith("weight-") : true,
    );
    expect([...names].sort()).toEqual(fromTheme);
  });

  it("--spacing-* sizes", () => {
    expect([...THEME_SIZES].sort()).toEqual(themeNames("spacing"));
  });

  it("border width utilities", () => {
    const utilities = [...themeCss.matchAll(/^@utility border-([a-z]+) \{/gm)].map((m) => m[1]);
    expect([...THEME_BORDER_WIDTHS].sort()).toEqual([...new Set(utilities)].sort());
  });
});

describe("cn", () => {
  it("joins clsx inputs", () => {
    expect(cn("p-4", false, undefined, ["gap-2"], { "bg-bg": true, "bg-surface": false })).toBe(
      "p-4 gap-2 bg-bg",
    );
  });

  it("keeps a type-size token and a colour token together", () => {
    expect(cn("text-amount", "text-cash")).toBe("text-amount text-cash");
    expect(cn("text-2xl", "text-due")).toBe("text-2xl text-due");
  });

  it("lets the last colour or size win", () => {
    expect(cn("text-text", "text-cash")).toBe("text-cash");
    expect(cn("text-sm", "text-amount")).toBe("text-amount");
    expect(cn("bg-accent", "bg-danger")).toBe("bg-danger");
    expect(cn("font-regular", "font-strong")).toBe("font-strong");
    expect(cn("font-sans", "font-numeric")).toBe("font-numeric");
    expect(cn("rounded-md", "rounded-full")).toBe("rounded-full");
  });

  it("treats border width tokens as widths, not colours", () => {
    expect(cn("border-hairline", "border-border")).toBe("border-hairline border-border");
    expect(cn("border-hairline", "border-strong")).toBe("border-strong");
    expect(cn("border-border", "border-danger")).toBe("border-danger");
    expect(cn("border-t-hairline", "border-t-strong")).toBe("border-t-strong");
  });

  it("knows the size tokens", () => {
    expect(cn("min-h-touch-min", "min-h-primary-button")).toBe("min-h-primary-button");
    expect(cn("h-12", "h-touch-min")).toBe("h-touch-min");
  });
});

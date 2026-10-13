import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Acceptance check for T-006: the primitives (and their shared class strings in lib/) use design
 * tokens only. Colours, sizes, radii, borders and type come from theme.css utilities; anything
 * hard-coded fails here with the file, line and rule.
 */

const SRC = join(import.meta.dirname, "..");
const SCANNED_DIRS = ["primitives", "lib"];

type Rule = { name: string; pattern: RegExp };

const HARD_CODED_RULES: Rule[] = [
  { name: "hex colour", pattern: /#[0-9a-fA-F]{3,8}\b/ },
  {
    name: "CSS colour function",
    pattern: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\(/,
  },
  { name: "CSS length", pattern: /(?<![\w-])\d*\.?\d+(?:px|rem|em|vh|vw|vmin|vmax|pt|dp|sp)\b/ },
  { name: "Tailwind arbitrary value", pattern: /[\w)]-\[/ },
  { name: "Tailwind arbitrary property or variant", pattern: /(?:^|[\s"'`])\[(?:&|@|[a-z-]+:)/ },
  { name: "Tailwind CSS-variable shorthand", pattern: /[\w)]-\(--/ },
  { name: "inline style", pattern: /\bstyle\s*=\s*\{/ },
  {
    name: "shadow or gradient",
    pattern:
      /(?<![\w-])(?:shadow|drop-shadow|inset-shadow|text-shadow)(?:-[\w/]+)?(?![\w-])|\bbg-(?:gradient|linear|radial|conic)\b/,
  },
  {
    name: "Tailwind default palette",
    pattern:
      /\b(?:bg|text|border|ring|outline|fill|stroke|accent|caret|decoration|divide|placeholder|from|via|to)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/,
  },
  {
    name: "opacity instead of a colour token",
    pattern: /(?<![\w-])opacity-\d+\b|\b[a-z]+(?:-[a-z]+)*\/\d{1,3}\b/,
  },
  { name: "class built at runtime (Tailwind can't see it)", pattern: /[a-z]-\$\{/ },
];

/** Every rule violation in `source`, as `line: rule: text`. Comments are checked too. */
function findHardCoded(source: string): string[] {
  const problems: string[] = [];
  source.split("\n").forEach((line, index) => {
    for (const rule of HARD_CODED_RULES) {
      if (rule.pattern.test(line)) problems.push(`${index + 1}: ${rule.name}: ${line.trim()}`);
    }
  });
  return problems;
}

function sourceFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(join(SRC, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => join(SRC, dir, file)),
  );
}

describe("tokens only (no hard-coded colours or sizes)", () => {
  it("scans the primitives and lib sources", () => {
    const files = sourceFiles().map((file) => relative(SRC, file));
    expect(files).toEqual(expect.arrayContaining(["primitives/Button.tsx", "lib/styles.ts"]));
  });

  it.each(sourceFiles().map((file) => [relative(SRC, file), file]))("%s", (_name, file) => {
    expect(findHardCoded(readFileSync(file, "utf8"))).toEqual([]);
  });

  it.each([
    ['className="bg-[#fff]"', "hex colour"],
    ['className="text-[#B91C1C]"', "Tailwind arbitrary value"],
    ['className="h-[44px]"', "CSS length"],
    ['className="min-h-[2.75rem]"', "Tailwind arbitrary value"],
    ["const ring = 'rgb(37 99 235)';", "CSS colour function"],
    ['className="oklch(0.5 0.1 200)"', "CSS colour function"],
    ['className="[&>svg]:size-4"', "Tailwind arbitrary property or variant"],
    ['className="[mask-type:luminance]"', "Tailwind arbitrary property or variant"],
    ["// sized 1em by default", "CSS length"],
    ['className="data-[state=on]:bg-accent"', "Tailwind arbitrary value"],
    ['className="h-(--my-height)"', "Tailwind CSS-variable shorthand"],
    ["<div style={{ width: 44 }} />", "inline style"],
    ['className="shadow-md"', "shadow or gradient"],
    ['className="shadow"', "shadow or gradient"],
    ['className="bg-linear-to-r"', "shadow or gradient"],
    ['className="bg-red-500"', "Tailwind default palette"],
    ['className="text-white"', "Tailwind default palette"],
    ['className="opacity-50"', "opacity instead of a colour token"],
    ['className="bg-accent/80"', "opacity instead of a colour token"],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample is source text.
      "const c = `text-${size}`;",
      "class built at runtime (Tailwind can't see it)",
    ],
  ])("catches %s (%s)", (line, rule) => {
    expect(findHardCoded(line).join("\n")).toContain(rule);
  });

  it.each([
    'className="min-h-touch-min rounded-md border-hairline border-border bg-bg px-3 text-amount"',
    'className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"',
    'className="size-2.5 gap-1 aria-checked:border-accent group-aria-checked:border-accent"',
    'pattern="[0-9]*"',
    "// No shadows: hairline borders instead.",
    'import { Slot } from "@radix-ui/react-slot";',
    'className="w-1/2 p-4"',
  ])("allows %s", (line) => {
    expect(findHardCoded(line)).toEqual([]);
  });
});

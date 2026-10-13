/**
 * Acceptance (T-024): no floating-point arithmetic on money anywhere in @cb/domain.
 *
 * Scans every non-test source file in `packages/domain/src` (comments stripped) for the usual ways
 * floats sneak into money code. Each rule is proven to fire on a sample, so the scan can't go
 * silently vacuous. If a rule ever blocks legitimate code, change the code to integer/bigint maths
 * rather than loosening the rule.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

type Rule = { name: string; pattern: RegExp; sample: string; scope?: "money" };

const RULES: Rule[] = [
  { name: "parseFloat", pattern: /\bparseFloat\b/, sample: "Number.parseFloat(text)" },
  { name: "toFixed / toPrecision", pattern: /\.(toFixed|toPrecision)\(/, sample: "x.toFixed(2)" },
  {
    name: "Math rounding (a sign the value was fractional)",
    pattern: /\bMath\.(round|floor|ceil|trunc|fround)\b/,
    sample: "Math.round(rupees * 100)",
  },
  {
    name: "fractional number literal",
    pattern: /(?<![\w.])\d+\.\d+/,
    sample: "const rate = 0.18;",
  },
  {
    name: "number division by 100 / PAISE_PER_RUPEE (use bigint / 100n)",
    pattern: /\/\s*(100|PAISE_PER_RUPEE)\b/,
    sample: "const rupees = amount / 100;",
  },
  {
    name: "multiplying by a fraction",
    pattern: /\*\s*0?\.\d/,
    sample: "amount * .01",
  },
  {
    // Biome always puts spaces around a binary `/`; a regex literal's closing `/` has none.
    name: "number division in money code (use bigint)",
    pattern: /\s\/=?\s+(\d+(?![\dn])|[A-Za-z_]\w*)/,
    sample: "return total / count;",
    scope: "money",
  },
];

function stripComments(source: string): string {
  // Block comments keep their newlines so reported line numbers stay right.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function sourceFiles(): { path: string; code: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => ({
      path: relative(SRC, join(SRC, path)).replaceAll("\\", "/"),
      code: stripComments(readFileSync(join(SRC, path), "utf8")),
    }));
}

describe("no floating-point money maths in @cb/domain", () => {
  const files = sourceFiles();

  it("finds the source files", () => {
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["money/paise.ts", "money/format.ts", "time/period.ts", "result.ts"]),
    );
  });

  it.each(RULES)("rule fires on its sample: $name", (rule) => {
    expect(rule.pattern.test(rule.sample)).toBe(true);
  });

  it("allows the bigint and integer forms the code uses", () => {
    for (const ok of ["value / 100n", "abs % 100n", "rupees * PAISE_PER_RUPEE", "/^\\d+$/"]) {
      for (const rule of RULES) expect(rule.pattern.test(ok), `${rule.name}: ${ok}`).toBe(false);
    }
  });

  it.each(RULES)("no file breaks: $name", (rule) => {
    const offenders = files
      .filter((file) => rule.scope === undefined || file.path.startsWith(`${rule.scope}/`))
      .flatMap((file) =>
        file.code
          .split("\n")
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => rule.pattern.test(line))
          .map(({ line, index }) => `${file.path}:${index + 1}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});

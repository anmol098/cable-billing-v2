import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareOutputs, generate, loadTokens, writeOutputs } from "./fs";
import { OUTPUT_PATHS, renderOutputs } from "./outputs";

describe("generated outputs", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("are exactly theme.css and Tokens.kt", () => {
    expect(renderOutputs(loadTokens()).map((file) => file.path)).toEqual([
      OUTPUT_PATHS.css,
      OUTPUT_PATHS.kotlin,
    ]);
  });

  it("changing color.accent changes both files and nothing else", () => {
    const tokens = loadTokens();
    const before = renderOutputs(tokens);
    const accent = tokens.color.accent;
    if (!accent) throw new Error("accent missing");
    accent.value = "#0F766E";
    const after = renderOutputs(tokens);

    expect(after.map((file) => file.path)).toEqual(before.map((file) => file.path));
    const [cssBefore, ktBefore] = before.map((file) => file.content.split("\n"));
    const [cssAfter, ktAfter] = after.map((file) => file.content.split("\n"));
    const changed = (a: string[] = [], b: string[] = []) => b.filter((line, i) => line !== a[i]);
    expect(changed(cssBefore, cssAfter)).toEqual(["  --color-accent: #0F766E;"]);
    expect(changed(ktBefore, ktAfter)).toEqual(["        val Accent = ComposeColor(0xFF0F766E)"]);
  });

  it("the committed files match tokens.json (same as `tokens:build --check`)", () => {
    expect(compareOutputs(generate())).toEqual([
      { path: OUTPUT_PATHS.css, status: "unchanged" },
      { path: OUTPUT_PATHS.kotlin, status: "unchanged" },
    ]);
  });

  it("writes missing or changed files and reports stale ones", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-tokens-"));
    temps.push(root);
    const files = generate();

    expect(compareOutputs(files, root).map((file) => file.status)).toEqual(["missing", "missing"]);
    writeOutputs(files, root);
    expect(compareOutputs(files, root).map((file) => file.status)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(readFileSync(join(root, OUTPUT_PATHS.kotlin), "utf8")).toContain("object Tokens {");

    const edited = files.map((file, i) => (i === 0 ? { ...file, content: "edited" } : file));
    expect(compareOutputs(edited, root).map((file) => file.status)).toEqual([
      "changed",
      "unchanged",
    ]);
  });
});

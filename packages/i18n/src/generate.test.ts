import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCatalog } from "./catalog";
import { generateFiles } from "./generate";
import { loadRawCatalog } from "./load";

const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "../..");

describe("loadRawCatalog", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads every namespace file per locale and reports invalid JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-i18n-"));
    for (const locale of ["en", "hi"]) mkdirSync(join(dir, locale));
    writeFileSync(join(dir, "en/common.json"), '{ "save": "Save" }');
    writeFileSync(join(dir, "en/bills.json"), '{ "title": "Bills" }');
    writeFileSync(join(dir, "en/notes.txt"), "ignored");
    writeFileSync(join(dir, "hi/common.json"), '{ "save": "सेव" ');
    const { raw, errors } = loadRawCatalog(dir);
    expect(raw.en).toEqual({ bills: { title: "Bills" }, common: { save: "Save" } });
    expect(raw.hi).toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("hi/common.json");
    expect(errors[0]?.message).toMatch(/^invalid JSON/);
  });
});

describe("the real catalog (packages/i18n/messages)", () => {
  const loaded = loadRawCatalog(join(packageDir, "messages"));
  const result = validateCatalog(loaded.raw);

  it("passes every check", () => {
    expect(loaded.errors).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("seeds the common namespace with the product name in both languages", () => {
    expect(result.catalog.en.common?.flat.get("app_name")).toBe("Cable Billing");
    expect(result.catalog.hi.common?.flat.get("app_name")).toBe("केबल बिलिंग");
  });

  it("matches the committed generated files (run `pnpm --filter @cb/i18n i18n:build`)", () => {
    for (const file of generateFiles(result.catalog)) {
      expect(readFileSync(join(repoRoot, file.path), "utf8"), file.path).toBe(file.content);
      // The `_review` list itself (a key such as `resolve_review` is fine, T-035).
      expect(file.content).not.toContain('"_review"');
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tsconfigPresets } from "./index";

const readPreset = (name: string): { compilerOptions?: Record<string, unknown> } =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

describe("@cb/config", () => {
  it.each(tsconfigPresets)("%s is valid JSON", (name) => {
    expect(readPreset(name)).toBeTypeOf("object");
  });

  it("keeps the base preset strict", () => {
    const options = readPreset("tsconfig.base.json").compilerOptions;
    expect(options?.strict).toBe(true);
    expect(options?.noUncheckedIndexedAccess).toBe(true);
  });
});

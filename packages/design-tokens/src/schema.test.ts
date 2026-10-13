import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKENS_PATH } from "./fs";
import { parseTokens, TokenValidationError } from "./schema";

const raw = () => JSON.parse(readFileSync(TOKENS_PATH, "utf8"));

function issuesOf(mutate: (tokens: ReturnType<typeof raw>) => void): string[] {
  const tokens = raw();
  mutate(tokens);
  try {
    parseTokens(tokens);
  } catch (error) {
    expect(error).toBeInstanceOf(TokenValidationError);
    return [...(error as TokenValidationError).issues];
  }
  throw new Error("expected tokens to be invalid");
}

describe("tokens.json schema", () => {
  it("accepts the committed tokens.json", () => {
    const tokens = parseTokens(raw());
    expect(tokens.color.accent?.value).toBe("#111111");
    expect(tokens.type.android.amount).toBe(44);
  });

  it("fails on a missing required token", () => {
    expect(issuesOf((t) => delete t.color.accent)).toContain(
      'color.accent: missing required token "accent"',
    );
    expect(issuesOf((t) => delete t.semantic.cash)).toContain(
      'semantic.cash: missing required token "cash"',
    );
    expect(issuesOf((t) => delete t.type.web.amount).join("\n")).toMatch(/type\.web\.amount/);
    expect(issuesOf((t) => delete t.space).join("\n")).toMatch(/^space:/m);
  });

  it.each(["red", "#FFF", "111111", "#11111G", "rgb(17,17,17)"])(
    "fails on a non-hex colour: %s",
    (value) => {
      expect(issuesOf((t) => (t.color.accent.value = value))).toEqual([
        "color.accent.value: must be a hex colour: #RRGGBB or #RRGGBBAA",
      ]);
    },
  );

  it("fails on invalid values", () => {
    expect(issuesOf((t) => (t.radius.md = -1))).toEqual(["radius.md: must be a number, 0 or more"]);
    expect(issuesOf((t) => (t.radius.md = "8px")).join()).toMatch(/radius\.md/);
    expect(issuesOf((t) => (t.border.hairline = 0)).join()).toMatch(/border\.hairline/);
    expect(issuesOf((t) => (t.font.weight.strong.value = 650)).join()).toMatch(/weight\.strong/);
    expect(issuesOf((t) => (t.font.family.numeric.features = ["tabular"])).join()).toMatch(
      /OpenType feature/,
    );
    expect(issuesOf((t) => (t.size.touchMin = { web: 44 })).join()).toMatch(/size\.touchMin/);
  });

  it("fails on unknown keys and bad names", () => {
    expect(issuesOf((t) => (t.colour = {})).join()).toMatch(/colour/);
    expect(issuesOf((t) => (t.color.accent.alpha = 1)).join()).toMatch(/alpha/);
    expect(issuesOf((t) => (t.color["text-muted"] = { value: "#000000" })).join()).toMatch(
      /camelCase/,
    );
  });

  it("fails on clashing names", () => {
    expect(issuesOf((t) => (t.semantic.accent = { value: "#000000" }))).toContain(
      'semantic.accent: "accent" is defined in both color and semantic',
    );
    expect(issuesOf((t) => (t.color.lg = { value: "#000000" })).join()).toMatch(/ambiguous/);
  });

  it("requires the same type steps on both platforms", () => {
    expect(issuesOf((t) => (t.type.web.huge = 60))).toContain(
      'type.android.huge: type step "huge" exists for web but not android',
    );
  });
});

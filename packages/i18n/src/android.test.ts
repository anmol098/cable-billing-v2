import { describe, expect, it } from "vitest";
import {
  AndroidCompileError,
  type AndroidValue,
  androidArgs,
  compileAndroid,
  renderAndroidXml,
} from "./android";
import { parseMessage } from "./icu";

function ast(message: string) {
  const parsed = parseMessage(message);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.ast;
}

/** Compiles `message`, numbering arguments from `source` (the English message). */
function compile(message: string, source = message): AndroidValue {
  return compileAndroid(ast(message), androidArgs(ast(source)));
}

function str(message: string, source = message): string {
  const value = compile(message, source);
  if (value.kind !== "string") throw new Error("expected a string");
  return value.value;
}

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/**
 * A model of how aapt2 reads a <string> body: XML entities are decoded, then unquoted runs of
 * whitespace collapse to one space and are trimmed at the ends, `"` toggles quoting, unescaped
 * `'` is an error, and backslash escapes are resolved. Used to prove escaping round-trips.
 */
function aapt2Decode(xmlText: string): string {
  expect(xmlText, "raw < or a bare & would be invalid XML").not.toMatch(/<|&(?!(amp|lt|gt);)/);
  const text = xmlText.replace(/&(amp|lt|gt);/g, (m) => XML_ENTITIES[m] as string);
  let out = "";
  let pendingSpace = false;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (!quoted && /\s/.test(c)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (c === "'" && !quoted) throw new Error("unescaped apostrophe");
    if (c === "\\") {
      const next = text[++i] as string;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "u") {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += next;
      continue;
    }
    if ((c === "@" || c === "?") && out.length === 0)
      throw new Error(`leading ${c} is a reference`);
    out += c;
  }
  return out;
}

describe("Android escaping", () => {
  it("escapes apostrophes, quotes and backslashes", () => {
    expect(str("Don't")).toBe("Don\\'t");
    expect(str('Say "hi"')).toBe('Say \\"hi\\"');
    expect(str("a\\b")).toBe("a\\\\b");
  });

  it("decodes ICU apostrophe quoting before escaping", () => {
    expect(str("It''s '{'literal'}'")).toBe("It\\'s {literal}");
  });

  it("escapes & and < as XML entities", () => {
    expect(str("Cash & UPI < 5")).toBe("Cash &amp; UPI &lt; 5");
  });

  it("escapes a leading @ or ? but not later ones", () => {
    expect(str("@home")).toBe("\\@home");
    expect(str("?help")).toBe("\\?help");
    expect(str("mail@x.in?")).toBe("mail@x.in?");
  });

  it("escapes newlines and tabs", () => {
    expect(str("one\ntwo\tthree")).toBe("one\\ntwo\\tthree");
  });

  it("keeps % as-is (formatted=false) when there are no arguments", () => {
    expect(compile("50% off")).toEqual({ kind: "string", value: "50% off", formatted: false });
    expect(compile("No percent")).toEqual({ kind: "string", value: "No percent", formatted: true });
  });

  it("doubles % when the string takes arguments", () => {
    expect(compile("{rate}% of {total}")).toEqual({
      kind: "string",
      value: "%1$s%% of %2$s",
      formatted: true,
    });
  });

  it("protects leading, trailing and repeated spaces from aapt2 whitespace collapsing", () => {
    expect(str(" a  b ")).toBe("\\u0020a \\u0020b\\u0020");
  });

  it("round-trips tricky text through an aapt2 model", () => {
    for (const text of [
      'Don\'t "quote" me \\ now',
      "@start ?mid & a < b > 5",
      "  two  spaces\nnew line\ttab ",
      "रमेश कुमार, ₹450 बाकी",
      "100% sure",
    ]) {
      const parsed = ast(text.replaceAll("'", "''"));
      const value = compileAndroid(parsed, []);
      if (value.kind !== "string") throw new Error("expected a string");
      expect(aapt2Decode(value.value)).toBe(text);
    }
  });
});

describe("ICU → Android placeholders", () => {
  it("numbers arguments by first appearance in the English message", () => {
    const en = "₹{amount} from {name}";
    expect(str(en)).toBe("₹%1$s from %2$s");
    // Hindi puts the name first but keeps the English numbering.
    expect(str("{name} से ₹{amount}", en)).toBe("%2$s से ₹%1$s");
  });

  it("maps {x, number} and {x, number, integer} to %d", () => {
    expect(str("{n, number} bills, {m, number, integer} left")).toBe("%1$d bills, %2$d left");
  });

  it("reuses one index when an argument repeats", () => {
    expect(str("{name}, {name}!")).toBe("%1$s, %1$s!");
  });

  it("turns a top-level plural into <plurals>, copying the surrounding text into each item", () => {
    expect(compile("{name}: {count, plural, one {# bill} other {# bills}} due")).toEqual({
      kind: "plurals",
      items: [
        ["one", "%1$s: %2$d bill due"],
        ["other", "%1$s: %2$d bills due"],
      ],
    });
  });

  it("always doubles % inside plurals (they are always formatted with the count)", () => {
    expect(compile("{count, plural, one {100% done} other {# at 100%}}")).toEqual({
      kind: "plurals",
      items: [
        ["one", "100%% done"],
        ["other", "%1$d at 100%%"],
      ],
    });
  });

  it.each([
    ["{kind, select, cash {Cash} other {UPI}}", /select/],
    ["{n, selectordinal, one {#st} other {#th}}", /selectordinal/],
    ["Paid on {d, date, short}", /date/],
    ["{amount, number, ::currency/INR}", /pre-formatted/],
    ["Tap <b>Save</b>", /tag/],
    ["{n, plural, =0 {None} other {#}}", /exact plural selector/],
    ["{n, plural, offset:1 one {#} other {#}}", /offset/],
    ["{a, plural, one {# x} other {# y}} {b, plural, one {# x} other {# y}}", /only one plural/],
    ["{a, plural, one {{b, plural, one {#} other {#}}} other {x}}", /top level/],
  ])("rejects %s", (message, error) => {
    expect(() => compile(message)).toThrow(AndroidCompileError);
    expect(() => compile(message)).toThrow(error);
  });
});

describe("renderAndroidXml", () => {
  it("never writes `--` inside an XML comment (aapt2 rejects it)", () => {
    const xml = renderAndroidXml(
      [{ name: "a", args: [{ name: "x", index: 1, format: "s" }], value: compile("{x}") }],
      "messages--en---dir",
    );
    const comments = xml.match(/<!--[\s\S]*?-->/g) ?? [];
    expect(comments.length).toBeGreaterThan(0);
    for (const comment of comments) {
      expect(comment.slice(4, -3)).not.toContain("--");
    }
  });

  it("sorts entries, documents argument positions and marks %-strings formatted=false", () => {
    const xml = renderAndroidXml(
      [
        {
          name: "b_plural",
          args: [{ name: "count", index: 1, format: "d" }],
          value: compile("{count, plural, one {# bill} other {# bills}}"),
        },
        { name: "a_percent", args: [], value: compile("50% off") },
      ],
      "packages/i18n/messages/en",
    );
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<!-- GENERATED by @cb/i18n from packages/i18n/messages/en. Do not edit. -->",
        "<!-- Regenerate: pnpm i18n:build (repo root) -->",
        "<resources>",
        '    <string name="a_percent" formatted="false">50% off</string>',
        "    <!-- %1$d = count -->",
        '    <plurals name="b_plural">',
        '        <item quantity="one">%1$d bill</item>',
        '        <item quantity="other">%1$d bills</item>',
        "    </plurals>",
        "</resources>",
        "",
      ].join("\n"),
    );
  });
});

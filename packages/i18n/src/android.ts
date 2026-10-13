import {
  isArgumentElement,
  isDateElement,
  isLiteralElement,
  isNumberElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  type MessageFormatElement,
  type PluralElement,
} from "@formatjs/icu-messageformat-parser";
import { walk } from "./icu";

/**
 * ICU → Android mapping (documented in packages/i18n/README.md):
 *
 * - `{name}` → `%N$s`; `{count, number}` / `{count, number, integer}` → `%N$d`.
 * - N is the 1-based position of the argument's FIRST appearance in the ENGLISH message.
 *   Every locale reuses the English numbering, so Kotlin passes arguments in one order.
 * - A message with one top-level `{count, plural, …}` becomes `<plurals>`; text around the plural
 *   is copied into every `<item>`, and `#` becomes the count's `%N$d`.
 * - Anything Android can't express (select, selectordinal, dates, rich-text tags, number styles,
 *   `=N` selectors, offsets, nested or multiple plurals) is a check error in Android namespaces.
 */

export type AndroidFormat = "s" | "d";

export interface AndroidArg {
  name: string;
  /** 1-based position used in `%N$…`. */
  index: number;
  format: AndroidFormat;
}

/** Android plural quantities, in the order aapt2 documents them. */
export const ANDROID_QUANTITIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type AndroidQuantity = (typeof ANDROID_QUANTITIES)[number];

export type AndroidValue =
  | { kind: "string"; value: string; formatted: boolean }
  | { kind: "plurals"; items: Array<[AndroidQuantity, string]> };

export interface AndroidEntry {
  name: string;
  args: AndroidArg[];
  value: AndroidValue;
}

export class AndroidCompileError extends Error {
  override name = "AndroidCompileError";
}

/** `common` + `bills.due` → `common_bills_due`. */
export function androidResourceName(namespace: string, key: string): string {
  return `${namespace}_${key.replaceAll(".", "_")}`;
}

/** Positional arguments for a key, derived from its English (source) message. */
export function androidArgs(sourceAst: readonly MessageFormatElement[]): AndroidArg[] {
  const byName = new Map<string, AndroidArg>();
  walk(sourceAst, (el) => {
    const numeric = isNumberElement(el) || isPluralElement(el);
    if (!numeric && !isArgumentElement(el)) return;
    const existing = byName.get(el.value);
    if (existing) {
      if (numeric) existing.format = "d";
      return;
    }
    byName.set(el.value, { name: el.value, index: byName.size + 1, format: numeric ? "d" : "s" });
  });
  return [...byName.values()];
}

type Token = { text: string } | { format: string };

function unsupported(el: MessageFormatElement, topLevel: boolean): string | null {
  if (isTagElement(el)) return `rich-text tag <${el.value}> is not supported on Android`;
  if (isSelectElement(el)) {
    return `{${el.value}, select} is not supported on Android; use one key per case`;
  }
  if (isDateElement(el) || isTimeElement(el)) {
    return `{${el.value}, date|time} is not supported on Android; format it in code and pass {${el.value}}`;
  }
  if (isNumberElement(el) && el.style != null && el.style !== "integer") {
    return `{${el.value}, number, …} styles are not supported on Android; pass pre-formatted text as {${el.value}}`;
  }
  if (isPluralElement(el)) {
    if (el.pluralType === "ordinal")
      return `{${el.value}, selectordinal} is not supported on Android`;
    if (!topLevel)
      return `{${el.value}, plural} must be at the top level of the message on Android`;
    if (el.offset !== 0) return `plural offset is not supported on Android`;
    const exact = Object.keys(el.options).find((s) => s.startsWith("="));
    if (exact) return `exact plural selector "${exact}" is not supported on Android; use one/other`;
  }
  return null;
}

function toTokens(
  elements: readonly MessageFormatElement[],
  args: ReadonlyMap<string, AndroidArg>,
  poundArg: AndroidArg | undefined,
): Token[] {
  const tokens: Token[] = [];
  const spec = (name: string): string => {
    const arg = args.get(name);
    if (!arg) throw new AndroidCompileError(`{${name}} does not exist in the English message`);
    return `%${arg.index}$${arg.format}`;
  };
  for (const el of elements) {
    if (isLiteralElement(el)) tokens.push({ text: el.value });
    else if (isArgumentElement(el) || isNumberElement(el)) tokens.push({ format: spec(el.value) });
    else if (isPoundElement(el)) {
      if (!poundArg) throw new AndroidCompileError("# outside a plural");
      tokens.push({ format: `%${poundArg.index}$d` });
    } else throw new AndroidCompileError("unexpected ICU element");
  }
  return tokens;
}

/**
 * Escapes text for an Android string resource (aapt2 rules) and for XML:
 * `\` `'` `"` are backslash-escaped, `@`/`?` only at the very start (where aapt2 would read a
 * resource reference), newline/tab become `\n`/`\t`, `&` `<` `>` become entities, and spaces that
 * aapt2 would collapse or trim (leading, trailing, repeated) become ` `. A literal `%` is `%%`
 * in strings that take arguments; strings without arguments keep `%` and are marked
 * `formatted="false"` by the renderer.
 */
export function escapeAndroid(tokens: readonly Token[], hasArgs: boolean): string {
  let out = "";
  let prevSpace = false;
  tokens.forEach((token, t) => {
    if ("format" in token) {
      out += token.format;
      prevSpace = false;
      return;
    }
    const chars = [...token.text];
    chars.forEach((c, i) => {
      const atStart = out.length === 0;
      const atEnd = t === tokens.length - 1 && i === chars.length - 1;
      if (c === " ") {
        out += atStart || atEnd || prevSpace ? "\\u0020" : " ";
        prevSpace = true;
        return;
      }
      prevSpace = false;
      switch (c) {
        case "\\":
          out += "\\\\";
          break;
        case "'":
          out += "\\'";
          break;
        case '"':
          out += '\\"';
          break;
        case "\n":
          out += "\\n";
          break;
        case "\t":
          out += "\\t";
          break;
        case "@":
        case "?":
          out += atStart ? `\\${c}` : c;
          break;
        case "&":
          out += "&amp;";
          break;
        case "<":
          out += "&lt;";
          break;
        case ">":
          out += "&gt;";
          break;
        case "%":
          out += hasArgs ? "%%" : "%";
          break;
        default:
          out += c;
      }
    });
  });
  return out;
}

/**
 * Compiles one parsed message to an Android string or plurals value, using the English
 * argument numbering. Throws `AndroidCompileError` for constructs Android can't express.
 */
export function compileAndroid(
  ast: readonly MessageFormatElement[],
  args: readonly AndroidArg[],
): AndroidValue {
  const problems: string[] = [];
  for (const el of ast) {
    const problem = unsupported(el, true);
    if (problem) problems.push(problem);
    if (isPluralElement(el) || isSelectElement(el) || isTagElement(el)) {
      const children = isTagElement(el)
        ? el.children
        : Object.values(el.options).flatMap((o) => o.value);
      walk(children, (child) => {
        const nested = unsupported(child, false);
        if (nested) problems.push(nested);
      });
    }
  }
  const plurals = ast.filter((el): el is PluralElement => isPluralElement(el));
  if (plurals.length > 1) problems.push("only one plural per message is supported on Android");
  if (problems.length > 0) throw new AndroidCompileError([...new Set(problems)].join("; "));

  const byName = new Map(args.map((a) => [a.name, a]));
  const hasArgs = args.length > 0;
  const plural = plurals[0];
  if (!plural) {
    const value = escapeAndroid(toTokens(ast, byName, undefined), hasArgs);
    return { kind: "string", value, formatted: hasArgs || !value.includes("%") };
  }
  const at = ast.indexOf(plural);
  const before = toTokens(ast.slice(0, at), byName, undefined);
  const after = toTokens(ast.slice(at + 1), byName, undefined);
  const countArg = byName.get(plural.value);
  const items: Array<[AndroidQuantity, string]> = [];
  for (const quantity of ANDROID_QUANTITIES) {
    const option = plural.options[quantity];
    if (!option) continue;
    const branch = toTokens(option.value, byName, countArg);
    items.push([quantity, escapeAndroid([...before, ...branch, ...after], true)]);
  }
  return { kind: "plurals", items };
}

const INDENT = "    ";

/** An XML comment. XML forbids `--` inside comments (aapt2 rejects the file), so it is split. */
function xmlComment(text: string): string {
  return `<!-- ${text.replace(/-(?=-)/g, "- ")} -->`;
}

/** Renders a deterministic `strings_generated.xml` (entries sorted by resource name). */
export function renderAndroidXml(entries: readonly AndroidEntry[], sourceDir: string): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    xmlComment(`GENERATED by @cb/i18n from ${sourceDir}. Do not edit.`),
    xmlComment("Regenerate: pnpm i18n:build (repo root)"),
    "<resources>",
  ];
  for (const entry of sorted) {
    if (entry.args.length > 0) {
      const map = entry.args.map((a) => `%${a.index}$${a.format} = ${a.name}`).join(", ");
      lines.push(`${INDENT}${xmlComment(map)}`);
    }
    const { value } = entry;
    if (value.kind === "string") {
      const formatted = value.formatted ? "" : ' formatted="false"';
      lines.push(`${INDENT}<string name="${entry.name}"${formatted}>${value.value}</string>`);
    } else {
      lines.push(`${INDENT}<plurals name="${entry.name}">`);
      for (const [quantity, text] of value.items) {
        lines.push(`${INDENT}${INDENT}<item quantity="${quantity}">${text}</item>`);
      }
      lines.push(`${INDENT}</plurals>`);
    }
  }
  lines.push("</resources>", "");
  return lines.join("\n");
}

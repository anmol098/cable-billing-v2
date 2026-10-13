import {
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  type MessageFormatElement,
  parse,
} from "@formatjs/icu-messageformat-parser";

export type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";

/**
 * How a message uses one of its inputs. `tag` is a next-intl rich-text tag (`<b>…</b>`).
 * `selectordinal` is reported as `ordinal`.
 */
export type ArgKind =
  | "string"
  | "number"
  | "date"
  | "time"
  | "select"
  | "plural"
  | "ordinal"
  | "tag";

export type ParseResult = { ok: true; ast: MessageFormatElement[] } | { ok: false; error: string };

/**
 * Parses an ICU message the same way next-intl (intl-messageformat) does: tags enabled,
 * and every plural/select must have an `other` branch.
 */
export function parseMessage(message: string): ParseResult {
  try {
    return { ok: true, ast: parse(message, { requiresOtherClause: true }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Calls `visit` for every element, depth first, in source order (plural/select branches in authored order). */
export function walk(
  ast: readonly MessageFormatElement[],
  visit: (el: MessageFormatElement) => void,
): void {
  for (const el of ast) {
    visit(el);
    if (isPluralElement(el) || isSelectElement(el)) {
      for (const option of Object.values(el.options)) walk(option.value, visit);
    } else if (isTagElement(el)) {
      walk(el.children, visit);
    }
  }
}

function kindOf(el: MessageFormatElement): ArgKind | null {
  if (isArgumentElement(el)) return "string";
  if (isNumberElement(el)) return "number";
  if (isDateElement(el)) return "date";
  if (isTimeElement(el)) return "time";
  if (isSelectElement(el)) return "select";
  if (isPluralElement(el)) return el.pluralType === "ordinal" ? "ordinal" : "plural";
  if (isTagElement(el)) return "tag";
  return null;
}

/**
 * The inputs a message needs, as `name → kinds`, in order of first appearance.
 * Two translations of one key must have equal signatures (placeholder parity).
 */
export function argSignature(ast: readonly MessageFormatElement[]): Map<string, Set<ArgKind>> {
  const signature = new Map<string, Set<ArgKind>>();
  walk(ast, (el) => {
    const kind = kindOf(el);
    if (kind === null || !("value" in el)) return;
    const kinds = signature.get(el.value) ?? new Set<ArgKind>();
    kinds.add(kind);
    signature.set(el.value, kinds);
  });
  return signature;
}

/** A stable, human-readable form of a signature, e.g. `count:plural, name:string`. */
export function formatSignature(signature: Map<string, Set<ArgKind>>): string {
  return [...signature.entries()]
    .map(([name, kinds]) => `${name}:${[...kinds].sort().join("|")}`)
    .sort()
    .join(", ");
}

/**
 * Plural selectors that the locale never produces (e.g. `few` in Hindi) are dead branches,
 * almost always a copy-paste mistake. Exact selectors like `=0` are always allowed here.
 */
export function invalidPluralSelectors(
  ast: readonly MessageFormatElement[],
  locale: string,
): string[] {
  const problems: string[] = [];
  walk(ast, (el) => {
    if (!isPluralElement(el)) return;
    const type = el.pluralType === "ordinal" ? "ordinal" : "cardinal";
    const allowed = new Set<string>(
      new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories,
    );
    for (const selector of Object.keys(el.options)) {
      if (/^=\d+$/.test(selector) || allowed.has(selector)) continue;
      problems.push(
        `{${el.value}, ${type === "ordinal" ? "selectordinal" : "plural"}} uses "${selector}", ` +
          `which "${locale}" never selects (allowed: ${[...allowed].join(", ")}, or =N)`,
      );
    }
  });
  return problems;
}

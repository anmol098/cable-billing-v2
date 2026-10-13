import {
  AndroidCompileError,
  type AndroidEntry,
  androidArgs,
  androidResourceName,
  compileAndroid,
} from "./android";
import {
  argSignature,
  formatSignature,
  invalidPluralSelectors,
  type MessageFormatElement,
  parseMessage,
} from "./icu";
import {
  isAndroidNamespace,
  LOCALES,
  type Locale,
  NAME_PATTERN,
  REVIEW_KEY,
  SOURCE_LOCALE,
} from "./locales";

/** A namespace file's messages: snake_case keys, values are ICU strings or nested groups. */
export type MessageTree = { [key: string]: string | MessageTree };

/** Parsed JSON of every `messages/<locale>/<namespace>.json`, before validation. */
export type RawCatalog = Record<Locale, Record<string, unknown>>;

export interface Namespace {
  /** Messages without the `_review` list. */
  messages: MessageTree;
  /** Dotted key (`group.key`) → ICU message. */
  flat: Map<string, string>;
  /** Machine-drafted keys awaiting product-owner review (translations only). */
  review: string[];
}

export type Catalog = Record<Locale, Record<string, Namespace>>;

export interface Issue {
  /** Source file relative to `messages/`, e.g. `hi/common.json`. */
  file: string;
  key?: string;
  message: string;
}

export interface ValidationResult {
  catalog: Catalog;
  errors: Issue[];
  /** Number of `_review`-flagged keys across all translations. */
  reviewCount: number;
}

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Control characters other than tab and newline are invalid in XML 1.0 or collapse unpredictably.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTree(
  node: Record<string, unknown>,
  prefix: string,
  file: string,
  flat: Map<string, string>,
  errors: Issue[],
): MessageTree {
  const tree: MessageTree = {};
  for (const [segment, value] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${segment}` : segment;
    if (!NAME_PATTERN.test(segment)) {
      errors.push({
        file,
        key,
        message: `key segment "${segment}" must be snake_case ([a-z][a-z0-9_]*)`,
      });
      continue;
    }
    if (typeof value === "string") {
      if (value.trim() === "") errors.push({ file, key, message: "message is empty" });
      else if (CONTROL_CHARS.test(value)) {
        errors.push({
          file,
          key,
          message: "message contains a control character (only \\n and \\t are allowed)",
        });
      }
      tree[segment] = value;
      flat.set(key, value);
    } else if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) errors.push({ file, key, message: "group is empty" });
      tree[segment] = readTree(value, key, file, flat, errors);
    } else {
      errors.push({
        file,
        key,
        message: "value must be a string (ICU message) or an object (group)",
      });
    }
  }
  return tree;
}

function readNamespace(
  locale: Locale,
  namespace: string,
  json: unknown,
  errors: Issue[],
): Namespace | null {
  const file = `${locale}/${namespace}.json`;
  if (!NAME_PATTERN.test(namespace)) {
    errors.push({ file, message: "namespace file name must be snake_case ([a-z][a-z0-9_]*.json)" });
    return null;
  }
  if (!isPlainObject(json)) {
    errors.push({ file, message: "file must contain a JSON object" });
    return null;
  }
  const { [REVIEW_KEY]: reviewRaw, ...rest } = json;
  const review: string[] = [];
  if (reviewRaw !== undefined) {
    if (locale === SOURCE_LOCALE) {
      errors.push({
        file,
        key: REVIEW_KEY,
        message: `only translations carry a ${REVIEW_KEY} list`,
      });
    } else if (!Array.isArray(reviewRaw) || reviewRaw.some((k) => typeof k !== "string")) {
      errors.push({
        file,
        key: REVIEW_KEY,
        message: `${REVIEW_KEY} must be an array of key names`,
      });
    } else {
      review.push(...(reviewRaw as string[]));
    }
  }
  const flat = new Map<string, string>();
  const messages = readTree(rest, "", file, flat, errors);
  const seen = new Set<string>();
  for (const key of review) {
    if (seen.has(key)) errors.push({ file, key: REVIEW_KEY, message: `"${key}" is listed twice` });
    else if (!flat.has(key)) {
      errors.push({ file, key: REVIEW_KEY, message: `"${key}" is not a key in this file` });
    }
    seen.add(key);
  }
  return { messages, flat, review };
}

/**
 * Validates every rule the generator depends on:
 * file/key naming, both locales have the same namespaces and keys, ICU syntax (plural `other`
 * branch, valid plural categories per locale), placeholder parity with English, `_review`
 * lists, and Android compatibility + unique resource names for `common` and `mobile_*`.
 */
export function validateCatalog(raw: RawCatalog): ValidationResult {
  const errors: Issue[] = [];
  const catalog = Object.fromEntries(LOCALES.map((l) => [l, {}])) as Catalog;

  for (const locale of LOCALES) {
    for (const namespace of Object.keys(raw[locale]).sort(compare)) {
      const ns = readNamespace(locale, namespace, raw[locale][namespace], errors);
      if (ns) catalog[locale][namespace] = ns;
    }
  }

  const namespaces = new Set(LOCALES.flatMap((l) => Object.keys(catalog[l])));
  const androidNames = new Map<string, string>();

  for (const namespace of [...namespaces].sort(compare)) {
    const missingIn = LOCALES.filter((l) => !catalog[l][namespace]);
    for (const locale of missingIn) {
      errors.push({
        file: `${locale}/${namespace}.json`,
        message: "file is missing; every locale needs every namespace",
      });
    }
    if (missingIn.length > 0) continue;

    const source = catalog[SOURCE_LOCALE][namespace] as Namespace;
    const sourceFile = `${SOURCE_LOCALE}/${namespace}.json`;
    const asts = new Map<string, Map<Locale, MessageFormatElement[]>>();

    for (const locale of LOCALES) {
      const file = `${locale}/${namespace}.json`;
      const ns = catalog[locale][namespace] as Namespace;
      for (const [key, message] of ns.flat) {
        if (locale !== SOURCE_LOCALE && !source.flat.has(key)) {
          errors.push({ file, key, message: `key does not exist in ${sourceFile}` });
          continue;
        }
        const parsed = parseMessage(message);
        if (!parsed.ok) {
          errors.push({ file, key, message: `invalid ICU message: ${parsed.error}` });
          continue;
        }
        for (const problem of invalidPluralSelectors(parsed.ast, locale)) {
          errors.push({ file, key, message: problem });
        }
        for (const name of argSignature(parsed.ast).keys()) {
          if (!ARG_NAME.test(name)) {
            errors.push({
              file,
              key,
              message: `placeholder/tag name "${name}" must match ${ARG_NAME}`,
            });
          }
        }
        const byLocale = asts.get(key) ?? new Map<Locale, MessageFormatElement[]>();
        byLocale.set(locale, parsed.ast);
        asts.set(key, byLocale);
      }
      if (locale !== SOURCE_LOCALE) {
        for (const key of source.flat.keys()) {
          if (!ns.flat.has(key)) {
            errors.push({ file, key, message: `missing translation (${sourceFile} has this key)` });
          }
        }
      }
    }

    for (const [key, byLocale] of asts) {
      const sourceAst = byLocale.get(SOURCE_LOCALE);
      if (!sourceAst) continue;
      const expected = formatSignature(argSignature(sourceAst));
      for (const [locale, ast] of byLocale) {
        if (locale === SOURCE_LOCALE) continue;
        const actual = formatSignature(argSignature(ast));
        if (actual !== expected) {
          errors.push({
            file: `${locale}/${namespace}.json`,
            key,
            message: `placeholders differ from ${sourceFile}: expected {${expected}}, found {${actual}}`,
          });
        }
      }
      if (!isAndroidNamespace(namespace)) continue;

      const name = androidResourceName(namespace, key);
      const clash = androidNames.get(name);
      if (clash) {
        errors.push({
          file: sourceFile,
          key,
          message: `Android resource name "${name}" clashes with ${clash}`,
        });
      }
      androidNames.set(name, `${namespace}:${key}`);
      const args = androidArgs(sourceAst);
      for (const [locale, ast] of byLocale) {
        try {
          compileAndroid(ast, args);
        } catch (error) {
          if (!(error instanceof AndroidCompileError)) throw error;
          errors.push({
            file: `${locale}/${namespace}.json`,
            key,
            message: `Android: ${error.message}`,
          });
        }
      }
    }
  }

  const reviewCount = LOCALES.filter((l) => l !== SOURCE_LOCALE)
    .flatMap((l) => Object.values(catalog[l]))
    .reduce((n, ns) => n + ns.review.length, 0);
  return { catalog, errors, reviewCount };
}

/** Builds the Android entries for one locale (only `common` and `mobile_*` namespaces). */
export function buildAndroidEntries(catalog: Catalog, locale: Locale): AndroidEntry[] {
  const entries: AndroidEntry[] = [];
  for (const [namespace, source] of Object.entries(catalog[SOURCE_LOCALE])) {
    if (!isAndroidNamespace(namespace)) continue;
    const target = catalog[locale][namespace];
    if (!target) throw new Error(`${locale}/${namespace}.json is missing`);
    for (const [key, sourceMessage] of source.flat) {
      const message = target.flat.get(key);
      if (message === undefined) throw new Error(`${locale}/${namespace}.json is missing "${key}"`);
      const sourceAst = parseMessage(sourceMessage);
      const ast = parseMessage(message);
      if (!sourceAst.ok || !ast.ok) throw new Error(`${namespace}.${key} is not valid ICU`);
      const args = androidArgs(sourceAst.ast);
      entries.push({
        name: androidResourceName(namespace, key),
        args,
        value: compileAndroid(ast.ast, args),
      });
    }
  }
  return entries;
}

function sortTree(tree: MessageTree): MessageTree {
  const sorted: MessageTree = {};
  for (const key of Object.keys(tree).sort(compare)) {
    const value = tree[key] as string | MessageTree;
    sorted[key] = typeof value === "string" ? value : sortTree(value);
  }
  return sorted;
}

/** next-intl messages for one locale: `{ namespace: { key: message } }`, keys sorted, no `_review`. */
export function buildWebMessages(catalog: Catalog, locale: Locale): MessageTree {
  const messages: MessageTree = {};
  for (const namespace of Object.keys(catalog[locale]).sort(compare)) {
    messages[namespace] = sortTree((catalog[locale][namespace] as Namespace).messages);
  }
  return messages;
}

/** Deterministic JSON: 2-space indent, trailing newline (keys must already be sorted). */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

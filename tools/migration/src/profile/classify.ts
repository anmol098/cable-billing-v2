import {
  ENUM_WORDS,
  IDENTIFYING_ROOTS,
  IDENTIFYING_WORDS,
  MONEY_WORDS,
  PERSON_NAME_ROOTS,
  SENSITIVE_ROOTS,
  SENSITIVE_WORDS,
} from "../config";

/** Splits a column name into lower-case words: `isReceipt` → is, receipt; `cust_mobile2` → cust, mobile, 2. */
export function columnWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function hasWordOrRoot(
  name: string,
  words: ReadonlySet<string>,
  roots: readonly string[],
): boolean {
  const parts = columnWords(name);
  const joined = parts.join("");
  return parts.some((part) => words.has(part)) || roots.some((root) => joined.includes(root));
}

export type ColumnClass = "sensitive" | "enum" | "money" | "other";

export interface ColumnClassification {
  readonly class: ColumnClass;
  /** Values are names, phones, addresses, logins or secrets (forbidden in the profile). */
  readonly identifying: boolean;
  /** Values are person names (their single words are forbidden as status values too). */
  readonly personName: boolean;
}

/**
 * Sensitive wins over everything: a `contact_status` column is never listed. Enum columns are
 * found by name (`status`, `isReceipt`, `pay_mode` …) or by type (ENUM, SET, BIT, TINYINT(1)).
 */
export function classifyColumn(column: {
  readonly name: string;
  readonly dataType: string;
  readonly columnType: string;
}): ColumnClassification {
  const identifying = hasWordOrRoot(column.name, IDENTIFYING_WORDS, IDENTIFYING_ROOTS);
  const personName = hasWordOrRoot(column.name, new Set(), PERSON_NAME_ROOTS);
  if (identifying || hasWordOrRoot(column.name, SENSITIVE_WORDS, SENSITIVE_ROOTS)) {
    return { class: "sensitive", identifying, personName };
  }
  const words = columnWords(column.name);
  const flagName = /^(is|has)[A-Z_]/.test(column.name) || /^(is|has)_/i.test(column.name);
  const enumType =
    ["enum", "set", "bit", "bool", "boolean"].includes(column.dataType) ||
    /^tinyint\(1\)/.test(column.columnType);
  if (flagName || enumType || words.some((word) => ENUM_WORDS.has(word))) {
    return { class: "enum", identifying: false, personName: false };
  }
  if (words.some((word) => MONEY_WORDS.has(word))) {
    return { class: "money", identifying: false, personName: false };
  }
  return { class: "other", identifying: false, personName: false };
}

/**
 * Builds the counts-only profile of the copied legacy tables (PLAN §15 step 1).
 *
 * Every number comes from an aggregate query; the only row values that ever reach this process
 * are status-like codes (to count them) and, in `collectForbiddenValues`, identifying values (to
 * keep them out). Status values go through `isShowableValue` before they are kept.
 */
import type pg from "pg";
import {
  BASELINE_COUNTS,
  DOCUMENTED_TABLES,
  DUPLICATE_CHECKS,
  ENUM_VALUE_PATTERN,
  MAX_ENUM_VALUES,
  MIN_ENUM_VALUE_ROWS,
  OPERATOR_COLUMN_CANDIDATES,
  OPERATOR_KEY_CANDIDATES,
  OPERATOR_TABLE,
  RELATION_CHECKS,
} from "../config";
import { quotePgIdent } from "../copy/types";
import type { ForbiddenValues } from "../pii/scan";
import { shapeFindings } from "../pii/scan";
import {
  type Catalog,
  type CatalogColumn,
  type CatalogTable,
  findColumn,
  findTable,
  qualified,
} from "./catalog";
import type {
  ColumnProfile,
  DuplicateResult,
  EnumValues,
  OperatorBreakdown,
  OperatorTableCounts,
  Profile,
  RelationResult,
  TableProfile,
} from "./types";

/** The IST business date of an instant, `YYYY-MM-DD`. */
export function istDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export async function collectProfile(
  client: pg.ClientBase,
  catalog: Catalog,
  forbidden: ForbiddenValues,
  now: Date = new Date(),
): Promise<Profile> {
  const tables: TableProfile[] = [];
  for (const table of catalog.tables) tables.push(await profileTable(client, table, forbidden));
  const documented = new Set<string>(DOCUMENTED_TABLES);
  return {
    date: istDate(now),
    generatedAt: now.toISOString(),
    copyRun: catalog.lastRun,
    tables,
    operators: await operatorBreakdown(client, catalog, forbidden),
    relations: await relationChecks(client, catalog),
    duplicates: await duplicateChecks(client, catalog, forbidden),
    missingDocumentedTables: [...documented].filter((name) => !findTable(catalog, name)),
  };
}

const n = (value: unknown): number => Number(value ?? 0);

async function profileTable(
  client: pg.ClientBase,
  table: CatalogTable,
  forbidden: ForbiddenValues,
): Promise<TableProfile> {
  const select: string[] = ["count(*) AS rows"];
  table.columns.forEach((column, i) => {
    const c = quotePgIdent(column.name);
    select.push(`count(*) FILTER (WHERE ${c} IS NULL) AS n${i}`);
    select.push(`count(DISTINCT ${c}) AS d${i}`);
    if (column.kind === "text" || column.kind === "temporal") {
      select.push(`count(*) FILTER (WHERE btrim(${c}) = '') AS b${i}`);
    }
    if (column.kind === "temporal") {
      const validType = dateValidityType(column);
      select.push(`count(*) FILTER (WHERE ${c} ~ '^0000(-00-00)?') AS z${i}`);
      if (validType) {
        const valid = `pg_input_is_valid(${c}, '${validType}')`;
        select.push(
          `count(*) FILTER (WHERE btrim(${c}) <> '' AND ${c} !~ '^0000(-00-00)?' AND NOT ${valid}) AS i${i}`,
        );
        select.push(`min(left(${c}, 10)) FILTER (WHERE ${valid}) AS lo${i}`);
        select.push(`max(left(${c}, 10)) FILTER (WHERE ${valid}) AS hi${i}`);
      }
    }
    if (hasNumberStats(column)) {
      const num = `${c}::numeric`;
      select.push(`count(*) FILTER (WHERE ${num} < 0) AS neg${i}`);
      select.push(`count(*) FILTER (WHERE ${num} = 0) AS zero${i}`);
      select.push(`count(*) FILTER (WHERE ${num} <> trunc(${num})) AS frac${i}`);
      select.push(`count(*) FILTER (WHERE ${num} <> round(${num}, 2)) AS sub${i}`);
      if (column.classification.class === "money") {
        select.push(`count(*) FILTER (WHERE ${num} <> 0 AND ${num} % 100 = 0) AS hund${i}`);
      }
    }
  });
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${select.join(", ")} FROM ${qualified(table.name)}`,
  );
  const row = result.rows[0] ?? {};
  const columns: ColumnProfile[] = [];
  for (const [i, column] of table.columns.entries()) {
    const distinct = n(row[`d${i}`]);
    const sensitive = column.classification.class === "sensitive";
    columns.push({
      name: column.name,
      sourceType: column.columnType,
      kind: column.kind,
      class: column.classification.class,
      primaryKey: column.primaryKey,
      nulls: n(row[`n${i}`]),
      blank: `b${i}` in row ? n(row[`b${i}`]) : null,
      distinct,
      nulBytesRemoved: column.nulBytesRemoved,
      dates:
        column.kind === "temporal"
          ? {
              zero: n(row[`z${i}`]),
              invalid: n(row[`i${i}`]),
              min: sensitive ? null : ((row[`lo${i}`] as string | null) ?? null),
              max: sensitive ? null : ((row[`hi${i}`] as string | null) ?? null),
            }
          : null,
      numbers: hasNumberStats(column)
        ? {
            negative: n(row[`neg${i}`]),
            zero: n(row[`zero${i}`]),
            fractional: n(row[`frac${i}`]),
            subPaisa: n(row[`sub${i}`]),
            wholeHundreds: `hund${i}` in row ? n(row[`hund${i}`]) : null,
          }
        : null,
      values:
        column.classification.class === "enum"
          ? await enumValues(client, table, column, distinct, forbidden)
          : null,
    });
  }
  const documented = DOCUMENTED_TABLES.find((name) => name === table.name.toLowerCase());
  return {
    name: table.name,
    documented: documented !== undefined,
    baseline: documented ? (BASELINE_COUNTS[documented] ?? null) : null,
    rows: n(row.rows),
    columns,
  };
}

function dateValidityType(column: CatalogColumn): "date" | "timestamp" | null {
  if (column.dataType === "date") return "date";
  if (column.dataType === "datetime" || column.dataType === "timestamp") return "timestamp";
  return null;
}

function hasNumberStats(column: CatalogColumn): boolean {
  if (column.classification.class === "sensitive") return false;
  if (column.kind === "float" || column.kind === "decimal") return true;
  return column.kind === "integer" && column.classification.class === "money";
}

/**
 * True when a status value may appear in the report. See docs/migration/README.md. Small integer
 * codes (`0`, `1`, `-1`, `12`) are shown however rare: they cannot be personal data.
 */
export function isShowableValue(value: string, rows: number, forbidden: ForbiddenValues): boolean {
  return (
    (rows >= MIN_ENUM_VALUE_ROWS || /^-?\d{1,3}$/.test(value)) &&
    ENUM_VALUE_PATTERN.test(value) &&
    shapeFindings(value).length === 0 &&
    !forbidden.contains(value)
  );
}

async function enumValues(
  client: pg.ClientBase,
  table: CatalogTable,
  column: CatalogColumn,
  distinct: number,
  forbidden: ForbiddenValues,
): Promise<EnumValues> {
  if (distinct > MAX_ENUM_VALUES) {
    return { shown: [], suppressedValues: 0, suppressedRows: 0, tooMany: true };
  }
  const c = quotePgIdent(column.name);
  const asText = column.kind === "binary" ? `encode(${c}, 'hex')` : `${c}::text`;
  const result = await client.query<{ v: string; rows: string }>(
    `SELECT ${asText} AS v, count(*) AS rows FROM ${qualified(table.name)}
      WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1`,
  );
  const shown: { value: string; rows: number }[] = [];
  let suppressedValues = 0;
  let suppressedRows = 0;
  for (const { v, rows } of result.rows) {
    if (isShowableValue(v, n(rows), forbidden)) {
      shown.push({ value: v, rows: n(rows) });
    } else {
      suppressedValues += 1;
      suppressedRows += n(rows);
    }
  }
  return { shown, suppressedValues, suppressedRows, tooMany: false };
}

/** Operator ids that are not short codes (or match personal data) are grouped under this label. */
export const HELD_BACK_ID = "(held back)";

function showableId(id: string, forbidden: ForbiddenValues): boolean {
  return (
    ENUM_VALUE_PATTERN.test(id) &&
    !id.includes(" ") &&
    shapeFindings(id).length === 0 &&
    !forbidden.contains(id)
  );
}

async function operatorBreakdown(
  client: pg.ClientBase,
  catalog: Catalog,
  forbidden: ForbiddenValues,
): Promise<OperatorBreakdown | null> {
  const operatorTable = findTable(catalog, OPERATOR_TABLE);
  const key = findColumn(operatorTable, OPERATOR_KEY_CANDIDATES);
  if (!operatorTable || !key) return null;
  const ids = await client.query<{ id: string }>(
    `SELECT DISTINCT ${quotePgIdent(key.name)}::text AS id FROM ${qualified(operatorTable.name)}
      WHERE ${quotePgIdent(key.name)} IS NOT NULL`,
  );
  const known = new Set(ids.rows.map((r) => r.id));
  const operatorIds = [
    ...new Set(ids.rows.map((r) => (showableId(r.id, forbidden) ? r.id : HELD_BACK_ID))),
  ].sort(compareIds);
  const tables: OperatorTableCounts[] = [];
  for (const table of catalog.tables) {
    if (table === operatorTable) continue;
    const column = findColumn(table, OPERATOR_COLUMN_CANDIDATES);
    if (!column) continue;
    const groups = await client.query<{ op: string | null; rows: string }>(
      `SELECT ${quotePgIdent(column.name)}::text AS op, count(*) AS rows
         FROM ${qualified(table.name)} GROUP BY 1`,
    );
    const byOperator: Record<string, number> = {};
    let nullOperator = 0;
    let unknownOperator = 0;
    let groupSum = 0;
    for (const group of groups.rows) {
      const rows = n(group.rows);
      groupSum += rows;
      if (group.op === null) {
        nullOperator += rows;
        continue;
      }
      const label = showableId(group.op, forbidden) ? group.op : HELD_BACK_ID;
      byOperator[label] = (byOperator[label] ?? 0) + rows;
      if (!known.has(group.op)) unknownOperator += rows;
    }
    const total = await client.query<{ rows: string }>(
      `SELECT count(*) AS rows FROM ${qualified(table.name)}`,
    );
    tables.push({
      table: table.name,
      column: column.name,
      byOperator,
      nullOperator,
      unknownOperator,
      total: n(total.rows[0]?.rows),
      groupSum,
    });
  }
  return { operatorIds, tables };
}

/** Numeric ids in numeric order, then the rest. */
export function compareIds(a: string, b: string): number {
  const na = /^-?\d+$/.test(a) ? Number(a) : Number.NaN;
  const nb = /^-?\d+$/.test(b) ? Number(b) : Number.NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (!Number.isNaN(na)) return -1;
  if (!Number.isNaN(nb)) return 1;
  return a.localeCompare(b);
}

async function relationChecks(client: pg.ClientBase, catalog: Catalog): Promise<RelationResult[]> {
  const results: RelationResult[] = [];
  for (const check of RELATION_CHECKS) {
    const empty = { name: check.name, rows: 0, nulls: 0, zero: 0, orphans: 0 };
    const table = findTable(catalog, check.table);
    const parent = findTable(catalog, check.parent);
    if (!table || !parent) {
      const missing = table ? check.parent : check.table;
      results.push({ ...empty, status: { checked: false, reason: `no table ${missing}` } });
      continue;
    }
    const column = findColumn(table, check.columnCandidates);
    const key = findColumn(parent, check.parentKeyCandidates);
    if (!column || !key) {
      const reason = column
        ? `no key column in ${parent.name} (tried ${check.parentKeyCandidates.join(", ")})`
        : `no reference column in ${table.name} (tried ${check.columnCandidates.join(", ")})`;
      results.push({ ...empty, status: { checked: false, reason } });
      continue;
    }
    const c = `t.${quotePgIdent(column.name)}`;
    const k = quotePgIdent(key.name);
    // Distinct parent keys, hash-joined: a correlated NOT EXISTS is quadratic on 146k invoices.
    const result = await client.query<Record<string, string>>(
      `WITH keys AS (
         SELECT DISTINCT btrim(${k}::text) AS k FROM ${qualified(parent.name)} WHERE ${k} IS NOT NULL)
       SELECT count(*) AS rows,
              count(*) FILTER (WHERE ${c} IS NULL) AS nulls,
              count(*) FILTER (WHERE btrim(${c}::text) IN ('0', '')) AS zero,
              count(*) FILTER (WHERE ${c} IS NOT NULL AND btrim(${c}::text) NOT IN ('0', '')
                                 AND keys.k IS NULL) AS orphans
         FROM ${qualified(table.name)} t
         LEFT JOIN keys ON keys.k = btrim(${c}::text)`,
    );
    const row = result.rows[0] ?? {};
    results.push({
      name: check.name,
      status: { checked: true, column: column.name, parentKey: key.name },
      rows: n(row.rows),
      nulls: n(row.nulls),
      zero: n(row.zero),
      orphans: n(row.orphans),
    });
  }
  return results;
}

async function duplicateChecks(
  client: pg.ClientBase,
  catalog: Catalog,
  forbidden: ForbiddenValues,
): Promise<DuplicateResult[]> {
  const results: DuplicateResult[] = [];
  for (const check of DUPLICATE_CHECKS) {
    const base = {
      name: check.name,
      perOperator: check.perOperator,
      groups: 0,
      rows: 0,
      byOperator: [],
    };
    const table = findTable(catalog, check.table);
    if (!table) {
      results.push({ ...base, status: { checked: false, reason: `no table ${check.table}` } });
      continue;
    }
    const column = findColumn(table, check.columnCandidates);
    if (!column) {
      const reason = `no column in ${table.name} (tried ${check.columnCandidates.join(", ")})`;
      results.push({ ...base, status: { checked: false, reason } });
      continue;
    }
    const operator = check.perOperator ? findColumn(table, OPERATOR_COLUMN_CANDIDATES) : undefined;
    if (check.perOperator && !operator) {
      const reason = `no operator column in ${table.name}`;
      results.push({ ...base, status: { checked: false, reason } });
      continue;
    }
    const c = quotePgIdent(column.name);
    const op = operator ? `${quotePgIdent(operator.name)}::text` : "''";
    const result = await client.query<{ op: string | null; groups: string; rows: string }>(
      `WITH v AS (
         SELECT ${op} AS op, lower(btrim(${c}::text)) AS k FROM ${qualified(table.name)}
          WHERE ${c} IS NOT NULL AND btrim(${c}::text) <> ''),
       g AS (SELECT op, k, count(*) AS n FROM v GROUP BY op, k HAVING count(*) > 1)
       SELECT op, count(*) AS groups, sum(n) AS rows FROM g GROUP BY op`,
    );
    const merged = new Map<string, { groups: number; rows: number }>();
    for (const r of result.rows) {
      const label = r.op === null ? "(null)" : showableId(r.op, forbidden) ? r.op : HELD_BACK_ID;
      const entry = merged.get(label) ?? { groups: 0, rows: 0 };
      merged.set(label, { groups: entry.groups + n(r.groups), rows: entry.rows + n(r.rows) });
    }
    const byOperator = [...merged.entries()]
      .map(([operator, counts]) => ({ operator, ...counts }))
      .sort((a, b) => compareIds(a.operator, b.operator));
    results.push({
      ...base,
      status: { checked: true, column: column.name },
      groups: byOperator.reduce((sum, r) => sum + r.groups, 0),
      rows: byOperator.reduce((sum, r) => sum + r.rows, 0),
      byOperator: check.perOperator ? byOperator : [],
    });
  }
  return results;
}

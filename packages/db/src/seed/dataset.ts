/**
 * One operator's seed rows, how they are inserted and how they are hashed (T-036).
 *
 * Rows are typed with each table's Drizzle `$inferInsert`, so a renamed or retyped column breaks
 * the build instead of the seed. They are inserted in {@link INSERT_ORDER} (foreign keys first)
 * with one `INSERT … SELECT FROM unnest($1::type[], …)` per chunk: one round trip and one parameter
 * per column, far faster than multi-row VALUES, and still through `withTenant` (RLS on, the
 * append-only triggers untouched: every row is inserted once in its final state, nothing is
 * updated or deleted).
 */
import { createHash } from "node:crypto";
import { type Column, getTableColumns, getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  accounts,
  adjustments,
  allocations,
  areas,
  assignmentEvents,
  billingRunItems,
  billingRuns,
  collectionSessions,
  counters,
  customerBalances,
  customers,
  devices,
  invoiceLines,
  invoices,
  ledgerEntries,
  operators,
  paymentReversals,
  payments,
  plans,
  receipts,
  subscriptions,
  users,
  vcAssets,
  vcAssignments,
} from "../schema";
import type { Tx } from "../tenant";

type Rows<T extends PgTable> = T["$inferInsert"][];

/** Every row the seed writes for one operator, by table. */
export interface SeedDataset {
  operators: Rows<typeof operators>;
  subscriptions: Rows<typeof subscriptions>;
  users: Rows<typeof users>;
  accounts: Rows<typeof accounts>;
  devices: Rows<typeof devices>;
  areas: Rows<typeof areas>;
  plans: Rows<typeof plans>;
  customers: Rows<typeof customers>;
  vcAssets: Rows<typeof vcAssets>;
  vcAssignments: Rows<typeof vcAssignments>;
  assignmentEvents: Rows<typeof assignmentEvents>;
  billingRuns: Rows<typeof billingRuns>;
  invoices: Rows<typeof invoices>;
  adjustments: Rows<typeof adjustments>;
  invoiceLines: Rows<typeof invoiceLines>;
  billingRunItems: Rows<typeof billingRunItems>;
  payments: Rows<typeof payments>;
  paymentReversals: Rows<typeof paymentReversals>;
  receipts: Rows<typeof receipts>;
  /** Positive allocation rows (posting, credit application). */
  allocations: Rows<typeof allocations>;
  /** Negative rows of payment reversals: inserted after the rows they cancel (trigger). */
  reversalAllocations: Rows<typeof allocations>;
  /** In posting order: `seq` (identity) follows the insert order. */
  ledgerEntries: Rows<typeof ledgerEntries>;
  customerBalances: Rows<typeof customerBalances>;
  counters: Rows<typeof counters>;
  collectionSessions: Rows<typeof collectionSessions>;
}

export function emptyDataset(): SeedDataset {
  return {
    operators: [],
    subscriptions: [],
    users: [],
    accounts: [],
    devices: [],
    areas: [],
    plans: [],
    customers: [],
    vcAssets: [],
    vcAssignments: [],
    assignmentEvents: [],
    billingRuns: [],
    invoices: [],
    adjustments: [],
    invoiceLines: [],
    billingRunItems: [],
    payments: [],
    paymentReversals: [],
    receipts: [],
    allocations: [],
    reversalAllocations: [],
    ledgerEntries: [],
    customerBalances: [],
    counters: [],
    collectionSessions: [],
  };
}

/** Insert order: every row's foreign keys point at rows inserted before it. */
export const INSERT_ORDER: readonly (readonly [keyof SeedDataset, PgTable])[] = [
  ["operators", operators],
  ["subscriptions", subscriptions],
  ["users", users],
  ["accounts", accounts],
  ["devices", devices],
  ["areas", areas],
  ["plans", plans],
  ["customers", customers],
  ["vcAssets", vcAssets],
  ["vcAssignments", vcAssignments],
  ["assignmentEvents", assignmentEvents],
  ["billingRuns", billingRuns],
  ["invoices", invoices],
  // Debit adjustments are inserted already pointing at the invoice that billed them, before
  // the lines (invoice_lines_adjustment_fk needs adjustments.invoice_id set).
  ["adjustments", adjustments],
  ["invoiceLines", invoiceLines],
  ["billingRunItems", billingRunItems],
  ["payments", payments],
  ["paymentReversals", paymentReversals],
  ["receipts", receipts],
  ["allocations", allocations],
  ["reversalAllocations", allocations],
  ["ledgerEntries", ledgerEntries],
  ["customerBalances", customerBalances],
  ["counters", counters],
  ["collectionSessions", collectionSessions],
];

interface InsertColumn {
  readonly key: string;
  readonly column: Column;
  /** The Postgres array type of the parameter, e.g. `uuid[]`, `"customer_status"[]`. */
  readonly arrayType: string;
}

const columnCache = new Map<PgTable, InsertColumn[]>();

/** The columns the seed may write: everything except generated and identity columns. */
function insertableColumns(table: PgTable): InsertColumn[] {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const result: InsertColumn[] = [];
  for (const [key, column] of Object.entries(getTableColumns(table)) as [string, Column][]) {
    if (column.generated !== undefined || column.generatedIdentity !== undefined) continue;
    const type = column.getSQLType();
    const isEnum = column.columnType === "PgEnumColumn";
    result.push({ key, column, arrayType: `${isEnum ? `"${type}"` : type}[]` });
  }
  columnCache.set(table, result);
  return result;
}

function driverValue(column: Column, value: unknown): unknown {
  return value === null || value === undefined ? null : column.mapToDriverValue(value);
}

/** Rows per INSERT statement. */
export const INSERT_CHUNK = 5_000;

/**
 * Inserts `rows` into `table` inside `tx`. Columns that no row sets are left out (their database
 * default applies); a column set by some rows is NULL in the others.
 */
export async function bulkInsert(
  tx: Tx,
  table: PgTable,
  rows: readonly Record<string, unknown>[],
  chunkSize: number = INSERT_CHUNK,
): Promise<void> {
  if (rows.length === 0) return;
  const columns = insertableColumns(table).filter((c) => rows.some((r) => r[c.key] !== undefined));
  const names = sql.join(
    columns.map((c) => sql.identifier(c.column.name)),
    sql`, `,
  );
  const aliases = columns.map((_, i) => `c${i}`);
  const selectList = sql.raw(aliases.join(", "));
  const aliasList = sql.raw([...aliases, "ord"].join(", "));
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const arrays = columns.map(
      (c) =>
        sql`${sql.param(chunk.map((row) => driverValue(c.column, row[c.key])))}::${sql.raw(c.arrayType)}`,
    );
    // WITH ORDINALITY … ORDER BY keeps the array order, so identity columns (ledger seq) follow it.
    await tx.execute(
      sql`insert into ${table} (${names}) select ${selectList} from unnest(${sql.join(arrays, sql`, `)}) with ordinality as u(${aliasList}) order by ord`,
    );
  }
}

/** Inserts a whole dataset, in {@link INSERT_ORDER}, inside `tx`. */
export async function insertDataset(tx: Tx, data: SeedDataset): Promise<void> {
  for (const [key, table] of INSERT_ORDER) {
    await bulkInsert(tx, table, data[key] as Record<string, unknown>[]);
  }
}

/** Row counts by table name (both allocation passes count as `allocations`). */
export function datasetCounts(data: SeedDataset): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, table] of INSERT_ORDER) {
    const name = getTableName(table);
    counts[name] = (counts[name] ?? 0) + data[key].length;
  }
  return counts;
}

/**
 * SHA-256 over every row in insert order, with values as the driver would send them. Equal hashes
 * mean equal data (ids, amounts, dates, text); used by the determinism test and printed by the CLI.
 */
export function datasetHash(data: SeedDataset): string {
  const hash = createHash("sha256");
  for (const [key, table] of INSERT_ORDER) {
    const columns = insertableColumns(table);
    hash.update(`\u0000${key}\u0000`);
    for (const row of data[key] as Record<string, unknown>[]) {
      hash.update(JSON.stringify(columns.map((c) => driverValue(c.column, row[c.key]))));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

/**
 * Gap-free per-tenant counters (T-021, PLAN §7.2, §7.3): invoice numbers, permanent receipt
 * numbers, auto customer codes.
 *
 * `app.next_counter(operator_id, name)` (custom migration) is an `INSERT … ON CONFLICT DO UPDATE
 * … RETURNING`: the first call for a counter creates its row and returns 1; later calls lock the
 * row, increment it and return the value. Call it inside the same transaction that uses the number:
 * a concurrent caller waits on the row lock until that transaction ends, and a rollback undoes the
 * increment, so committed numbers have no gaps and no duplicates.
 *
 * It is SECURITY INVOKER, so RLS applies: inside `withTenant(A)` only A's counters can be read or
 * advanced (another operator's id → RLS error 42501). Triggers forbid deleting a counter (it would
 * restart at 1) and lowering `next_value`.
 */
import { sql } from "drizzle-orm";
import { bigint, check, pgEnum, pgTable, primaryKey } from "drizzle-orm/pg-core";
import { operatorIdColumn, tenantPolicies } from "../rls";
import type { Tx } from "../tenant";
import { operators } from "./tenancy";

export const COUNTER_NAMES = ["invoice", "receipt", "customer_code"] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];
export const counterNameEnum = pgEnum("counter_name", COUNTER_NAMES);

export const counters = pgTable(
  "counters",
  {
    operatorId: operatorIdColumn().references(() => operators.id),
    name: counterNameEnum("name").notNull(),
    /** The value the next call returns. */
    nextValue: bigint("next_value", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    primaryKey({ name: "counters_pkey", columns: [t.operatorId, t.name] }),
    check("counters_next_value_positive", sql`${t.nextValue} >= 1`),
    ...tenantPolicies(t),
  ],
).enableRLS();

/**
 * Takes the next number of a counter for the current tenant, inside `tx` (a `withTenant`
 * transaction). Keep the transaction short after calling it: other callers of the same counter
 * wait until it commits.
 */
export async function nextCounter(tx: Tx, operatorId: string, name: CounterName): Promise<number> {
  const result = await tx.execute<{ value: string | number }>(
    sql`select app.next_counter(${operatorId}::uuid, ${name}::counter_name) as value`,
  );
  const value = Number(result.rows[0]?.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`next_counter returned an invalid value for counter ${name}`);
  }
  return value;
}

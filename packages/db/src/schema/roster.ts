/**
 * Roster change tracking for the lineman app's delta sync (T-060, PLAN §10.3, contract
 * `syncCustomers`): one row per customer saying **which transaction last changed anything the
 * phone shows for that customer** and **when** (the roster row's `updated_at`).
 *
 * A roster row is built from several tables: the customer (code, name, phones, address, area,
 * status), the area's name, the current connections (`vc_assignments` + `vc_assets`) and the money
 * read model (`customer_balances`: balance, credit, oldest due month; open bills move with it).
 * Triggers on those tables (custom migration) upsert this row in the **same transaction** as the
 * change, so no write path (web, phone, billing run, import, legacy migration, a data fix) can
 * forget to "bump" the roster.
 *
 * - `change_xid` (`xid8`, `pg_current_xact_id()` of the writing transaction): the delta cursor's
 *   order. A cursor stores the **snapshot xmin** of the read that produced it; every transaction
 *   that had not committed by then has an xid ≥ that xmin, so a row committed late (a long billing
 *   run, a slow payment) is never skipped, whatever its clock said. Timestamps can't promise that:
 *   a transaction with an earlier `now` can commit after a later one was already read. `xid8` is
 *   64-bit and never wraps.
 * - `changed_at`: the roster row's `updated_at` on the wire. Strictly increasing per customer (at
 *   millisecond precision, the wire's): `greatest(previous + 1 ms, the writer's updated_at)`, or,
 *   for a second change in the same transaction, `greatest(previous, the writer's updated_at)`. The
 *   phone ignores a copy older than the one it has (T-064), so this must never go backwards even
 *   when transactions commit out of clock order.
 *
 * Kept in step by triggers only (`app.roster_touch`); services never write it. Never deleted
 * (customers are never deleted). RLS: the standard tenant policy.
 */
import {
  customType,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { operatorIdColumn, tenantPolicies } from "../rls";
import { customers } from "./customers";

/** Postgres `xid8` (64-bit transaction id). Read and written as decimal text. */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "xid8";
  },
});

export const rosterVersions = pgTable(
  "roster_versions",
  {
    customerId: uuid("customer_id").primaryKey(),
    operatorId: operatorIdColumn(),
    /** The last transaction that changed the customer's roster row (`pg_current_xact_id()`). */
    changeXid: xid8("change_xid").notNull(),
    /** The roster row's `updated_at` (strictly increasing per customer, millisecond precision). */
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("roster_versions_operator_customer_unique").on(t.operatorId, t.customerId),
    foreignKey({
      name: "roster_versions_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    // The delta sync's keyset: WHERE operator_id = $1 AND (change_xid, customer_id) > (...)
    index("roster_versions_sync_idx").on(t.operatorId, t.changeXid, t.customerId),
    ...tenantPolicies(t),
  ],
).enableRLS();

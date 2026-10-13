/**
 * Demo tables for @cb/db's own tests (not part of the real schema, not exported from the package).
 * They are built with the same helpers real schema modules use, and created through drizzle-kit's
 * SQL generator, so the tests exercise exactly the SQL `db:generate` would write.
 */
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type pg from "pg";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { appendOnlyTriggerSql } from "../triggers";

export const demoNotes = pgTable(
  "demo_notes",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [tenantKey(t), ...tenantPolicies(t)],
).enableRLS();

export const demoPayments = pgTable(
  "demo_payments",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
    reviewStatus: text("review_status").notNull().default("none"),
    reviewReason: text("review_reason"),
  },
  (t) => [tenantKey(t), ...tenantPolicies(t)],
).enableRLS();

/** The SQL drizzle-kit generates for the demo tables, plus the append-only trigger on payments. */
export async function demoSchemaStatements(): Promise<string[]> {
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ demoNotes, demoPayments }),
  );
  const trigger = appendOnlyTriggerSql({
    table: "demo_payments",
    allowedColumns: ["review_status", "review_reason"],
  });
  return [...statements, ...trigger.split("\n--> statement-breakpoint\n")];
}

/** Creates the demo tables as the owner (the role that ran the migrations). */
export async function applyDemoSchema(admin: Pick<pg.Pool, "query">): Promise<void> {
  for (const statement of await demoSchemaStatements()) await admin.query(statement);
}

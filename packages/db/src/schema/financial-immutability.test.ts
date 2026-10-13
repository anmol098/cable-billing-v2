/**
 * PLAN §7.1 Immutability, checked on the migrated catalog (T-023): every financial table is
 * append-only through `app.forbid_update_delete()` with exactly the columns listed here, and each
 * listed column is the minimum its workflow needs. A new column on one of these tables is frozen
 * automatically; making one updatable means changing the trigger and this list (reviewed).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { describeDb, MIGRATIONS_DIR, useTestDatabase } from "../testing";
import { appendOnlyTriggerSql } from "../triggers";

/** Table → the columns that may still change after insert, and why. */
const APPEND_ONLY: Record<string, Record<string, string>> = {
  invoices: {
    status: "issued → void (PLAN §7.1 'except status/void metadata'); void is final (trigger)",
    voided_at: "void metadata",
    voided_by: "void metadata",
    void_reason: "void metadata",
  },
  invoice_lines: {},
  adjustments: {
    invoice_id: "set once when a bill picks the debit up (PLAN §7.2); never changes (trigger)",
  },
  payments: {
    review_status: "needs_review → resolved (PLAN §10.4, T-048); only while needs_review (trigger)",
    reviewed_by: "who resolved it",
    reviewed_at: "when it was resolved",
    review_note: "the office's note",
  },
  payment_reversals: {},
  allocations: {},
  ledger_entries: {},
  receipts: {},
  receipt_actions: {},
};

describeDb("append-only financial tables", () => {
  const t = useTestDatabase();

  it("each table has the append-only row trigger with exactly its allowed columns, and no TRUNCATE", async () => {
    const { rows } = await t.current.admin.query<{ table: string; name: string; def: string }>(
      `SELECT c.relname AS table, tg.tgname AS name, pg_get_triggerdef(tg.oid) AS def
         FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
        WHERE NOT tg.tgisinternal AND c.relnamespace = 'public'::regnamespace`,
    );
    for (const [table, allowed] of Object.entries(APPEND_ONLY)) {
      const row = rows.find((r) => r.name === `${table}_append_only`);
      expect(row?.table, table).toBe(table);
      expect(row?.def).toContain("BEFORE DELETE OR UPDATE");
      expect(row?.def).toContain("FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete(");
      expect(row?.def).not.toContain(" WHEN ");
      const args = [
        ...(row?.def.match(/forbid_update_delete\((.*)\)$/)?.[1] ?? "").matchAll(/'([a-z_]+)'/g),
      ].map((m) => m[1]);
      expect(args, table).toEqual(Object.keys(allowed));
      const truncate = rows.find((r) => r.name === `${table}_no_truncate`);
      expect(truncate?.def, table).toContain("BEFORE TRUNCATE");
    }
  });

  it("the migration uses appendOnlyTriggerSql's exact SQL for each table", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n");
    for (const [table, allowed] of Object.entries(APPEND_ONLY)) {
      for (const statement of appendOnlyTriggerSql({
        table,
        allowedColumns: Object.keys(allowed),
      }).split("\n--> statement-breakpoint\n")) {
        expect(migrations, table).toContain(statement);
      }
    }
  });
});

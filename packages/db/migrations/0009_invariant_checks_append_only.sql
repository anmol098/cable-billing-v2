-- T-052 custom SQL: invariant_checks (packages/db/src/schema/invariants.ts) is append-only. A
-- nightly check result is evidence of the state of the books at that time: it is never updated,
-- deleted or truncated (app.forbid_update_delete, migration 0000; SQLSTATE CB001).
CREATE TRIGGER "invariant_checks_append_only"
  BEFORE UPDATE OR DELETE ON "public"."invariant_checks"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "invariant_checks_no_truncate"
  BEFORE TRUNCATE ON "public"."invariant_checks"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();

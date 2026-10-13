-- T-062 custom SQL: handover_events (packages/db/src/schema/handovers.ts) is append-only. Every
-- cash handover submission and every office decision stays as it was recorded: never updated,
-- deleted or truncated (app.forbid_update_delete, migration 0000; SQLSTATE CB001).
CREATE TRIGGER "handover_events_append_only"
  BEFORE UPDATE OR DELETE ON "public"."handover_events"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "handover_events_no_truncate"
  BEFORE TRUNCATE ON "public"."handover_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();

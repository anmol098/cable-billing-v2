-- T-086 custom SQL (packages/db/src/schema/platform-admin.ts):
-- 1. support_access_grants is append-only except ending a grant early (ended_at, ended_by): the
--    reason, the admin and the expiry never change, and no grant is ever deleted. Ending is
--    final: once ended_at is set, neither it nor ended_by changes again (no reopening a grant by
--    setting them back to NULL, no moving the end time).
-- 2. subscription_offline_payments (a money record) is fully append-only.
-- 3. app_platform reads only the columns listed in PLATFORM_READ_COLUMNS of six tenant tables
--    (platformReadGrantsSql()): the table-wide SELECT from the default privileges is revoked and
--    SELECT is granted per column, so names, phones, amounts and free text stay unreadable to the
--    platform role. The matching USING (true) SELECT policies are in the generated migration
--    just before this one.
CREATE TRIGGER "support_access_grants_append_only"
  BEFORE UPDATE OR DELETE ON "public"."support_access_grants"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete('ended_at', 'ended_by');
--> statement-breakpoint
CREATE TRIGGER "support_access_grants_end_final"
  BEFORE UPDATE OF ended_at, ended_by ON "public"."support_access_grants"
  FOR EACH ROW
  WHEN (OLD.ended_at IS NOT NULL
    AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by IS DISTINCT FROM OLD.ended_by))
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "support_access_grants_no_truncate"
  BEFORE TRUNCATE ON "public"."support_access_grants"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "subscription_offline_payments_append_only"
  BEFORE UPDATE OR DELETE ON "public"."subscription_offline_payments"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "subscription_offline_payments_no_truncate"
  BEFORE TRUNCATE ON "public"."subscription_offline_payments"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."customers" FROM app_platform;
--> statement-breakpoint
GRANT SELECT ("operator_id", "status") ON TABLE "public"."customers" TO app_platform;
--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."billing_runs" FROM app_platform;
--> statement-breakpoint
GRANT SELECT ("id", "operator_id", "period", "trigger", "status", "skip_reason", "customer_count", "created_count", "already_exists_count", "skipped_count", "failed_count", "started_at", "finished_at", "created_at", "updated_at") ON TABLE "public"."billing_runs" TO app_platform;
--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."billing_run_items" FROM app_platform;
--> statement-breakpoint
GRANT SELECT ("operator_id", "run_id", "outcome", "reason") ON TABLE "public"."billing_run_items" TO app_platform;
--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."invariant_checks" FROM app_platform;
--> statement-breakpoint
GRANT SELECT ("id", "operator_id", "run_id", "checked_at", "status", "violation_count", "counts", "created_at") ON TABLE "public"."invariant_checks" TO app_platform;
--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."receipt_actions" FROM app_platform;
--> statement-breakpoint
GRANT SELECT ("operator_id", "action", "at") ON TABLE "public"."receipt_actions" TO app_platform;
--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."collection_sessions" FROM app_platform;
--> statement-breakpoint
GRANT SELECT ("operator_id", "status", "business_date", "discrepancy_reason") ON TABLE "public"."collection_sessions" TO app_platform;

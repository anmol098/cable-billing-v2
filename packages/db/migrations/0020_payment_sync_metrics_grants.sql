-- T-086a custom SQL (packages/db/src/schema/sync-metrics.ts):
-- 1. payment_sync_batches and payment_sync_rejections are append-only: a recorded count or a
--    refusal's dedupe key is never updated, deleted or truncated (app.forbid_update_delete).
-- 2. app_platform reads only the count columns of payment_sync_batches (PLATFORM_READ_COLUMNS,
--    platformReadGrantsSql(["payment_sync_batches"])): the table-wide SELECT from the default
--    privileges is revoked and SELECT is granted per column. The USING (true) SELECT policy is in
--    the generated migration just before this one. payment_sync_rejections has no platform
--    policy (default deny).
CREATE TRIGGER "payment_sync_batches_append_only"
  BEFORE UPDATE OR DELETE ON "public"."payment_sync_batches"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "payment_sync_batches_no_truncate"
  BEFORE TRUNCATE ON "public"."payment_sync_batches"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "payment_sync_rejections_append_only"
  BEFORE UPDATE OR DELETE ON "public"."payment_sync_rejections"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "payment_sync_rejections_no_truncate"
  BEFORE TRUNCATE ON "public"."payment_sync_rejections"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."payment_sync_batches" FROM app_platform;
--> statement-breakpoint
GRANT SELECT ("operator_id", "business_date", "items", "posted", "posted_needs_review", "duplicate", "rejected_validation", "rejected_customer_not_found", "rejected_id_reused", "rejected_without_id", "rejected_new_ids", "accepted_after_rejection", "retry_later_conflict", "retry_later_internal", "retry_later_rate_limited") ON TABLE "public"."payment_sync_batches" TO app_platform;

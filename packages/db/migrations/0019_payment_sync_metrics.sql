CREATE TABLE "payment_sync_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"items" integer NOT NULL,
	"posted" integer DEFAULT 0 NOT NULL,
	"posted_needs_review" integer DEFAULT 0 NOT NULL,
	"duplicate" integer DEFAULT 0 NOT NULL,
	"rejected_validation" integer DEFAULT 0 NOT NULL,
	"rejected_customer_not_found" integer DEFAULT 0 NOT NULL,
	"rejected_id_reused" integer DEFAULT 0 NOT NULL,
	"rejected_without_id" integer DEFAULT 0 NOT NULL,
	"rejected_new_ids" integer DEFAULT 0 NOT NULL,
	"accepted_after_rejection" integer DEFAULT 0 NOT NULL,
	"retry_later_conflict" integer DEFAULT 0 NOT NULL,
	"retry_later_internal" integer DEFAULT 0 NOT NULL,
	"retry_later_rate_limited" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payment_sync_batches_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "payment_sync_batches_items_range" CHECK ("payment_sync_batches"."items" BETWEEN 1 AND 50),
	CONSTRAINT "payment_sync_batches_counts_not_negative" CHECK (LEAST("payment_sync_batches"."posted", "payment_sync_batches"."posted_needs_review", "payment_sync_batches"."duplicate", "payment_sync_batches"."rejected_validation",
        "payment_sync_batches"."rejected_customer_not_found", "payment_sync_batches"."rejected_id_reused", "payment_sync_batches"."rejected_without_id",
        "payment_sync_batches"."rejected_new_ids", "payment_sync_batches"."accepted_after_rejection", "payment_sync_batches"."retry_later_conflict",
        "payment_sync_batches"."retry_later_internal", "payment_sync_batches"."retry_later_rate_limited") >= 0),
	CONSTRAINT "payment_sync_batches_counts_add_up" CHECK ("payment_sync_batches"."items" = "payment_sync_batches"."posted" + "payment_sync_batches"."posted_needs_review" + "payment_sync_batches"."duplicate"
        + "payment_sync_batches"."rejected_validation" + "payment_sync_batches"."rejected_customer_not_found" + "payment_sync_batches"."rejected_id_reused"
        + "payment_sync_batches"."rejected_without_id" + "payment_sync_batches"."retry_later_conflict" + "payment_sync_batches"."retry_later_internal"
        + "payment_sync_batches"."retry_later_rate_limited"),
	CONSTRAINT "payment_sync_batches_new_ids_within_rejected" CHECK ("payment_sync_batches"."rejected_new_ids" <= "payment_sync_batches"."rejected_validation" + "payment_sync_batches"."rejected_customer_not_found" + "payment_sync_batches"."rejected_id_reused"),
	CONSTRAINT "payment_sync_batches_after_rejection_within_accepted" CHECK ("payment_sync_batches"."accepted_after_rejection" <= "payment_sync_batches"."posted" + "payment_sync_batches"."posted_needs_review")
);
--> statement-breakpoint
ALTER TABLE "payment_sync_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_sync_rejections" (
	"id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"code" text NOT NULL,
	"first_rejected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_sync_rejections_pkey" PRIMARY KEY("operator_id","id"),
	CONSTRAINT "payment_sync_rejections_code_known" CHECK ("payment_sync_rejections"."code" IN ('VALIDATION', 'CUSTOMER_NOT_FOUND', 'ID_REUSED_WITH_DIFFERENT_DATA'))
);
--> statement-breakpoint
ALTER TABLE "payment_sync_rejections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_sync_batches" ADD CONSTRAINT "payment_sync_batches_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_sync_rejections" ADD CONSTRAINT "payment_sync_rejections_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_sync_batches_date_idx" ON "payment_sync_batches" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "payment_sync_batches_operator_date_idx" ON "payment_sync_batches" USING btree ("operator_id","business_date");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_sync_batches" AS PERMISSIVE FOR ALL TO "app_rw" USING ("payment_sync_batches"."operator_id" = app.current_operator()) WITH CHECK ("payment_sync_batches"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "payment_sync_batches_platform_select" ON "payment_sync_batches" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_sync_rejections" AS PERMISSIVE FOR ALL TO "app_rw" USING ("payment_sync_rejections"."operator_id" = app.current_operator()) WITH CHECK ("payment_sync_rejections"."operator_id" = app.current_operator());
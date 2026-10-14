CREATE TABLE "subscription_offline_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"received_on" date NOT NULL,
	"months" integer NOT NULL,
	"paid_until" timestamp with time zone NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subscription_offline_payments_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "subscription_offline_payments_amount_positive" CHECK ("subscription_offline_payments"."amount_paise" > 0),
	CONSTRAINT "subscription_offline_payments_method_known" CHECK ("subscription_offline_payments"."method" IN ('bank_transfer', 'upi', 'cash', 'cheque')),
	CONSTRAINT "subscription_offline_payments_months_range" CHECK ("subscription_offline_payments"."months" BETWEEN 1 AND 12),
	CONSTRAINT "subscription_offline_payments_reference_length" CHECK ("subscription_offline_payments"."reference" IS NULL OR char_length("subscription_offline_payments"."reference") <= 100),
	CONSTRAINT "subscription_offline_payments_note_length" CHECK ("subscription_offline_payments"."note" IS NULL OR char_length("subscription_offline_payments"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "subscription_offline_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "support_access_grants_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "support_access_grants_reason_length" CHECK (coalesce(btrim("support_access_grants"."reason"), '') <> '' AND char_length(btrim("support_access_grants"."reason")) BETWEEN 10 AND 500),
	CONSTRAINT "support_access_grants_time_box" CHECK ("support_access_grants"."expires_at" > "support_access_grants"."granted_at"
        AND "support_access_grants"."expires_at" <= "support_access_grants"."granted_at" + interval '120 minutes'),
	CONSTRAINT "support_access_grants_ended_together" CHECK (("support_access_grants"."ended_at" IS NULL) = ("support_access_grants"."ended_by" IS NULL)),
	CONSTRAINT "support_access_grants_ended_after_grant" CHECK ("support_access_grants"."ended_at" IS NULL OR "support_access_grants"."ended_at" >= "support_access_grants"."granted_at")
);
--> statement-breakpoint
ALTER TABLE "support_access_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_offline_payments" ADD CONSTRAINT "subscription_offline_payments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_offline_payments" ADD CONSTRAINT "subscription_offline_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_offline_payments_operator_idx" ON "subscription_offline_payments" USING btree ("operator_id","recorded_at");--> statement-breakpoint
CREATE INDEX "support_access_grants_lookup_idx" ON "support_access_grants" USING btree ("operator_id","admin_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "support_access_grants_expires_idx" ON "support_access_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "billing_run_items_platform_select" ON "billing_run_items" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "billing_runs_platform_select" ON "billing_runs" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "collection_sessions_platform_select" ON "collection_sessions" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "customers_platform_select" ON "customers" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "invariant_checks_platform_select" ON "invariant_checks" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "receipt_actions_platform_select" ON "receipt_actions" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_offline_payments" AS PERMISSIVE FOR ALL TO "app_rw" USING ("subscription_offline_payments"."operator_id" = app.current_operator()) WITH CHECK ("subscription_offline_payments"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "subscription_offline_payments_platform_select" ON "subscription_offline_payments" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "support_access_grants" AS PERMISSIVE FOR ALL TO "app_rw" USING ("support_access_grants"."operator_id" = app.current_operator()) WITH CHECK ("support_access_grants"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "support_access_grants_platform_select" ON "support_access_grants" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);
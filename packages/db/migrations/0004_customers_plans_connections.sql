CREATE TYPE "public"."assignment_event_type" AS ENUM('activated', 'suspended', 'reactivated', 'disconnected', 'plan_changed');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('active', 'suspended', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."vc_lifecycle_status" AS ENUM('in_service', 'retired');--> statement-breakpoint
CREATE TYPE "public"."contact_change_source" AS ENUM('web', 'android', 'import');--> statement-breakpoint
CREATE TYPE "public"."contact_field" AS ENUM('phone', 'alt_phone');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TABLE "assignment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"type" "assignment_event_type" NOT NULL,
	"effective_date" date NOT NULL,
	"from_plan_id" uuid,
	"to_plan_id" uuid,
	"from_rental_paise" bigint,
	"to_rental_paise" bigint,
	"reason" text,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_events_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "assignment_events_plan_values" CHECK (CASE WHEN "assignment_events"."type" = 'plan_changed'
        THEN "assignment_events"."from_rental_paise" IS NOT NULL AND "assignment_events"."to_rental_paise" IS NOT NULL
        ELSE "assignment_events"."from_plan_id" IS NULL AND "assignment_events"."to_plan_id" IS NULL
          AND "assignment_events"."from_rental_paise" IS NULL AND "assignment_events"."to_rental_paise" IS NULL
        END),
	CONSTRAINT "assignment_events_rental_not_negative" CHECK ("assignment_events"."from_rental_paise" >= 0 AND "assignment_events"."to_rental_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "assignment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vc_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"vc_number" text NOT NULL,
	"vc_number_norm" text GENERATED ALWAYS AS (translate(regexp_replace("vc_number", '[- \t\n\r\f\v]+', '', 'g'), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')) STORED NOT NULL,
	"lifecycle_status" "vc_lifecycle_status" DEFAULT 'in_service' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "vc_assets_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "vc_assets_operator_number_unique" UNIQUE("operator_id","vc_number_norm"),
	CONSTRAINT "vc_assets_number_valid" CHECK ("vc_assets"."vc_number_norm" <> '' AND char_length("vc_assets"."vc_number_norm") <= 64),
	CONSTRAINT "vc_assets_legacy_both_or_neither" CHECK (("vc_assets"."legacy_source" IS NULL) = ("vc_assets"."legacy_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "vc_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vc_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"vc_asset_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" "assignment_status" DEFAULT 'active' NOT NULL,
	"plan_id" uuid,
	"rental_amount_paise" bigint NOT NULL,
	"history_limited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "vc_assignments_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "vc_assignments_end_not_before_start" CHECK ("vc_assignments"."end_date" IS NULL OR "vc_assignments"."end_date" >= "vc_assignments"."start_date"),
	CONSTRAINT "vc_assignments_end_iff_disconnected" CHECK (("vc_assignments"."status" = 'disconnected') = ("vc_assignments"."end_date" IS NOT NULL)),
	CONSTRAINT "vc_assignments_rental_not_negative" CHECK ("vc_assignments"."rental_amount_paise" >= 0),
	CONSTRAINT "vc_assignments_legacy_both_or_neither" CHECK (("vc_assignments"."legacy_source" IS NULL) = ("vc_assignments"."legacy_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "vc_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_contact_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"field" "contact_field" NOT NULL,
	"old_value" text,
	"new_value" text,
	"actor_id" uuid,
	"source" "contact_change_source" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_contact_changes_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "customer_contact_changes_changed" CHECK ("customer_contact_changes"."old_value" IS DISTINCT FROM "customer_contact_changes"."new_value"),
	CONSTRAINT "customer_contact_changes_actor_required" CHECK ("customer_contact_changes"."source" = 'import' OR "customer_contact_changes"."actor_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "customer_contact_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_code" text NOT NULL,
	"customer_code_norm" text GENERATED ALWAYS AS (translate(btrim(regexp_replace("customer_code", '[ \t\n\r\f\v]+', ' ', 'g'), ' '), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')) STORED NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"alt_phone" text,
	"address" text,
	"area_id" uuid,
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"kyc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "customers_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "customers_operator_code_unique" UNIQUE("operator_id","customer_code_norm"),
	CONSTRAINT "customers_code_valid" CHECK ("customers"."customer_code_norm" <> '' AND char_length("customers"."customer_code_norm") <= 64),
	CONSTRAINT "customers_name_not_blank" CHECK (btrim("customers"."name") <> ''),
	CONSTRAINT "customers_phone_format" CHECK ("customers"."phone" ~ '^\+?[0-9]{6,19}$'),
	CONSTRAINT "customers_alt_phone_format" CHECK ("customers"."alt_phone" ~ '^\+?[0-9]{6,19}$'),
	CONSTRAINT "customers_kyc_object" CHECK (jsonb_typeof("customers"."kyc") = 'object'),
	CONSTRAINT "customers_legacy_both_or_neither" CHECK (("customers"."legacy_source" IS NULL) = ("customers"."legacy_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"monthly_amount_paise" bigint NOT NULL,
	"status" "plan_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "plans_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "plans_name_not_blank" CHECK (btrim("plans"."name") <> ''),
	CONSTRAINT "plans_amount_not_negative" CHECK ("plans"."monthly_amount_paise" >= 0),
	CONSTRAINT "plans_legacy_both_or_neither" CHECK (("plans"."legacy_source" IS NULL) = ("plans"."legacy_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_assignment_fk" FOREIGN KEY ("operator_id","assignment_id") REFERENCES "public"."vc_assignments"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_from_plan_fk" FOREIGN KEY ("operator_id","from_plan_id") REFERENCES "public"."plans"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_to_plan_fk" FOREIGN KEY ("operator_id","to_plan_id") REFERENCES "public"."plans"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_actor_fk" FOREIGN KEY ("operator_id","actor_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vc_assets" ADD CONSTRAINT "vc_assets_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vc_assignments" ADD CONSTRAINT "vc_assignments_vc_asset_fk" FOREIGN KEY ("operator_id","vc_asset_id") REFERENCES "public"."vc_assets"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vc_assignments" ADD CONSTRAINT "vc_assignments_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vc_assignments" ADD CONSTRAINT "vc_assignments_plan_fk" FOREIGN KEY ("operator_id","plan_id") REFERENCES "public"."plans"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact_changes" ADD CONSTRAINT "customer_contact_changes_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact_changes" ADD CONSTRAINT "customer_contact_changes_actor_fk" FOREIGN KEY ("operator_id","actor_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_area_fk" FOREIGN KEY ("operator_id","area_id") REFERENCES "public"."areas"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_events_assignment_idx" ON "assignment_events" USING btree ("operator_id","assignment_id","at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_events_one_activation" ON "assignment_events" USING btree ("operator_id","assignment_id") WHERE "assignment_events"."type" = 'activated';--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_events_one_disconnection" ON "assignment_events" USING btree ("operator_id","assignment_id") WHERE "assignment_events"."type" = 'disconnected';--> statement-breakpoint
CREATE UNIQUE INDEX "vc_assets_operator_legacy_unique" ON "vc_assets" USING btree ("operator_id","legacy_source","legacy_id") WHERE "vc_assets"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vc_assets_number_prefix_idx" ON "vc_assets" USING btree ("operator_id","vc_number_norm" text_pattern_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "vc_assignments_operator_legacy_unique" ON "vc_assignments" USING btree ("operator_id","legacy_source","legacy_id") WHERE "vc_assignments"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vc_assignments_customer_idx" ON "vc_assignments" USING btree ("operator_id","customer_id");--> statement-breakpoint
CREATE INDEX "vc_assignments_vc_asset_idx" ON "vc_assignments" USING btree ("operator_id","vc_asset_id","start_date");--> statement-breakpoint
CREATE INDEX "vc_assignments_plan_idx" ON "vc_assignments" USING btree ("operator_id","plan_id");--> statement-breakpoint
CREATE INDEX "customer_contact_changes_customer_idx" ON "customer_contact_changes" USING btree ("operator_id","customer_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_operator_legacy_unique" ON "customers" USING btree ("operator_id","legacy_source","legacy_id") WHERE "customers"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_code_prefix_idx" ON "customers" USING btree ("operator_id","customer_code_norm" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("operator_id","phone" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "customers_alt_phone_idx" ON "customers" USING btree ("operator_id","alt_phone" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "customers_area_idx" ON "customers" USING btree ("operator_id","area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_operator_active_name_unique" ON "plans" USING btree ("operator_id",lower(btrim("name"))) WHERE "plans"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "plans_operator_legacy_unique" ON "plans" USING btree ("operator_id","legacy_source","legacy_id") WHERE "plans"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assignment_events" AS PERMISSIVE FOR ALL TO "app_rw" USING ("assignment_events"."operator_id" = app.current_operator()) WITH CHECK ("assignment_events"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "vc_assets" AS PERMISSIVE FOR ALL TO "app_rw" USING ("vc_assets"."operator_id" = app.current_operator()) WITH CHECK ("vc_assets"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "vc_assignments" AS PERMISSIVE FOR ALL TO "app_rw" USING ("vc_assignments"."operator_id" = app.current_operator()) WITH CHECK ("vc_assignments"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_contact_changes" AS PERMISSIVE FOR ALL TO "app_rw" USING ("customer_contact_changes"."operator_id" = app.current_operator()) WITH CHECK ("customer_contact_changes"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customers" AS PERMISSIVE FOR ALL TO "app_rw" USING ("customers"."operator_id" = app.current_operator()) WITH CHECK ("customers"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "plans" AS PERMISSIVE FOR ALL TO "app_rw" USING ("plans"."operator_id" = app.current_operator()) WITH CHECK ("plans"."operator_id" = app.current_operator());
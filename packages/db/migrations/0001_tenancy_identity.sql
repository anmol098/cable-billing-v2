CREATE TYPE "public"."refresh_token_revoke_reason" AS ENUM('logout', 'reuse_detected', 'device_revoked', 'user_disabled', 'password_changed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'staff', 'lineman', 'platform_admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."counter_name" AS ENUM('invoice', 'receipt', 'customer_code');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'grace', 'read_only', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."language" AS ENUM('hi', 'en');--> statement-breakpoint
CREATE TYPE "public"."operator_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"actor_id" uuid,
	"actor_role" "user_role",
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"user_agent" text,
	"request_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_consistent" CHECK (("audit_events"."actor_id" IS NULL) = ("audit_events"."actor_role" IS NULL)),
	CONSTRAINT "audit_events_action_format" CHECK ("audit_events"."action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
	CONSTRAINT "audit_events_entity_type_format" CHECK ("audit_events"."entity_type" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_account_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"device_code" text NOT NULL,
	"model" text,
	"os_version" text,
	"app_version" text,
	"app_version_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "devices_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "devices_operator_install_unique" UNIQUE("operator_id","install_id"),
	CONSTRAINT "devices_operator_code_unique" UNIQUE("operator_id","device_code"),
	CONSTRAINT "devices_code_format" CHECK ("devices"."device_code" ~ '^[A-Z0-9]{3}$'),
	CONSTRAINT "devices_revoked_by_needs_revoked_at" CHECK ("devices"."revoked_by" IS NULL OR "devices"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mobile_refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"parent_id" uuid,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "refresh_token_revoke_reason",
	CONSTRAINT "mobile_refresh_tokens_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "mobile_refresh_tokens_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "mobile_refresh_tokens_hash_format" CHECK ("mobile_refresh_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mobile_refresh_tokens_revoked_consistent" CHECK (("mobile_refresh_tokens"."revoked_at" IS NULL) = ("mobile_refresh_tokens"."revoked_reason" IS NULL)),
	CONSTRAINT "mobile_refresh_tokens_expiry_after_creation" CHECK ("mobile_refresh_tokens"."expires_at" > "mobile_refresh_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "two_factors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"role" "user_role" NOT NULL,
	"name" text NOT NULL,
	"login" text NOT NULL,
	"display_login" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone" text,
	"language" "language" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "users_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "users_login_unique" UNIQUE("login"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_operator_matches_role" CHECK (("users"."role" = 'platform_admin') = ("users"."operator_id" IS NULL)),
	CONSTRAINT "users_login_normalized" CHECK ("users"."login" = lower("users"."login") AND "users"."login" !~ '[[:space:]]' AND char_length("users"."login") BETWEEN 3 AND 100),
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_platform_admin_has_email" CHECK ("users"."role" <> 'platform_admin' OR "users"."email" IS NOT NULL),
	CONSTRAINT "users_name_not_blank" CHECK (btrim("users"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "counters" (
	"operator_id" uuid NOT NULL,
	"name" "counter_name" NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "counters_pkey" PRIMARY KEY("operator_id","name"),
	CONSTRAINT "counters_next_value_positive" CHECK ("counters"."next_value" >= 1)
);
--> statement-breakpoint
ALTER TABLE "counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"razorpay_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	CONSTRAINT "subscription_events_razorpay_event_unique" UNIQUE("razorpay_event_id")
);
--> statement-breakpoint
ALTER TABLE "subscription_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"operator_id" uuid PRIMARY KEY NOT NULL,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"razorpay_customer_id" text,
	"razorpay_subscription_id" text,
	"plan_code" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_razorpay_subscription_unique" UNIQUE("razorpay_subscription_id"),
	CONSTRAINT "subscriptions_trial_has_end" CHECK ("subscriptions"."status" <> 'trialing' OR "subscriptions"."trial_ends_at" IS NOT NULL),
	CONSTRAINT "subscriptions_grace_has_end" CHECK ("subscriptions"."status" <> 'grace' OR "subscriptions"."grace_ends_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "areas_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "areas_name_not_blank" CHECK (btrim("areas"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"address" text,
	"settings" jsonb DEFAULT '{"mid_month_start_policy":"start_next_month","invoice_prefix":"INV","receipt_footer":null,"office_phone":null,"default_language":"hi"}'::jsonb NOT NULL,
	"status" "operator_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "operators_name_not_blank" CHECK (btrim("operators"."name") <> ''),
	CONSTRAINT "operators_settings_valid" CHECK (jsonb_typeof("operators"."settings") = 'object'
        AND ("operators"."settings" ->> 'mid_month_start_policy') IN ('charge_full_month', 'start_next_month')
        AND ("operators"."settings" ->> 'default_language') IN ('hi', 'en'))
);
--> statement-breakpoint
ALTER TABLE "operators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_fk" FOREIGN KEY ("operator_id","user_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_fk" FOREIGN KEY ("operator_id","revoked_by") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ADD CONSTRAINT "mobile_refresh_tokens_user_fk" FOREIGN KEY ("operator_id","user_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ADD CONSTRAINT "mobile_refresh_tokens_device_fk" FOREIGN KEY ("operator_id","device_id") REFERENCES "public"."devices"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ADD CONSTRAINT "mobile_refresh_tokens_parent_fk" FOREIGN KEY ("operator_id","parent_id") REFERENCES "public"."mobile_refresh_tokens"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_operator_at_idx" ON "audit_events" USING btree ("operator_id","at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_operator_entity_idx" ON "audit_events" USING btree ("operator_id","entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_operator_actor_idx" ON "audit_events" USING btree ("operator_id","actor_id","at");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_operator_user_idx" ON "devices" USING btree ("operator_id","user_id");--> statement-breakpoint
CREATE INDEX "mobile_refresh_tokens_family_idx" ON "mobile_refresh_tokens" USING btree ("operator_id","family_id");--> statement-breakpoint
CREATE INDEX "mobile_refresh_tokens_device_idx" ON "mobile_refresh_tokens" USING btree ("operator_id","device_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factors_user_id_idx" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "areas_operator_name_unique" ON "areas" USING btree ("operator_id",lower("name"));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_events" AS PERMISSIVE FOR ALL TO "app_rw" USING ("audit_events"."operator_id" = app.current_operator()) WITH CHECK ("audit_events"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "audit_events_platform_select" ON "audit_events" AS PERMISSIVE FOR SELECT TO "app_platform" USING ("audit_events"."operator_id" IS NULL);--> statement-breakpoint
CREATE POLICY "audit_events_platform_insert" ON "audit_events" AS PERMISSIVE FOR INSERT TO "app_platform" WITH CHECK ("audit_events"."operator_id" IS NULL);--> statement-breakpoint
CREATE POLICY "accounts_tenant" ON "accounts" AS PERMISSIVE FOR ALL TO "app_rw" USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = accounts.user_id AND u.operator_id = app.current_operator())) WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = accounts.user_id AND u.operator_id = app.current_operator()));--> statement-breakpoint
CREATE POLICY "accounts_platform" ON "accounts" AS PERMISSIVE FOR ALL TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "devices" AS PERMISSIVE FOR ALL TO "app_rw" USING ("devices"."operator_id" = app.current_operator()) WITH CHECK ("devices"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mobile_refresh_tokens" AS PERMISSIVE FOR ALL TO "app_rw" USING ("mobile_refresh_tokens"."operator_id" = app.current_operator()) WITH CHECK ("mobile_refresh_tokens"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "mobile_refresh_tokens_platform_select" ON "mobile_refresh_tokens" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "sessions_tenant" ON "sessions" AS PERMISSIVE FOR ALL TO "app_rw" USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = sessions.user_id AND u.operator_id = app.current_operator())) WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = sessions.user_id AND u.operator_id = app.current_operator()));--> statement-breakpoint
CREATE POLICY "sessions_platform" ON "sessions" AS PERMISSIVE FOR ALL TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "two_factors_platform" ON "two_factors" AS PERMISSIVE FOR ALL TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO "app_rw" USING ("users"."operator_id" = app.current_operator()) WITH CHECK ("users"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "users_platform_select" ON "users" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "users_platform_insert" ON "users" AS PERMISSIVE FOR INSERT TO "app_platform" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "users_platform_update" ON "users" AS PERMISSIVE FOR UPDATE TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "verifications_platform" ON "verifications" AS PERMISSIVE FOR ALL TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "counters" AS PERMISSIVE FOR ALL TO "app_rw" USING ("counters"."operator_id" = app.current_operator()) WITH CHECK ("counters"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_events" AS PERMISSIVE FOR ALL TO "app_rw" USING ("subscription_events"."operator_id" = app.current_operator()) WITH CHECK ("subscription_events"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "subscription_events_platform_select" ON "subscription_events" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "subscription_events_platform_insert" ON "subscription_events" AS PERMISSIVE FOR INSERT TO "app_platform" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "subscription_events_platform_update" ON "subscription_events" AS PERMISSIVE FOR UPDATE TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscriptions" AS PERMISSIVE FOR ALL TO "app_rw" USING ("subscriptions"."operator_id" = app.current_operator()) WITH CHECK ("subscriptions"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "subscriptions_platform_select" ON "subscriptions" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "subscriptions_platform_update" ON "subscriptions" AS PERMISSIVE FOR UPDATE TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "areas" AS PERMISSIVE FOR ALL TO "app_rw" USING ("areas"."operator_id" = app.current_operator()) WITH CHECK ("areas"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "operators_tenant_select" ON "operators" AS PERMISSIVE FOR SELECT TO "app_rw" USING ("operators"."id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "operators_tenant_insert" ON "operators" AS PERMISSIVE FOR INSERT TO "app_rw" WITH CHECK ("operators"."id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "operators_tenant_update" ON "operators" AS PERMISSIVE FOR UPDATE TO "app_rw" USING ("operators"."id" = app.current_operator()) WITH CHECK ("operators"."id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "operators_platform_select" ON "operators" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);
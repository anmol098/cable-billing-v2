CREATE TYPE "public"."invariant_check_status" AS ENUM('ok', 'breach');--> statement-breakpoint
CREATE TABLE "invariant_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"status" "invariant_check_status" NOT NULL,
	"violation_count" integer NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invariant_checks_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "invariant_checks_one_per_run" UNIQUE("operator_id","run_id"),
	CONSTRAINT "invariant_checks_violation_count_not_negative" CHECK ("invariant_checks"."violation_count" >= 0),
	CONSTRAINT "invariant_checks_status_matches_count" CHECK (("invariant_checks"."status" = 'ok') = ("invariant_checks"."violation_count" = 0)),
	CONSTRAINT "invariant_checks_counts_object" CHECK (jsonb_typeof("invariant_checks"."counts") = 'object'),
	CONSTRAINT "invariant_checks_samples_array" CHECK (jsonb_typeof("invariant_checks"."samples") = 'array'),
	CONSTRAINT "invariant_checks_duration_not_negative" CHECK ("invariant_checks"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "invariant_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invariant_checks" ADD CONSTRAINT "invariant_checks_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invariant_checks_checked_at_idx" ON "invariant_checks" USING btree ("operator_id","checked_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invariant_checks" AS PERMISSIVE FOR ALL TO "app_rw" USING ("invariant_checks"."operator_id" = app.current_operator()) WITH CHECK ("invariant_checks"."operator_id" = app.current_operator());
CREATE TABLE "roster_versions" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"change_xid" "xid8" NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "roster_versions_operator_customer_unique" UNIQUE("operator_id","customer_id")
);
--> statement-breakpoint
ALTER TABLE "roster_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roster_versions" ADD CONSTRAINT "roster_versions_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_versions_sync_idx" ON "roster_versions" USING btree ("operator_id","change_xid","customer_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "roster_versions" AS PERMISSIVE FOR ALL TO "app_rw" USING ("roster_versions"."operator_id" = app.current_operator()) WITH CHECK ("roster_versions"."operator_id" = app.current_operator());
CREATE TYPE "public"."handover_event_type" AS ENUM('submitted', 'accepted', 'returned');--> statement-breakpoint
CREATE TABLE "handover_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"type" "handover_event_type" NOT NULL,
	"submission_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"cash_expected_paise" bigint,
	"cash_handed_over_paise" bigint,
	"discrepancy_paise" bigint,
	"discrepancy_reason" "discrepancy_reason",
	"unsynced_payment_count" integer,
	"unsynced_cash_paise" bigint,
	"note" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handover_events_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "handover_events_snapshot_iff_submitted" CHECK (CASE WHEN "handover_events"."type" = 'submitted'
        THEN "handover_events"."cash_expected_paise" IS NOT NULL AND "handover_events"."cash_handed_over_paise" IS NOT NULL
          AND "handover_events"."discrepancy_paise" IS NOT NULL AND "handover_events"."unsynced_payment_count" IS NOT NULL
          AND "handover_events"."unsynced_cash_paise" IS NOT NULL
        ELSE "handover_events"."cash_expected_paise" IS NULL AND "handover_events"."cash_handed_over_paise" IS NULL
          AND "handover_events"."discrepancy_paise" IS NULL AND "handover_events"."discrepancy_reason" IS NULL
          AND "handover_events"."unsynced_payment_count" IS NULL AND "handover_events"."unsynced_cash_paise" IS NULL
        END),
	CONSTRAINT "handover_events_amounts_not_negative" CHECK ("handover_events"."cash_expected_paise" >= 0 AND "handover_events"."cash_handed_over_paise" >= 0
        AND "handover_events"."unsynced_payment_count" >= 0 AND "handover_events"."unsynced_cash_paise" >= 0),
	CONSTRAINT "handover_events_discrepancy_computed" CHECK ("handover_events"."discrepancy_paise" = "handover_events"."cash_handed_over_paise" - "handover_events"."cash_expected_paise"),
	CONSTRAINT "handover_events_discrepancy_needs_reason" CHECK ("handover_events"."discrepancy_paise" IS NULL OR "handover_events"."discrepancy_paise" = 0 OR "handover_events"."discrepancy_reason" IS NOT NULL),
	CONSTRAINT "handover_events_returned_needs_note" CHECK ("handover_events"."type" <> 'returned' OR coalesce(btrim("handover_events"."note"), '') <> ''),
	CONSTRAINT "handover_events_note_not_blank" CHECK ("handover_events"."note" IS NULL OR coalesce(btrim("handover_events"."note"), '') <> '')
);
--> statement-breakpoint
ALTER TABLE "handover_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "handover_events" ADD CONSTRAINT "handover_events_session_fk" FOREIGN KEY ("operator_id","session_id") REFERENCES "public"."collection_sessions"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_events" ADD CONSTRAINT "handover_events_actor_fk" FOREIGN KEY ("operator_id","actor_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handover_events_submission_unique" ON "handover_events" USING btree ("operator_id","submission_id") WHERE "handover_events"."type" = 'submitted';--> statement-breakpoint
CREATE UNIQUE INDEX "handover_events_one_decision" ON "handover_events" USING btree ("operator_id","submission_id") WHERE "handover_events"."type" <> 'submitted';--> statement-breakpoint
CREATE INDEX "handover_events_session_idx" ON "handover_events" USING btree ("operator_id","session_id","at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "handover_events" AS PERMISSIVE FOR ALL TO "app_rw" USING ("handover_events"."operator_id" = app.current_operator()) WITH CHECK ("handover_events"."operator_id" = app.current_operator());
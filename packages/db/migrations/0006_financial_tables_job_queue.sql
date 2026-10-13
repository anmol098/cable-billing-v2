CREATE TYPE "public"."adjustment_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."adjustment_source" AS ENUM('plan_change', 'mid_month_start', 'manual', 'migration');--> statement-breakpoint
CREATE TYPE "public"."billing_run_item_outcome" AS ENUM('created', 'already_exists', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."billing_run_skip_reason" AS ENUM('tenant_read_only');--> statement-breakpoint
CREATE TYPE "public"."billing_run_status" AS ENUM('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."billing_run_trigger" AS ENUM('cron', 'manual', 'catch_up');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('regular', 'opening_balance');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_type" AS ENUM('rent', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('issued', 'void');--> statement-breakpoint
CREATE TYPE "public"."collection_session_status" AS ENUM('open', 'submitted', 'accepted', 'returned');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_reason" AS ENUM('short', 'extra', 'pending_sync', 'other');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."allocation_kind" AS ENUM('posting', 'credit_application', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."allocation_source_type" AS ENUM('credit_adjustment', 'payment');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('invoice', 'opening_balance', 'debit_adjustment', 'credit_adjustment', 'payment', 'payment_reversal');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'upi');--> statement-breakpoint
CREATE TYPE "public"."payment_review_reason" AS ENUM('customer_inactive', 'collector_inactive', 'collector_mismatch', 'device_mismatch', 'recorded_at_out_of_range', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_review_status" AS ENUM('none', 'needs_review', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."payment_source" AS ENUM('android', 'web', 'migration');--> statement-breakpoint
CREATE TYPE "public"."upi_verification" AS ENUM('unverified');--> statement-breakpoint
CREATE TYPE "public"."receipt_action" AS ENUM('printed', 'print_failed', 'whatsapp_opened', 'sms_opened', 'pdf_shared');--> statement-breakpoint
CREATE TABLE "adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"assignment_id" uuid,
	"period" date,
	"direction" "adjustment_direction" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"source" "adjustment_source" NOT NULL,
	"reason" text,
	"invoice_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "adjustments_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "adjustments_operator_customer_id_unique" UNIQUE("operator_id","customer_id","id"),
	CONSTRAINT "adjustments_operator_id_invoice_unique" UNIQUE("operator_id","id","invoice_id"),
	CONSTRAINT "adjustments_period_first_day" CHECK (extract(day from "adjustments"."period") = 1),
	CONSTRAINT "adjustments_amount_positive" CHECK ("adjustments"."amount_paise" > 0),
	CONSTRAINT "adjustments_only_debits_invoiced" CHECK ("adjustments"."invoice_id" IS NULL OR "adjustments"."direction" = 'debit'),
	CONSTRAINT "adjustments_rental_sources_name_connection" CHECK ("adjustments"."source" NOT IN ('plan_change', 'mid_month_start')
        OR ("adjustments"."assignment_id" IS NOT NULL AND "adjustments"."period" IS NOT NULL)),
	CONSTRAINT "adjustments_mid_month_start_is_debit" CHECK ("adjustments"."source" <> 'mid_month_start' OR "adjustments"."direction" = 'debit'),
	CONSTRAINT "adjustments_manual_has_reason_and_author" CHECK ("adjustments"."source" <> 'manual' OR (coalesce(btrim("adjustments"."reason"), '') <> '' AND "adjustments"."created_by" IS NOT NULL)),
	CONSTRAINT "adjustments_legacy_both_or_neither" CHECK (("adjustments"."legacy_source" IS NULL) = ("adjustments"."legacy_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_run_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"outcome" "billing_run_item_outcome" NOT NULL,
	"invoice_id" uuid,
	"reason" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_run_items_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "billing_run_items_run_customer_unique" UNIQUE("operator_id","run_id","customer_id"),
	CONSTRAINT "billing_run_items_invoice_iff_billed" CHECK (("billing_run_items"."outcome" IN ('created', 'already_exists')) = ("billing_run_items"."invoice_id" IS NOT NULL)),
	CONSTRAINT "billing_run_items_reason_when_not_billed" CHECK ("billing_run_items"."outcome" IN ('created', 'already_exists') OR coalesce(btrim("billing_run_items"."reason"), '') <> ''),
	CONSTRAINT "billing_run_items_details_object" CHECK (jsonb_typeof("billing_run_items"."details") = 'object'),
	CONSTRAINT "billing_run_items_attempts_positive" CHECK ("billing_run_items"."attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "billing_run_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"period" date NOT NULL,
	"trigger" "billing_run_trigger" NOT NULL,
	"status" "billing_run_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" "billing_run_skip_reason",
	"customer_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"already_exists_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"total_charges_paise" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_runs_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "billing_runs_operator_period_unique" UNIQUE("operator_id","period"),
	CONSTRAINT "billing_runs_period_first_day" CHECK (extract(day from "billing_runs"."period") = 1),
	CONSTRAINT "billing_runs_skip_reason_iff_skipped" CHECK (("billing_runs"."status" = 'skipped') = ("billing_runs"."skip_reason" IS NOT NULL)),
	CONSTRAINT "billing_runs_finished_iff_done" CHECK (("billing_runs"."status" IN ('pending', 'running')) = ("billing_runs"."finished_at" IS NULL)),
	CONSTRAINT "billing_runs_manual_has_actor" CHECK ("billing_runs"."trigger" <> 'manual' OR "billing_runs"."actor_id" IS NOT NULL),
	CONSTRAINT "billing_runs_counts_not_negative" CHECK ("billing_runs"."customer_count" >= 0 AND "billing_runs"."created_count" >= 0 AND "billing_runs"."already_exists_count" >= 0
        AND "billing_runs"."skipped_count" >= 0 AND "billing_runs"."failed_count" >= 0 AND "billing_runs"."total_charges_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"type" "invoice_line_type" NOT NULL,
	"assignment_id" uuid,
	"adjustment_id" uuid,
	"description" text,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "invoice_lines_shape" CHECK (CASE WHEN "invoice_lines"."type" = 'rent'
        THEN "invoice_lines"."assignment_id" IS NOT NULL AND "invoice_lines"."adjustment_id" IS NULL AND "invoice_lines"."amount_paise" >= 0
        ELSE "invoice_lines"."adjustment_id" IS NOT NULL AND "invoice_lines"."amount_paise" > 0
        END)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"period" date NOT NULL,
	"invoice_number" text NOT NULL,
	"kind" "invoice_kind" DEFAULT 'regular' NOT NULL,
	"opening_balance_paise" bigint NOT NULL,
	"charges_paise" bigint NOT NULL,
	"total_due_paise" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "invoice_status" DEFAULT 'issued' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "invoices_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "invoices_operator_customer_id_unique" UNIQUE("operator_id","customer_id","id"),
	CONSTRAINT "invoices_operator_number_unique" UNIQUE("operator_id","invoice_number"),
	CONSTRAINT "invoices_period_first_day" CHECK (extract(day from "invoices"."period") = 1),
	CONSTRAINT "invoices_number_not_blank" CHECK (btrim("invoices"."invoice_number") <> ''),
	CONSTRAINT "invoices_charges_not_negative" CHECK ("invoices"."charges_paise" >= 0),
	CONSTRAINT "invoices_total_due_is_opening_plus_charges" CHECK ("invoices"."total_due_paise" = "invoices"."opening_balance_paise" + "invoices"."charges_paise"),
	CONSTRAINT "invoices_void_metadata" CHECK (CASE WHEN "invoices"."status" = 'void'
        THEN "invoices"."voided_at" IS NOT NULL AND "invoices"."voided_by" IS NOT NULL AND coalesce(btrim("invoices"."void_reason"), '') <> ''
        ELSE "invoices"."voided_at" IS NULL AND "invoices"."voided_by" IS NULL AND "invoices"."void_reason" IS NULL
        END),
	CONSTRAINT "invoices_legacy_both_or_neither" CHECK (("invoices"."legacy_source" IS NULL) = ("invoices"."legacy_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "collection_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"collector_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"cash_expected_paise" bigint DEFAULT 0 NOT NULL,
	"upi_total_paise" bigint DEFAULT 0 NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"status" "collection_session_status" DEFAULT 'open' NOT NULL,
	"handover_submission_id" uuid,
	"handover_cash_expected_paise" bigint,
	"cash_handed_over_paise" bigint,
	"discrepancy_paise" bigint,
	"discrepancy_reason" "discrepancy_reason",
	"handover_note" text,
	"unsynced_payment_count" integer,
	"unsynced_cash_paise" bigint,
	"submitted_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_sessions_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "collection_sessions_collector_day_unique" UNIQUE("operator_id","collector_id","business_date"),
	CONSTRAINT "collection_sessions_totals_not_negative" CHECK ("collection_sessions"."cash_expected_paise" >= 0 AND "collection_sessions"."upi_total_paise" >= 0 AND "collection_sessions"."payment_count" >= 0),
	CONSTRAINT "collection_sessions_handover_iff_submitted" CHECK (CASE WHEN "collection_sessions"."status" = 'open'
        THEN "collection_sessions"."handover_submission_id" IS NULL AND "collection_sessions"."handover_cash_expected_paise" IS NULL
          AND "collection_sessions"."cash_handed_over_paise" IS NULL AND "collection_sessions"."discrepancy_paise" IS NULL
          AND "collection_sessions"."discrepancy_reason" IS NULL AND "collection_sessions"."handover_note" IS NULL
          AND "collection_sessions"."unsynced_payment_count" IS NULL AND "collection_sessions"."unsynced_cash_paise" IS NULL
          AND "collection_sessions"."submitted_at" IS NULL
        ELSE "collection_sessions"."handover_submission_id" IS NOT NULL AND "collection_sessions"."handover_cash_expected_paise" IS NOT NULL
          AND "collection_sessions"."cash_handed_over_paise" IS NOT NULL AND "collection_sessions"."discrepancy_paise" IS NOT NULL
          AND "collection_sessions"."unsynced_payment_count" IS NOT NULL AND "collection_sessions"."unsynced_cash_paise" IS NOT NULL
          AND "collection_sessions"."submitted_at" IS NOT NULL
        END),
	CONSTRAINT "collection_sessions_handover_amounts" CHECK ("collection_sessions"."handover_cash_expected_paise" >= 0 AND "collection_sessions"."cash_handed_over_paise" >= 0
        AND "collection_sessions"."unsynced_payment_count" >= 0 AND "collection_sessions"."unsynced_cash_paise" >= 0),
	CONSTRAINT "collection_sessions_discrepancy_computed" CHECK ("collection_sessions"."discrepancy_paise" = "collection_sessions"."cash_handed_over_paise" - "collection_sessions"."handover_cash_expected_paise"),
	CONSTRAINT "collection_sessions_discrepancy_needs_reason" CHECK ("collection_sessions"."discrepancy_paise" IS NULL OR "collection_sessions"."discrepancy_paise" = 0 OR "collection_sessions"."discrepancy_reason" IS NOT NULL),
	CONSTRAINT "collection_sessions_review" CHECK (CASE WHEN "collection_sessions"."status" IN ('accepted', 'returned')
        THEN "collection_sessions"."reviewed_by" IS NOT NULL AND "collection_sessions"."reviewed_at" IS NOT NULL
          AND ("collection_sessions"."status" = 'accepted' OR coalesce(btrim("collection_sessions"."review_note"), '') <> '')
        ELSE "collection_sessions"."reviewed_by" IS NULL AND "collection_sessions"."reviewed_at" IS NULL AND "collection_sessions"."review_note" IS NULL
        END)
);
--> statement-breakpoint
ALTER TABLE "collection_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_type_format" CHECK ("jobs"."type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
	CONSTRAINT "jobs_payload_object" CHECK (jsonb_typeof("jobs"."payload") = 'object'),
	CONSTRAINT "jobs_attempts_range" CHECK ("jobs"."max_attempts" >= 1 AND "jobs"."attempts" >= 0 AND "jobs"."attempts" <= "jobs"."max_attempts"),
	CONSTRAINT "jobs_running_has_lease" CHECK ("jobs"."status" <> 'running' OR "jobs"."locked_until" IS NOT NULL),
	CONSTRAINT "jobs_finished_iff_done" CHECK (("jobs"."status" IN ('succeeded', 'failed')) = ("jobs"."finished_at" IS NOT NULL)),
	CONSTRAINT "jobs_dedupe_key_not_blank" CHECK ("jobs"."dedupe_key" IS NULL OR btrim("jobs"."dedupe_key") <> '')
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"source_type" "allocation_source_type" NOT NULL,
	"payment_id" uuid,
	"credit_adjustment_id" uuid,
	"source_id" uuid GENERATED ALWAYS AS (coalesce("payment_id", "credit_adjustment_id")) STORED NOT NULL,
	"kind" "allocation_kind" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"outstanding_after_paise" bigint NOT NULL,
	"reversal_id" uuid,
	"reverses_allocation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocations_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "allocations_operator_invoice_payment_id_unique" UNIQUE("operator_id","invoice_id","payment_id","id"),
	CONSTRAINT "allocations_one_source" CHECK (CASE WHEN "allocations"."source_type" = 'payment'
        THEN "allocations"."payment_id" IS NOT NULL AND "allocations"."credit_adjustment_id" IS NULL
        ELSE "allocations"."credit_adjustment_id" IS NOT NULL AND "allocations"."payment_id" IS NULL
        END),
	CONSTRAINT "allocations_amount_not_zero" CHECK ("allocations"."amount_paise" <> 0),
	CONSTRAINT "allocations_reversal_shape" CHECK (CASE WHEN "allocations"."kind" = 'reversal'
        THEN "allocations"."amount_paise" < 0 AND "allocations"."source_type" = 'payment'
          AND "allocations"."reversal_id" IS NOT NULL AND "allocations"."reverses_allocation_id" IS NOT NULL
        ELSE "allocations"."amount_paise" > 0 AND "allocations"."reversal_id" IS NULL AND "allocations"."reverses_allocation_id" IS NULL
        END),
	CONSTRAINT "allocations_posting_is_payment" CHECK ("allocations"."kind" <> 'posting' OR "allocations"."source_type" = 'payment'),
	CONSTRAINT "allocations_outstanding_after_not_negative" CHECK ("allocations"."outstanding_after_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_balances" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"balance_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"oldest_due_period" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_balances_operator_customer_unique" UNIQUE("operator_id","customer_id"),
	CONSTRAINT "customer_balances_credit_not_negative" CHECK ("customer_balances"."credit_paise" >= 0),
	CONSTRAINT "customer_balances_oldest_due_first_day" CHECK (extract(day from "customer_balances"."oldest_due_period") = 1)
);
--> statement-breakpoint
ALTER TABLE "customer_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" "ledger_entry_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"invoice_id" uuid,
	"adjustment_id" uuid,
	"payment_id" uuid,
	"payment_reversal_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "ledger_entries_reference_and_sign" CHECK (CASE "ledger_entries"."type"
        WHEN 'invoice' THEN "ledger_entries"."invoice_id" IS NOT NULL AND "ledger_entries"."amount_paise" >= 0
        WHEN 'opening_balance' THEN "ledger_entries"."invoice_id" IS NOT NULL AND "ledger_entries"."amount_paise" >= 0
        WHEN 'debit_adjustment' THEN "ledger_entries"."adjustment_id" IS NOT NULL AND "ledger_entries"."amount_paise" > 0
        WHEN 'credit_adjustment' THEN "ledger_entries"."adjustment_id" IS NOT NULL AND "ledger_entries"."amount_paise" < 0
        WHEN 'payment' THEN "ledger_entries"."payment_id" IS NOT NULL AND "ledger_entries"."amount_paise" < 0
        WHEN 'payment_reversal' THEN "ledger_entries"."payment_reversal_id" IS NOT NULL AND "ledger_entries"."amount_paise" > 0
        END),
	CONSTRAINT "ledger_entries_one_reference" CHECK (num_nonnulls("ledger_entries"."invoice_id", "ledger_entries"."adjustment_id", "ledger_entries"."payment_id", "ledger_entries"."payment_reversal_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_reversals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reversals_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "payment_reversals_payment_unique" UNIQUE("operator_id","payment_id"),
	CONSTRAINT "payment_reversals_operator_customer_id_unique" UNIQUE("operator_id","customer_id","id"),
	CONSTRAINT "payment_reversals_operator_payment_id_unique" UNIQUE("operator_id","payment_id","id"),
	CONSTRAINT "payment_reversals_reason_not_blank" CHECK (coalesce(btrim("payment_reversals"."reason"), '') <> '')
);
--> statement-breakpoint
ALTER TABLE "payment_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"upi_reference" text,
	"upi_verification" "upi_verification" DEFAULT 'unverified' NOT NULL,
	"notes" text,
	"collector_id" uuid,
	"device_id" uuid,
	"source" "payment_source" NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_date" date NOT NULL,
	"balance_after_paise" bigint,
	"credit_after_paise" bigint,
	"review_status" "payment_review_status" DEFAULT 'none' NOT NULL,
	"review_reason" "payment_review_reason",
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "payments_pkey" PRIMARY KEY("operator_id","id"),
	CONSTRAINT "payments_operator_customer_id_unique" UNIQUE("operator_id","customer_id","id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_paise" > 0),
	CONSTRAINT "payments_upi_reference_only_upi" CHECK ("payments"."upi_reference" IS NULL OR ("payments"."method" = 'upi' AND coalesce(btrim("payments"."upi_reference"), '') <> '')),
	CONSTRAINT "payments_collector_required" CHECK ("payments"."source" = 'migration' OR "payments"."collector_id" IS NOT NULL),
	CONSTRAINT "payments_device_only_android" CHECK (("payments"."source" = 'android') = ("payments"."device_id" IS NOT NULL)),
	CONSTRAINT "payments_snapshots_required" CHECK ("payments"."source" = 'migration'
        OR ("payments"."balance_after_paise" IS NOT NULL AND "payments"."credit_after_paise" IS NOT NULL)),
	CONSTRAINT "payments_credit_after_not_negative" CHECK ("payments"."credit_after_paise" >= 0),
	CONSTRAINT "payments_review_reason_iff_flagged" CHECK (("payments"."review_status" = 'none') = ("payments"."review_reason" IS NULL)),
	CONSTRAINT "payments_review_resolution" CHECK (CASE WHEN "payments"."review_status" = 'resolved'
        THEN "payments"."reviewed_by" IS NOT NULL AND "payments"."reviewed_at" IS NOT NULL
        ELSE "payments"."reviewed_by" IS NULL AND "payments"."reviewed_at" IS NULL AND "payments"."review_note" IS NULL
        END),
	CONSTRAINT "payments_legacy_both_or_neither" CHECK (("payments"."legacy_source" IS NULL) = ("payments"."legacy_id" IS NULL)),
	CONSTRAINT "payments_legacy_only_migration" CHECK ("payments"."legacy_id" IS NULL OR "payments"."source" = 'migration')
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "receipt_actions" (
	"id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"action" "receipt_action" NOT NULL,
	"device_id" uuid,
	"actor_id" uuid,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_actions_pkey" PRIMARY KEY("operator_id","id")
);
--> statement-breakpoint
ALTER TABLE "receipt_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "receipt_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_access_at" timestamp with time zone,
	CONSTRAINT "receipt_links_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "receipt_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "receipt_links_token_hash_format" CHECK ("receipt_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "receipt_links_expires_after_created" CHECK ("receipt_links"."expires_at" > "receipt_links"."created_at"),
	CONSTRAINT "receipt_links_revoked_by_needs_revoked_at" CHECK ("receipt_links"."revoked_by" IS NULL OR "receipt_links"."revoked_at" IS NOT NULL),
	CONSTRAINT "receipt_links_access_count_not_negative" CHECK ("receipt_links"."access_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "receipt_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"provisional_ref" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	CONSTRAINT "receipts_operator_id_id_unique" UNIQUE("operator_id","id"),
	CONSTRAINT "receipts_payment_unique" UNIQUE("operator_id","payment_id"),
	CONSTRAINT "receipts_operator_number_unique" UNIQUE("operator_id","receipt_number"),
	CONSTRAINT "receipts_number_not_blank" CHECK (coalesce(btrim("receipts"."receipt_number"), '') <> ''),
	CONSTRAINT "receipts_provisional_ref_format" CHECK ("receipts"."provisional_ref" ~ '^P-[A-Z0-9]{3}-[0-9]{4,9}$'),
	CONSTRAINT "receipts_legacy_both_or_neither" CHECK (("receipts"."legacy_source" IS NULL) = ("receipts"."legacy_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_assignment_fk" FOREIGN KEY ("operator_id","assignment_id") REFERENCES "public"."vc_assignments"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_invoice_fk" FOREIGN KEY ("operator_id","customer_id","invoice_id") REFERENCES "public"."invoices"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_created_by_fk" FOREIGN KEY ("operator_id","created_by") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_run_items" ADD CONSTRAINT "billing_run_items_run_fk" FOREIGN KEY ("operator_id","run_id") REFERENCES "public"."billing_runs"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_run_items" ADD CONSTRAINT "billing_run_items_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_run_items" ADD CONSTRAINT "billing_run_items_invoice_fk" FOREIGN KEY ("operator_id","customer_id","invoice_id") REFERENCES "public"."invoices"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_runs" ADD CONSTRAINT "billing_runs_actor_fk" FOREIGN KEY ("operator_id","actor_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("operator_id","invoice_id") REFERENCES "public"."invoices"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_assignment_fk" FOREIGN KEY ("operator_id","assignment_id") REFERENCES "public"."vc_assignments"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_adjustment_fk" FOREIGN KEY ("operator_id","adjustment_id","invoice_id") REFERENCES "public"."adjustments"("operator_id","id","invoice_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_fk" FOREIGN KEY ("operator_id","voided_by") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sessions" ADD CONSTRAINT "collection_sessions_collector_fk" FOREIGN KEY ("operator_id","collector_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sessions" ADD CONSTRAINT "collection_sessions_reviewed_by_fk" FOREIGN KEY ("operator_id","reviewed_by") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_invoice_fk" FOREIGN KEY ("operator_id","customer_id","invoice_id") REFERENCES "public"."invoices"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_payment_fk" FOREIGN KEY ("operator_id","customer_id","payment_id") REFERENCES "public"."payments"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_credit_adjustment_fk" FOREIGN KEY ("operator_id","customer_id","credit_adjustment_id") REFERENCES "public"."adjustments"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_reversal_fk" FOREIGN KEY ("operator_id","payment_id","reversal_id") REFERENCES "public"."payment_reversals"("operator_id","payment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_reverses_fk" FOREIGN KEY ("operator_id","invoice_id","payment_id","reverses_allocation_id") REFERENCES "public"."allocations"("operator_id","invoice_id","payment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_balances" ADD CONSTRAINT "customer_balances_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_invoice_fk" FOREIGN KEY ("operator_id","customer_id","invoice_id") REFERENCES "public"."invoices"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_adjustment_fk" FOREIGN KEY ("operator_id","customer_id","adjustment_id") REFERENCES "public"."adjustments"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_fk" FOREIGN KEY ("operator_id","customer_id","payment_id") REFERENCES "public"."payments"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_reversal_fk" FOREIGN KEY ("operator_id","customer_id","payment_reversal_id") REFERENCES "public"."payment_reversals"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_payment_fk" FOREIGN KEY ("operator_id","customer_id","payment_id") REFERENCES "public"."payments"("operator_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_actor_fk" FOREIGN KEY ("operator_id","actor_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_fk" FOREIGN KEY ("operator_id","customer_id") REFERENCES "public"."customers"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_collector_fk" FOREIGN KEY ("operator_id","collector_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_device_fk" FOREIGN KEY ("operator_id","device_id") REFERENCES "public"."devices"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reviewed_by_fk" FOREIGN KEY ("operator_id","reviewed_by") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_actions" ADD CONSTRAINT "receipt_actions_receipt_fk" FOREIGN KEY ("operator_id","receipt_id") REFERENCES "public"."receipts"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_actions" ADD CONSTRAINT "receipt_actions_device_fk" FOREIGN KEY ("operator_id","device_id") REFERENCES "public"."devices"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_actions" ADD CONSTRAINT "receipt_actions_actor_fk" FOREIGN KEY ("operator_id","actor_id") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_links" ADD CONSTRAINT "receipt_links_receipt_fk" FOREIGN KEY ("operator_id","receipt_id") REFERENCES "public"."receipts"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_links" ADD CONSTRAINT "receipt_links_created_by_fk" FOREIGN KEY ("operator_id","created_by") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_links" ADD CONSTRAINT "receipt_links_revoked_by_fk" FOREIGN KEY ("operator_id","revoked_by") REFERENCES "public"."users"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_fk" FOREIGN KEY ("operator_id","payment_id") REFERENCES "public"."payments"("operator_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adjustments_operator_legacy_unique" ON "adjustments" USING btree ("operator_id","legacy_source","legacy_id") WHERE "adjustments"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "adjustments_pending_idx" ON "adjustments" USING btree ("operator_id","customer_id") WHERE "adjustments"."invoice_id" IS NULL AND "adjustments"."direction" = 'debit';--> statement-breakpoint
CREATE INDEX "adjustments_assignment_period_idx" ON "adjustments" USING btree ("operator_id","assignment_id","period");--> statement-breakpoint
CREATE INDEX "adjustments_customer_idx" ON "adjustments" USING btree ("operator_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_run_items_outcome_idx" ON "billing_run_items" USING btree ("operator_id","run_id","outcome");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("operator_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_assignment_idx" ON "invoice_lines" USING btree ("operator_id","assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_adjustment_unique" ON "invoice_lines" USING btree ("operator_id","adjustment_id") WHERE "invoice_lines"."adjustment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_one_rent_per_assignment" ON "invoice_lines" USING btree ("operator_id","invoice_id","assignment_id") WHERE "invoice_lines"."type" = 'rent';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_regular_per_period" ON "invoices" USING btree ("operator_id","customer_id","period") WHERE "invoices"."kind" = 'regular';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_operator_legacy_unique" ON "invoices" USING btree ("operator_id","legacy_source","legacy_id") WHERE "invoices"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoices_customer_period_idx" ON "invoices" USING btree ("operator_id","customer_id","period","id");--> statement-breakpoint
CREATE INDEX "invoices_period_idx" ON "invoices" USING btree ("operator_id","period");--> statement-breakpoint
CREATE INDEX "collection_sessions_day_idx" ON "collection_sessions" USING btree ("operator_id","business_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_live_unique" ON "jobs" USING btree (coalesce("operator_id", '00000000-0000-0000-0000-000000000000'::uuid),"dedupe_key") WHERE "jobs"."dedupe_key" IS NOT NULL AND "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_claimable_idx" ON "jobs" USING btree ("run_after","id") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("locked_until") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_operator_type_idx" ON "jobs" USING btree ("operator_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_reverses_unique" ON "allocations" USING btree ("operator_id","reverses_allocation_id") WHERE "allocations"."reverses_allocation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "allocations_invoice_idx" ON "allocations" USING btree ("operator_id","invoice_id");--> statement-breakpoint
CREATE INDEX "allocations_customer_idx" ON "allocations" USING btree ("operator_id","customer_id");--> statement-breakpoint
CREATE INDEX "allocations_payment_idx" ON "allocations" USING btree ("operator_id","payment_id") WHERE "allocations"."payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "allocations_credit_adjustment_idx" ON "allocations" USING btree ("operator_id","credit_adjustment_id") WHERE "allocations"."credit_adjustment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_entries_customer_seq_idx" ON "ledger_entries" USING btree ("operator_id","customer_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_per_invoice" ON "ledger_entries" USING btree ("operator_id","invoice_id") WHERE "ledger_entries"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_per_adjustment" ON "ledger_entries" USING btree ("operator_id","adjustment_id") WHERE "ledger_entries"."adjustment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_per_payment" ON "ledger_entries" USING btree ("operator_id","payment_id") WHERE "ledger_entries"."payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_per_reversal" ON "ledger_entries" USING btree ("operator_id","payment_reversal_id") WHERE "ledger_entries"."payment_reversal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_operator_legacy_unique" ON "payments" USING btree ("operator_id","legacy_source","legacy_id") WHERE "payments"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("operator_id","customer_id","posted_at");--> statement-breakpoint
CREATE INDEX "payments_collector_day_idx" ON "payments" USING btree ("operator_id","collector_id","business_date");--> statement-breakpoint
CREATE INDEX "payments_business_date_idx" ON "payments" USING btree ("operator_id","business_date");--> statement-breakpoint
CREATE INDEX "payments_needs_review_idx" ON "payments" USING btree ("operator_id","posted_at") WHERE "payments"."review_status" = 'needs_review';--> statement-breakpoint
CREATE INDEX "receipt_actions_receipt_idx" ON "receipt_actions" USING btree ("operator_id","receipt_id","at");--> statement-breakpoint
CREATE INDEX "receipt_links_receipt_idx" ON "receipt_links" USING btree ("operator_id","receipt_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_operator_legacy_unique" ON "receipts" USING btree ("operator_id","legacy_source","legacy_id") WHERE "receipts"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "receipts_provisional_ref_idx" ON "receipts" USING btree ("operator_id","provisional_ref") WHERE "receipts"."provisional_ref" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "adjustments" AS PERMISSIVE FOR ALL TO "app_rw" USING ("adjustments"."operator_id" = app.current_operator()) WITH CHECK ("adjustments"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_run_items" AS PERMISSIVE FOR ALL TO "app_rw" USING ("billing_run_items"."operator_id" = app.current_operator()) WITH CHECK ("billing_run_items"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_runs" AS PERMISSIVE FOR ALL TO "app_rw" USING ("billing_runs"."operator_id" = app.current_operator()) WITH CHECK ("billing_runs"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_lines" AS PERMISSIVE FOR ALL TO "app_rw" USING ("invoice_lines"."operator_id" = app.current_operator()) WITH CHECK ("invoice_lines"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices" AS PERMISSIVE FOR ALL TO "app_rw" USING ("invoices"."operator_id" = app.current_operator()) WITH CHECK ("invoices"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "collection_sessions" AS PERMISSIVE FOR ALL TO "app_rw" USING ("collection_sessions"."operator_id" = app.current_operator()) WITH CHECK ("collection_sessions"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jobs" AS PERMISSIVE FOR ALL TO "app_rw" USING ("jobs"."operator_id" = app.current_operator()) WITH CHECK ("jobs"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "jobs_platform_select" ON "jobs" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "jobs_platform_insert" ON "jobs" AS PERMISSIVE FOR INSERT TO "app_platform" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "jobs_platform_update" ON "jobs" AS PERMISSIVE FOR UPDATE TO "app_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "allocations" AS PERMISSIVE FOR ALL TO "app_rw" USING ("allocations"."operator_id" = app.current_operator()) WITH CHECK ("allocations"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_balances" AS PERMISSIVE FOR ALL TO "app_rw" USING ("customer_balances"."operator_id" = app.current_operator()) WITH CHECK ("customer_balances"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ledger_entries" AS PERMISSIVE FOR ALL TO "app_rw" USING ("ledger_entries"."operator_id" = app.current_operator()) WITH CHECK ("ledger_entries"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_reversals" AS PERMISSIVE FOR ALL TO "app_rw" USING ("payment_reversals"."operator_id" = app.current_operator()) WITH CHECK ("payment_reversals"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO "app_rw" USING ("payments"."operator_id" = app.current_operator()) WITH CHECK ("payments"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "receipt_actions" AS PERMISSIVE FOR ALL TO "app_rw" USING ("receipt_actions"."operator_id" = app.current_operator()) WITH CHECK ("receipt_actions"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "receipt_links" AS PERMISSIVE FOR ALL TO "app_rw" USING ("receipt_links"."operator_id" = app.current_operator()) WITH CHECK ("receipt_links"."operator_id" = app.current_operator());--> statement-breakpoint
CREATE POLICY "receipt_links_platform_select" ON "receipt_links" AS PERMISSIVE FOR SELECT TO "app_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "receipts" AS PERMISSIVE FOR ALL TO "app_rw" USING ("receipts"."operator_id" = app.current_operator()) WITH CHECK ("receipts"."operator_id" = app.current_operator());
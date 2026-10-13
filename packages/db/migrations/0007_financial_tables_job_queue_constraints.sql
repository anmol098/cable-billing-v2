-- T-023 custom SQL: the append-only and lifecycle rules of the financial tables that Drizzle's
-- schema can't express (packages/db/src/schema/{billing,payments,ledger,receipts,collections}.ts
-- explain each rule). PLAN §7.1 Immutability, RULE-20, BR-13: posted financial records are never
-- updated or deleted; corrections are reversals or adjustments.
-- Triggers call app.forbid_update_delete(allowed column, ...) (migration 0000; SQLSTATE CB001):
-- DELETE and TRUNCATE always fail, an UPDATE fails if a column outside the list changes.
--
-- invoices: inserted issued; afterwards only the void status and its metadata may change
-- (PLAN §7.1 "issued invoices (except status/void metadata)"), and a void invoice is final.
CREATE TRIGGER "invoices_append_only"
  BEFORE UPDATE OR DELETE ON "public"."invoices"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete('status', 'voided_at', 'voided_by', 'void_reason');
--> statement-breakpoint
CREATE TRIGGER "invoices_no_truncate"
  BEFORE TRUNCATE ON "public"."invoices"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "invoices_void_final"
  BEFORE UPDATE ON "public"."invoices"
  FOR EACH ROW
  WHEN (OLD.status = 'void')
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- invoice_lines: fully append-only.
CREATE TRIGGER "invoice_lines_append_only"
  BEFORE UPDATE OR DELETE ON "public"."invoice_lines"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "invoice_lines_no_truncate"
  BEFORE TRUNCATE ON "public"."invoice_lines"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- adjustments: append-only except invoice_id, which a bill sets once (PLAN §7.2 "set when
-- invoiced") and which never changes afterwards.
CREATE TRIGGER "adjustments_append_only"
  BEFORE UPDATE OR DELETE ON "public"."adjustments"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete('invoice_id');
--> statement-breakpoint
CREATE TRIGGER "adjustments_no_truncate"
  BEFORE TRUNCATE ON "public"."adjustments"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "adjustments_invoiced_once"
  BEFORE UPDATE OF invoice_id ON "public"."adjustments"
  FOR EACH ROW
  WHEN (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- payments: a posted payment never changes (FR-013) except the review workflow: while
-- review_status = 'needs_review' the office may resolve it (status + who/when/note). Payments that
-- were never flagged, or are resolved, are frozen completely.
CREATE TRIGGER "payments_append_only"
  BEFORE UPDATE OR DELETE ON "public"."payments"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete('review_status', 'reviewed_by', 'reviewed_at', 'review_note');
--> statement-breakpoint
CREATE TRIGGER "payments_no_truncate"
  BEFORE TRUNCATE ON "public"."payments"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "payments_review_final"
  BEFORE UPDATE ON "public"."payments"
  FOR EACH ROW
  WHEN (OLD.review_status <> 'needs_review')
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- payment_reversals, allocations, ledger_entries, receipts, receipt_actions: fully append-only.
CREATE TRIGGER "payment_reversals_append_only"
  BEFORE UPDATE OR DELETE ON "public"."payment_reversals"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "payment_reversals_no_truncate"
  BEFORE TRUNCATE ON "public"."payment_reversals"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "allocations_append_only"
  BEFORE UPDATE OR DELETE ON "public"."allocations"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "allocations_no_truncate"
  BEFORE TRUNCATE ON "public"."allocations"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "public"."ledger_entries"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "public"."ledger_entries"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "receipts_append_only"
  BEFORE UPDATE OR DELETE ON "public"."receipts"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "receipts_no_truncate"
  BEFORE TRUNCATE ON "public"."receipts"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "receipt_actions_append_only"
  BEFORE UPDATE OR DELETE ON "public"."receipt_actions"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "receipt_actions_no_truncate"
  BEFORE TRUNCATE ON "public"."receipt_actions"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- allocations: a reversal row (PLAN §8.6) must cancel exactly one positive row of the same invoice
-- and payment (the composite FK allocations_reverses_fk checks invoice and payment, the partial
-- UNIQUE allocations_reverses_unique "at most once"), for exactly its amount (this trigger).
-- Rows with a non-negative amount are left to the CHECK allocations_reversal_shape.
-- SECURITY INVOKER: it reads the original row under the caller's RLS (the same tenant).
CREATE OR REPLACE FUNCTION app.check_allocation_reversal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  original_amount bigint;
BEGIN
  IF NEW.reverses_allocation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT a.amount_paise INTO original_amount
    FROM public.allocations AS a
   WHERE a.operator_id = NEW.operator_id AND a.id = NEW.reverses_allocation_id;
  IF original_amount IS NULL OR original_amount <= 0 OR NEW.amount_paise <> -original_amount THEN
    RAISE EXCEPTION 'allocation reversal row must cancel one positive allocation row exactly'
      USING ERRCODE = 'check_violation', TABLE = 'allocations',
            CONSTRAINT = 'allocations_reversal_cancels_original';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "allocations_reversal_cancels_original"
  BEFORE INSERT ON "public"."allocations"
  FOR EACH ROW
  WHEN (NEW.reverses_allocation_id IS NOT NULL AND NEW.amount_paise < 0)
  EXECUTE FUNCTION app.check_allocation_reversal();
--> statement-breakpoint
-- receipt_links: after insert only revocation and access tracking change; a revoked link stays
-- revoked. DELETE stays possible for the purge of long-expired links (PLAN §14).
CREATE TRIGGER "receipt_links_limited_update"
  BEFORE UPDATE ON "public"."receipt_links"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete('revoked_at', 'revoked_by', 'access_count', 'last_access_at');
--> statement-breakpoint
CREATE TRIGGER "receipt_links_revocation_final"
  BEFORE UPDATE OF revoked_at, revoked_by ON "public"."receipt_links"
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NOT NULL
    AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by))
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- customer_balances: the read model is updated in place but never deleted (it would silently
-- reset a customer's balance), and its customer and tenant never change.
CREATE TRIGGER "customer_balances_identity_immutable"
  BEFORE UPDATE OF customer_id, operator_id ON "public"."customer_balances"
  FOR EACH ROW
  WHEN (OLD.customer_id IS DISTINCT FROM NEW.customer_id OR OLD.operator_id IS DISTINCT FROM NEW.operator_id)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "customer_balances_no_delete"
  BEFORE DELETE ON "public"."customer_balances"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "customer_balances_no_truncate"
  BEFORE TRUNCATE ON "public"."customer_balances"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- billing_runs, billing_run_items: status rows that are updated, but never deleted (the run
-- history and exception queue, J-03); a run's tenant and period and an item's run and customer
-- never change. A billed item (created / already_exists) is final.
CREATE TRIGGER "billing_runs_identity_immutable"
  BEFORE UPDATE OF id, operator_id, period ON "public"."billing_runs"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id
    OR OLD.operator_id IS DISTINCT FROM NEW.operator_id
    OR OLD.period IS DISTINCT FROM NEW.period)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "billing_runs_no_delete"
  BEFORE DELETE ON "public"."billing_runs"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "billing_runs_no_truncate"
  BEFORE TRUNCATE ON "public"."billing_runs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "billing_run_items_identity_immutable"
  BEFORE UPDATE OF id, operator_id, run_id, customer_id ON "public"."billing_run_items"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id
    OR OLD.operator_id IS DISTINCT FROM NEW.operator_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.customer_id IS DISTINCT FROM NEW.customer_id)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "billing_run_items_billed_final"
  BEFORE UPDATE ON "public"."billing_run_items"
  FOR EACH ROW
  WHEN (OLD.outcome IN ('created', 'already_exists'))
  EXECUTE FUNCTION app.forbid_update_delete('updated_at');
--> statement-breakpoint
CREATE TRIGGER "billing_run_items_no_delete"
  BEFORE DELETE ON "public"."billing_run_items"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "billing_run_items_no_truncate"
  BEFORE TRUNCATE ON "public"."billing_run_items"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- collection_sessions: never deleted; the collector, day and tenant never change; an accepted
-- handover is final (only the running totals move when a late payment syncs or one is reversed).
CREATE TRIGGER "collection_sessions_identity_immutable"
  BEFORE UPDATE OF id, operator_id, collector_id, business_date ON "public"."collection_sessions"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id
    OR OLD.operator_id IS DISTINCT FROM NEW.operator_id
    OR OLD.collector_id IS DISTINCT FROM NEW.collector_id
    OR OLD.business_date IS DISTINCT FROM NEW.business_date)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "collection_sessions_accepted_final"
  BEFORE UPDATE ON "public"."collection_sessions"
  FOR EACH ROW
  WHEN (OLD.status = 'accepted')
  EXECUTE FUNCTION app.forbid_update_delete('cash_expected_paise', 'upi_total_paise', 'payment_count', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "collection_sessions_no_delete"
  BEFORE DELETE ON "public"."collection_sessions"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "collection_sessions_no_truncate"
  BEFORE TRUNCATE ON "public"."collection_sessions"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();

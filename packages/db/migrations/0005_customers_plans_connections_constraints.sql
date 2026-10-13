-- T-022 custom SQL: what Drizzle's schema can't express for customers, plans and connections
-- (packages/db/src/schema/{customers,plans,connections}.ts explain each rule).
-- Triggers call app.forbid_update_delete() (migration 0000; SQLSTATE CB001).
--
-- RULE-06 / BR-03: a VC can't have two assignments whose date ranges overlap. Both ends are
-- inclusive ('[]'): end_date is the last day of service (T-040), a NULL end is unbounded. Needs
-- btree_gist (migration 0000) for the uuid equality parts. Violations: SQLSTATE 23P01.
ALTER TABLE "public"."vc_assignments"
  ADD CONSTRAINT "vc_assignments_no_overlap"
  EXCLUDE USING gist (
    "operator_id" WITH =,
    "vc_asset_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  );
--> statement-breakpoint
-- vc_assignments: an assignment never moves to another VC, customer, start date or tenant (reuse
-- is a new assignment, RULE-07; the start date is the 'activated' event's date) and is never
-- deleted (FR-005: history is never overwritten).
CREATE TRIGGER "vc_assignments_identity_immutable"
  BEFORE UPDATE OF id, operator_id, vc_asset_id, customer_id, start_date ON "public"."vc_assignments"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id
    OR OLD.operator_id IS DISTINCT FROM NEW.operator_id
    OR OLD.vc_asset_id IS DISTINCT FROM NEW.vc_asset_id
    OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
    OR OLD.start_date IS DISTINCT FROM NEW.start_date)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "vc_assignments_no_delete"
  BEFORE DELETE ON "public"."vc_assignments"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "vc_assignments_no_truncate"
  BEFORE TRUNCATE ON "public"."vc_assignments"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- assignment_events: the status/plan timeline is append-only (FR-006).
CREATE TRIGGER "assignment_events_append_only"
  BEFORE UPDATE OR DELETE ON "public"."assignment_events"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "assignment_events_no_truncate"
  BEFORE TRUNCATE ON "public"."assignment_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- customer_contact_changes: the contact-number history is append-only (FR-004).
CREATE TRIGGER "customer_contact_changes_append_only"
  BEFORE UPDATE OR DELETE ON "public"."customer_contact_changes"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "customer_contact_changes_no_truncate"
  BEFORE TRUNCATE ON "public"."customer_contact_changes"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- customers, plans, vc_assets: deactivated / retired, never deleted (their history and financial
-- records point at them); their id and tenant never change.
CREATE TRIGGER "customers_identity_immutable"
  BEFORE UPDATE OF id, operator_id ON "public"."customers"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.operator_id IS DISTINCT FROM NEW.operator_id)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "customers_no_delete"
  BEFORE DELETE ON "public"."customers"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "customers_no_truncate"
  BEFORE TRUNCATE ON "public"."customers"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "plans_identity_immutable"
  BEFORE UPDATE OF id, operator_id ON "public"."plans"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.operator_id IS DISTINCT FROM NEW.operator_id)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "plans_no_delete"
  BEFORE DELETE ON "public"."plans"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "plans_no_truncate"
  BEFORE TRUNCATE ON "public"."plans"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "vc_assets_identity_immutable"
  BEFORE UPDATE OF id, operator_id ON "public"."vc_assets"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.operator_id IS DISTINCT FROM NEW.operator_id)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "vc_assets_no_delete"
  BEFORE DELETE ON "public"."vc_assets"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "vc_assets_no_truncate"
  BEFORE TRUNCATE ON "public"."vc_assets"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();

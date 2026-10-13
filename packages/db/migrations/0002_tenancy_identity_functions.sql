-- T-021 custom SQL: the gap-free counter function and the integrity triggers of the tenancy,
-- identity, audit, counter and subscription tables (packages/db/src/schema/*.ts explain each).
-- Append-only triggers come from appendOnlyTriggerSql() (src/triggers); SQLSTATE CB001.
--
-- app.next_counter(operator_id, name): the next number of a per-tenant counter, starting at 1.
-- INSERT … ON CONFLICT DO UPDATE takes the counter row's lock, so concurrent callers queue until
-- the holder's transaction ends, and a rolled-back transaction gives its number back: committed
-- numbers are gap-free and unique. SECURITY INVOKER (the default): RLS on counters applies, so
-- inside withTenant(A) a call for another operator fails with 42501 instead of touching its row.
CREATE FUNCTION app.next_counter(p_operator_id uuid, p_name public.counter_name) RETURNS bigint
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog
AS $$
  INSERT INTO public.counters AS c (operator_id, name, next_value)
  VALUES (p_operator_id, p_name, 2)
  ON CONFLICT (operator_id, name) DO UPDATE SET next_value = c.next_value + 1
  RETURNING c.next_value - 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.next_counter(uuid, public.counter_name) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.next_counter(uuid, public.counter_name) TO app_rw;
--> statement-breakpoint
-- counters: only next_value may change, and never downwards; a counter is never deleted (its next
-- call would restart at 1 and hand out numbers that already exist).
CREATE TRIGGER "counters_append_only"
  BEFORE UPDATE OR DELETE ON "public"."counters"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete('next_value');
--> statement-breakpoint
CREATE TRIGGER "counters_no_truncate"
  BEFORE TRUNCATE ON "public"."counters"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "counters_no_decrease"
  BEFORE UPDATE OF next_value ON "public"."counters"
  FOR EACH ROW
  WHEN (NEW.next_value < OLD.next_value)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- audit_events: fully append-only (FR-024).
CREATE TRIGGER "audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "public"."audit_events"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "public"."audit_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- subscription_events: the stored webhook never changes; only its processing outcome is recorded.
CREATE TRIGGER "subscription_events_append_only"
  BEFORE UPDATE OR DELETE ON "public"."subscription_events"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete('processed_at', 'processing_error');
--> statement-breakpoint
CREATE TRIGGER "subscription_events_no_truncate"
  BEFORE TRUNCATE ON "public"."subscription_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- operators: the tenant id is immutable (FR-002) and a tenant is never deleted (FR-025).
CREATE TRIGGER "operators_id_immutable"
  BEFORE UPDATE OF id ON "public"."operators"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id)
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "operators_no_delete"
  BEFORE DELETE ON "public"."operators"
  FOR EACH ROW
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER "operators_no_truncate"
  BEFORE TRUNCATE ON "public"."operators"
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.forbid_update_delete();
--> statement-breakpoint
-- users: a user's id and tenant never change (no moving people between tenants, no turning a
-- tenant user into a platform admin or back).
CREATE TRIGGER "users_identity_immutable"
  BEFORE UPDATE OF id, operator_id ON "public"."users"
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.operator_id IS DISTINCT FROM NEW.operator_id)
  EXECUTE FUNCTION app.forbid_update_delete();

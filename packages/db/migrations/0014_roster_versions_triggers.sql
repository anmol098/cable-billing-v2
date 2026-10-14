-- T-060 custom SQL: keep public.roster_versions (packages/db/src/schema/roster.ts) in step with
-- every change the lineman's roster row shows, in the same transaction as the change.
--
-- app.roster_touch(operator, customer, at): records that the current transaction changed the
-- customer's roster row. change_xid = pg_current_xact_id() (the delta cursor's order: a cursor
-- keeps the reading snapshot's xmin, and a transaction still running then has an xid >= it, so a
-- late commit is never skipped). changed_at (the wire's updated_at) is strictly increasing per
-- customer at millisecond precision: greatest(previous + 1 ms, at), or greatest(previous, at) for
-- another change in the same transaction. SECURITY INVOKER: RLS on roster_versions applies, so a
-- write under withTenant(A) can only touch A's rows.
CREATE FUNCTION app.roster_touch(p_operator_id uuid, p_customer_id uuid, p_at timestamptz)
  RETURNS void
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog
AS $$
  INSERT INTO public.roster_versions AS r (customer_id, operator_id, change_xid, changed_at)
  VALUES (p_customer_id, p_operator_id, pg_current_xact_id(), date_trunc('milliseconds', p_at))
  ON CONFLICT (customer_id) DO UPDATE SET
    change_xid = excluded.change_xid,
    changed_at = CASE
      WHEN r.change_xid = excluded.change_xid THEN greatest(r.changed_at, excluded.changed_at)
      ELSE greatest(r.changed_at + interval '1 millisecond', excluded.changed_at)
    END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.roster_touch(uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.roster_touch(uuid, uuid, timestamptz) TO app_rw;
--> statement-breakpoint
-- customers: any change of the row (code, name, phones, address, area, status, …) and new rows.
CREATE FUNCTION app.roster_touch_customer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM app.roster_touch(NEW.operator_id, NEW.id, NEW.updated_at);
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- The rows of customer_balances and vc_assignments carry customer_id and updated_at.
CREATE FUNCTION app.roster_touch_customer_ref() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM app.roster_touch(NEW.operator_id, NEW.customer_id, NEW.updated_at);
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- areas: a rename changes the area name on every roster row in it.
CREATE FUNCTION app.roster_touch_area() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT id FROM public.customers
    WHERE operator_id = NEW.operator_id AND area_id = NEW.id
  LOOP
    PERFORM app.roster_touch(NEW.operator_id, c.id, NEW.updated_at);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- vc_assets: a corrected VC number changes the connections of its current holder.
CREATE FUNCTION app.roster_touch_vc_asset() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  a record;
BEGIN
  FOR a IN
    SELECT DISTINCT customer_id FROM public.vc_assignments
    WHERE operator_id = NEW.operator_id AND vc_asset_id = NEW.id AND status <> 'disconnected'
  LOOP
    PERFORM app.roster_touch(NEW.operator_id, a.customer_id, NEW.updated_at);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "customers_roster_insert"
  AFTER INSERT ON "public"."customers"
  FOR EACH ROW
  EXECUTE FUNCTION app.roster_touch_customer();
--> statement-breakpoint
CREATE TRIGGER "customers_roster_update"
  AFTER UPDATE ON "public"."customers"
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION app.roster_touch_customer();
--> statement-breakpoint
-- A zero balance row (lockCustomerBalance creates one before the first money change) changes
-- nothing the phone shows; any row with money in it (seed, import, migration) does.
CREATE TRIGGER "customer_balances_roster_insert"
  AFTER INSERT ON "public"."customer_balances"
  FOR EACH ROW
  WHEN (NEW.balance_paise <> 0 OR NEW.credit_paise <> 0 OR NEW.oldest_due_period IS NOT NULL)
  EXECUTE FUNCTION app.roster_touch_customer_ref();
--> statement-breakpoint
CREATE TRIGGER "customer_balances_roster_update"
  AFTER UPDATE ON "public"."customer_balances"
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION app.roster_touch_customer_ref();
--> statement-breakpoint
CREATE TRIGGER "vc_assignments_roster_insert"
  AFTER INSERT ON "public"."vc_assignments"
  FOR EACH ROW
  EXECUTE FUNCTION app.roster_touch_customer_ref();
--> statement-breakpoint
CREATE TRIGGER "vc_assignments_roster_update"
  AFTER UPDATE ON "public"."vc_assignments"
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION app.roster_touch_customer_ref();
--> statement-breakpoint
CREATE TRIGGER "areas_roster_rename"
  AFTER UPDATE OF name ON "public"."areas"
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION app.roster_touch_area();
--> statement-breakpoint
CREATE TRIGGER "vc_assets_roster_number"
  AFTER UPDATE OF vc_number ON "public"."vc_assets"
  FOR EACH ROW
  WHEN (OLD.vc_number IS DISTINCT FROM NEW.vc_number)
  EXECUTE FUNCTION app.roster_touch_vc_asset();
--> statement-breakpoint
-- Existing customers (a database migrated before T-060): one row each, as of this transaction,
-- with the latest updated_at of the parts of their roster row.
INSERT INTO public.roster_versions (customer_id, operator_id, change_xid, changed_at)
SELECT c.id, c.operator_id, pg_current_xact_id(),
  date_trunc('milliseconds', greatest(
    c.updated_at,
    b.updated_at,
    (SELECT max(s.updated_at) FROM public.vc_assignments s
      WHERE s.operator_id = c.operator_id AND s.customer_id = c.id)
  ))
FROM public.customers c
LEFT JOIN public.customer_balances b ON b.operator_id = c.operator_id AND b.customer_id = c.id
ON CONFLICT (customer_id) DO NOTHING;

-- Backup manifest (T-096): row counts of every table and money totals, as ONE line of JSON.
-- backup.sh runs it inside the dump's exported snapshot; restore-drill.sh runs it again on the
-- restored copy, and verify-restore.ts demands equal tables, counts, totals and migrations.
-- Aggregates only (no personal data). Keep it a single statement with no psql meta-commands.
SELECT json_build_object(
  'tables', (
    SELECT coalesce(json_object_agg(t.schema_name || '.' || t.table_name, t.row_count ORDER BY t.schema_name, t.table_name), '{}'::json)
    FROM (
      SELECT n.nspname AS schema_name, c.relname AS table_name,
        (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS row_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'drizzle', 'app')
    ) t
  ),
  'money', json_build_object(
    'payments_amount_paise', (SELECT coalesce(sum(amount_paise), 0)::text FROM public.payments),
    'invoices_charges_paise', (SELECT coalesce(sum(charges_paise), 0)::text FROM public.invoices),
    'ledger_amount_paise', (SELECT coalesce(sum(amount_paise), 0)::text FROM public.ledger_entries),
    'balances_balance_paise', (SELECT coalesce(sum(balance_paise), 0)::text FROM public.customer_balances),
    'balances_credit_paise', (SELECT coalesce(sum(credit_paise), 0)::text FROM public.customer_balances)
  ),
  'latest_migration', (
    SELECT json_build_object('id', id, 'hash', hash, 'created_at', created_at)
    FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1
  ),
  'migration_count', (SELECT count(*) FROM drizzle.__drizzle_migrations),
  'server_version', current_setting('server_version'),
  'database_size_bytes', pg_database_size(current_database())
)::text;

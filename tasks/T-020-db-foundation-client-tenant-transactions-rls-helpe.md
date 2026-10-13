---
id: T-020
title: DB foundation: client, tenant transactions, RLS helpers, test harness
phase: 1
area: db
status: done
owner: agent-t020
claimed_at: 2026-10-13T10:27:41.906Z
branch: task/T-020-db-foundation-client-tenant-transactions
depends_on: [T-001]
review: required
claimable_by: agent
size: L
paths: [packages/db/src/client.ts, packages/db/src/tenant.ts, packages/db/src/rls/**, packages/db/src/triggers/**, packages/db/src/ids.ts, packages/db/src/testing/**, packages/db/drizzle.config.ts, packages/db/migrations/0000_*, packages/db/package.json]
---

# T-020 — DB foundation: client, tenant transactions, RLS helpers, test harness

**Phase** 1 · **Area** db · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-001

## Goal

The safe way to talk to Postgres: every tenant query runs inside a transaction that sets the RLS tenant.

## Scope

- Drizzle + drizzle-kit config; `@neondatabase/serverless` Pool for runtime, `pg` for tests/migrations.
- `withTenant(operatorId, fn)`: opens a transaction, runs `select set_config('app.operator_id', $1, true)`, passes a tx; `withPlatform(fn)` for cross-tenant jobs (no tenant set, separate role).
- Baseline migration: roles `app_rw` (no BYPASSRLS) and `app_platform`; `btree_gist` extension; helper SQL functions `app.current_operator()`; reusable RLS policy generator for tenant tables; immutability trigger function (`app.forbid_update_delete()` with allowed-column list).
- UUIDv7 generator.
- Test harness: spins a fresh database per test file (template DB) against local Postgres, runs migrations, exposes `createTenant()` fixtures.
- Conventions doc in `packages/db/README.md`: one schema file per module (`src/schema/<module>.ts`), composite FKs `(operator_id, id)`, money `bigint` `_paise`, `timestamptz`, period `date` with CHECK day=1.

## Acceptance criteria

- [x] A query on a tenant table without `withTenant` returns zero rows (RLS) in tests.
- [x] Setting tenant A and selecting tenant B rows by id returns nothing.
- [x] Immutability trigger blocks UPDATE/DELETE in a demo table.

## Tests required

- Integration tests for RLS, immutability trigger and transaction rollback.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/client.ts`
- `packages/db/src/tenant.ts`
- `packages/db/src/rls/**`
- `packages/db/src/triggers/**`
- `packages/db/src/ids.ts`
- `packages/db/src/testing/**`
- `packages/db/drizzle.config.ts`
- `packages/db/migrations/0000_*`
- `packages/db/package.json`

## Notes

- Migrations: generate with drizzle-kit only after rebasing on the latest integration branch; if `migrations/meta/_journal.json` conflicts, delete your generated migration, rebase, regenerate (tasks/README.md §6).

## References

PLAN §3, PLAN §7.1, PLAN §9.1, E-02, E-03 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

Full guide: **`packages/db/README.md`** (security model, API, schema conventions, migrations, testing).

**What exists**

| File | What |
|---|---|
| `src/client.ts` | `createDb({ connectionString, driver?: "auto"\|"neon"\|"pg", max?, onIdleError? })` → `DbClient { driver, withTenant, withPlatform, end }`. No raw handle. `auto` = Neon WebSocket Pool for `*.neon.tech`, node-postgres otherwise. |
| `src/tenant.ts` | The transaction wrappers. One statement per transaction start: `select set_config('role', 'app_rw'\|'app_platform', true), set_config('app.operator_id', $1, true)`. `Tx`, `TxOptions` (`isolationLevel`, `accessMode`), `TransactionFinishedError` (using `tx` after the callback throws; nested `tx.transaction()` guarded too). Non-UUID `operatorId` → `TypeError` before any I/O. |
| `src/rls/index.ts` | `appRw`, `appPlatform` (`pgRole(...).existing()`), `currentOperator` (`app.current_operator()`), `operatorIdColumn()`, `tenantKey(t)` (UNIQUE `(operator_id, id)` for composite FKs), `tenantPolicies(t)` (policy `tenant_isolation`, FOR ALL TO app_rw, USING + WITH CHECK `operator_id = app.current_operator()`), constants `APP_RW_ROLE`, `APP_PLATFORM_ROLE`, `OPERATOR_ID_SETTING`. |
| `src/triggers/index.ts` | `appendOnlyTriggerSql({ table, allowedColumns?, when?, schema? })` → SQL for a custom migration (row trigger BEFORE UPDATE OR DELETE + statement trigger BEFORE TRUNCATE). `IMMUTABLE_ROW_SQLSTATE = "CB001"`, `isImmutableRowError(e)`, `sqlStateOf(e)` (follows drizzle's `cause`). |
| `src/ids.ts` | `uuidv7()`, `createUuidV7Generator({ now?, random? })`, `isUuid`, `isUuidV7`, `uuidV7Timestamp`, column helper `primaryId()`. |
| `migrations/0000_foundation.sql` | (custom migration) `btree_gist`; roles `app_rw`, `app_platform` (NOLOGIN, NOBYPASSRLS, created if missing) + membership for the migration role; schema `app`; default privileges (SELECT/INSERT/UPDATE/DELETE on tables, USAGE/SELECT on sequences in `public` for both roles); `app.current_operator()`; `app.forbid_update_delete()`. |
| `drizzle.config.ts` | schema `src/schema/index.ts`, out `migrations/`, URL `DATABASE_URL_UNPOOLED` ‖ `DATABASE_URL`, roles not managed by drizzle-kit, strict. Scripts `db:generate`, `db:migrate`, `db:check`, `db:test:clean`. |
| `src/testing/**` (`@cb/db/testing`) | `describeDb`, `useTestDatabase()` → `t.current.{ db, admin, url, name, createLoginRole(), drop() }`, `createTestDatabase()`, `createTenant(t.current)`, `auditDatabaseSecurity(client, { allowWithoutRls, allowDefinerObjects })`, `migrateDatabase(url)`, `ensureTemplate`, `migrationsHash`, `testDatabaseUrl`. Test-only `demo-schema.ts` (demo tables built with the helpers and created through drizzle-kit's own SQL generator). |

**API for later tasks**

- **T-021/T-022/T-023 (schema):** one file per module in `src/schema/`, append `export * from "./<module>";` to `src/schema/index.ts`. Tenant table = `id: primaryId()`, `operatorId: operatorIdColumn()`, `(t) => [tenantKey(t), ...tenantPolicies(t)]`, `.enableRLS()`; composite FKs `(operator_id, x_id) → x(operator_id, id)`. Append-only tables: custom migration with `appendOnlyTriggerSql(...)`. Global tables (no `operator_id`): RLS with explicit policies, or add to `ALLOW_WITHOUT_RLS` in `src/testing/harness.test.ts` with a reason — the security-audit test checks every table in the migrated DB automatically. A table the platform jobs must read (e.g. `operators`) needs an explicit `pgPolicy(..., { to: appPlatform })`. Generate migrations last, right after rebasing.
- **T-021 must update `createTenant`** (`src/testing/fixtures.ts`) to insert the `operators` row once the table exists (signature stays `createTenant(t.current, { name? })` → `{ operatorId, name }`).
- **T-025 (core):** build `defineService` on `db.withTenant(ctx.operatorId, fn, opts)`. Map `isImmutableRowError` → CONFLICT, SQLSTATE `42501` (RLS WITH CHECK) → NOT_FOUND/FORBIDDEN per the plan, `TypeError` from a bad operatorId → internal error (ids come from the session). The isolation harness can use `@cb/db/testing` (`useTestDatabase`, `createTenant`); add `@cb/db` to core's deps and list `DATABASE_URL`, `CB_SKIP_DB_TESTS`, `CB_TEST_DATABASE_ALLOW_REMOTE` in `packages/core/turbo.json` `tasks.test.env`.
- **T-043 (jobs):** `db.withPlatform` to list tenants / claim jobs (needs platform policies on those tables), then `db.withTenant` per tenant.
- **apps/web:** one module-level `createDb({ connectionString: requireServerEnv("DATABASE_URL").DATABASE_URL })` singleton. `pg` is in Next's default `serverExternalPackages`.

**Decisions (security-relevant; reviewer please check)**

1. **The app never queries as the table owner.** Every transaction switches to `app_rw` / `app_platform` transaction-locally; tables are owned by the migration role; `FORCE ROW LEVEL SECURITY` is not used (it doesn't bind superuser/BYPASSRLS owners, which we can't rule out on managed Postgres, and it would hide rows from migrations). Proven: `current_user` is `app_rw`/`app_platform` inside the wrappers; removing the role switch makes 7 RLS tests fail.
2. **Two deployment shapes.** A (today: CI, local, Neon previews): `DATABASE_URL` = owner role; isolation holds for everything through `createDb`, which has no raw handle. B (recommended for staging/prod): runtime URL = non-owner LOGIN role in `app_rw`+`app_platform` (INHERIT); then even a raw connection without the GUC sees zero rows (tested). Follow-up **T-020a** created for the prod role + boot check.
3. **No tenant → zero rows, never an error:** `app.current_operator()` = `nullif(current_setting('app.operator_id', true), '')::uuid` (missing GUC → NULL; after a transaction-local set_config Postgres leaves `''`, also NULL).
4. **No leak across pooled transactions:** both settings are `set_config(..., true)` (LOCAL); tested on a pool of 1 after COMMIT, ROLLBACK and an aborted (error) transaction, for node-postgres and for the Neon driver; making the tenant setting session-level makes the test fail. Also safe behind Neon's transaction-mode pgbouncer.
5. **`withPlatform` scope:** role `app_platform`, tenant explicitly empty, no BYPASSRLS, no policies on tenant tables (sees 0 rows, inserts rejected). It may only use tables that give it a policy or global tables allow-listed without RLS. Tenant data = iterate tenants with `withTenant`.
6. **Default privileges:** both app roles get SELECT/INSERT/UPDATE/DELETE on all future `public` tables (no TRUNCATE/REFERENCES/TRIGGER, no CREATE on `public`, no access to schema `drizzle`); RLS decides rows. All migrations must run as the same owner role (the audit test catches missing grants).
7. **Immutability trigger:** UPDATE allowed only if every changed column is in the list (compared via `to_jsonb(OLD/NEW)` minus allowed keys); DELETE and TRUNCATE always fail, for every role incl. owner; unknown column names in the list fail with 42703 (typos surface); messages name columns, never values; SQLSTATE `CB001`.
8. **UUIDv7 in pure TS** (Web Crypto, no Node imports; PG17 has no `uuidv7()`; Android makes payment ids offline anyway): RFC 9562 method 1, 12-bit counter seeded randomly per ms, carries into the timestamp on overflow or clock regression → strictly increasing within a process, ms-ordered across processes. No DB default for ids.
9. **Test harness:** template DB `cb_tpl_<sha256(migrations/)>` built once under an advisory lock, `ALLOW_CONNECTIONS false`; each test file clones it (`cb_test_<epoch>_<rand>`) and drops it; stale leftovers (> 6 h) cleaned automatically. Refuses non-local hosts unless `CB_TEST_DATABASE_ALLOW_REMOTE=1`. **No server → suites fail** with an actionable message (exit 1); the only skip is the explicit `CB_SKIP_DB_TESTS=1` (reported as skipped; CI never sets it). `DATABASE_URL` defaults to the local URL when unset.
10. **Security audit test** (`auditDatabaseSecurity`) runs on the migrated DB in every CI run: app roles' attributes and ownership, RLS on every `public` table (or allow-listed with reason), tenant policy on every `operator_id` table, no PUBLIC policies on tenant tables, views `security_invoker`, no unlisted matviews/SECURITY DEFINER functions. Proven to flag each kind of violation.

**Deviations / shared files touched**

- `packages/db/src/index.ts` (exports; not in the owned list but the package entry point), `packages/db/src/schema/index.ts` created (empty, shared append-only file), `packages/db/turbo.json` (`test.env`: `DATABASE_URL`, `CB_SKIP_DB_TESTS`, `CB_TEST_DATABASE_ALLOW_REMOTE`), `packages/db/tsconfig.json` (+`drizzle.config.ts`), `packages/db/vitest.config.ts` (timeouts), `packages/db/README.md`, `migrations/meta/*` (drizzle-kit journal/snapshot), and **root `biome.json`**: excluded `packages/db/migrations/meta` (drizzle-kit rewrites those JSON files without a trailing newline on every generate; they are generated outputs).
- Scope said roles + helper "RLS policy generator": implemented as Drizzle-native `pgPolicy` helpers (drizzle-kit emits `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY`), so policies live next to each table and migrations are generated, not hand-written.
- Versions: drizzle-orm 0.45.4, drizzle-kit 0.31.11, @neondatabase/serverless 1.2.0, pg 8.23.1 (+ dev: @types/pg 8.23.1, ws 8.22.0 / @types/ws 8.18.1 for the Neon-driver test proxy). drizzle-kit pulls deprecated `@esbuild-kit/*` (warning only).
- Neon's driver uses Node 24's global `WebSocket`; no `ws` at runtime.

**Follow-ups**

- **T-020a** (new task file): production non-owner runtime role (shape B) + boot check.
- T-021: extend `createTenant`; add platform policy on `operators`. T-036 (seed) and preview deploys: apply migrations with `db:migrate` (PLAN §17 gated workflow).

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17.11 = CI's major)

- `pnpm --filter @cb/db test`: 7 files, 52 tests, all DB suites run (no skips): RLS (tenant sees only own rows; A selecting/updating/deleting B's row by id → nothing, B's row unchanged; insert with B's operator_id or moving a row to B → 42501; app_rw without GUC → 0 rows; non-owner login role raw connection → 0 rows; withPlatform → 0 rows + insert rejected; no leak on a 1-connection pool after commit/rollback/error; rollback; savepoints; `TransactionFinishedError`; non-UUID rejected; isolation level/read-only passed through), Neon driver via a local WebSocket→TCP proxy (same checks), append-only trigger (UPDATE non-allowed/mixed blocked, allowed-only passes, no-op passes, DELETE/TRUNCATE blocked also for owner, error names columns not values, typo'd allowed column → 42703, INSERT ok), harness (security audit clean + detects 7 kinds of violations, foundation objects present, migrations apply twice to a fresh DB with pre-existing roles), UUIDv7 unit tests.
- Mutation checks (reverted): dropping the role switch → 7 RLS tests fail; session-level tenant setting → leak test fails.
- Without Postgres (`DATABASE_URL` on a closed port): suites fail, exit 1, "Cannot connect to Postgres at localhost:5999/cable_billing … set CB_SKIP_DB_TESTS=1". `CB_SKIP_DB_TESTS=1`: DB suites reported skipped.
- `db:migrate` + `db:check` against a scratch database; `db:generate` → "No schema changes".
- Root: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`: see the PR for the final run after rebase.

## Board log

- 2026-10-13T10:27:41.907Z claimed by agent-t020
- 2026-10-13T10:45:47.831Z completed on task/T-020-db-foundation-client-tenant-transactions

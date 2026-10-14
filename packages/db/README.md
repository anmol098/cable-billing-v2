# @cb/db

Postgres access for Cable Billing: Drizzle schema, drizzle-kit migrations, row-level security (RLS)
and the test harness. PLAN §7 (data model), §9.1 (tenant isolation), E-02, E-03.

**The rule:** every query runs inside `withTenant(operatorId, tx => …)` (one tenant, RLS on) or
`withPlatform(tx => …)` (cross-tenant jobs). There is no raw database handle.

## Security model

| Layer | What it does |
|---|---|
| `withTenant` | `BEGIN` → `select set_config('role','app_rw',true), set_config('app.operator_id',$1,true)` → your callback → `COMMIT`/`ROLLBACK`. Both settings are transaction-local, so they vanish at the end of the transaction: a pooled connection never carries a tenant (or the role) into the next transaction, also behind Neon's transaction-mode pooler. |
| `app_rw` role | NOLOGIN, no BYPASSRLS, owns nothing. Every tenant table has the policy `operator_id = app.current_operator()` (USING and WITH CHECK) for it. |
| `app.current_operator()` | `nullif(current_setting('app.operator_id', true), '')::uuid`. Unset or empty → NULL → **zero rows, no error**. Writes with no tenant, or with another tenant's `operator_id`, fail the WITH CHECK (SQLSTATE 42501). |
| `app_platform` role | For `withPlatform`. No BYPASSRLS. Tenant tables have no policy for it, so it sees **none** of their rows and can't write them (default deny). |
| Append-only trigger | `app.forbid_update_delete(allowed…)` blocks DELETE, TRUNCATE and UPDATE of non-allowed columns for every role, owner included. SQLSTATE `CB001`. |
| Composite FKs | `(operator_id, x_id) → x(operator_id, id)`: a row can't reference another tenant's row even if app code is wrong. |
| Security audit test | `src/testing/harness.test.ts` checks the migrated catalog: RLS on every table, tenant policy on every `operator_id` table, app roles own nothing and have no BYPASSRLS, views are `security_invoker`, no unlisted SECURITY DEFINER functions. New tables are checked automatically. |

### Who connects as whom (decision)

The app **never runs tenant queries as the table owner**. Tables are owned by the migration role;
every transaction switches to `app_rw` / `app_platform` with a transaction-local role change. We
did not rely on `FORCE ROW LEVEL SECURITY`: it doesn't bind superusers or `BYPASSRLS` roles, and we
don't control the owner role's attributes on managed Postgres (Neon); FORCE would also hide rows
from migrations and data fixes run as the owner.

- **Shape A (works today: CI, local, Neon previews).** `DATABASE_URL` is the owner role, a member of
  `app_rw` and `app_platform` (migration 0000 grants that). Isolation holds for everything that goes
  through `createDb`, which is the only query path @cb/db offers. A raw `pg` connection with this URL
  would bypass RLS, so app code must never open one.
- **Shape B (staging and production, T-020a).** Runtime `DATABASE_URL` uses a separate LOGIN role
  `cb_app` that is only a member of `app_rw` and `app_platform`, no BYPASSRLS, owns nothing; the
  owner URL is used only for migrations. Then even a raw connection that never set the tenant can't
  read tenant rows. Created with **NOINHERIT**, so a raw query has no table rights at all
  (`permission denied`); with INHERIT it would see zero tenant rows but every row of tables with an
  `app_platform` policy. Setup, verification and rotation: `docs/runbooks/environments.md` §4.12.
  ```sql
  CREATE ROLE cb_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    IN ROLE app_rw, app_platform;   -- then \password cb_app
  ```
  **Boot check:** `checkRuntimeRole(db)` → `{ ok, sessionUser, database, issues }` reports a
  superuser, BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION, owned objects (directly or via membership of
  the owner role), CREATE rights, a missing app-role membership (`cannot_assume_role`) and, as a
  warning, INHERIT. It never throws for a finding (only if the database can't be reached). Call it
  where shape B is expected (staging, production) and log/alert; previews (shape A) would fail it.
  Tested in `runtime-role.test.ts`.

### What `withPlatform` may do

Only cross-tenant work that has no tenant: list tenants and their subscription state, enqueue and
claim jobs, record webhook events. It may read/write a table only if that table has a policy for
`app_platform` (e.g. `operators` for listing tenants, added by the task that owns the table and
reviewed) or is a global table allow-listed without RLS. It can't see tenant rows. To work on a
tenant's data, list tenant ids in `withPlatform`, then call `withTenant` per tenant (PLAN §9.1).
Platform admin "support access" (T-086) is a separate, audited path: the admin opens a time-boxed
grant (`support_access_grants`, reason required, at most 2 hours by CHECK) in the **tenant's**
transaction together with a tenant audit event, and the support view then reads in `withTenant`
only while that grant is live (checked inside the same transaction on every request). Ending a
grant early is final (a trigger refuses clearing or moving `ended_at`/`ended_by`). See
`src/schema/platform-admin.ts` and the T-086 completion notes.

Platform policies that exist (T-021, each one reviewed):

| Table | `app_platform` may | Why |
|---|---|---|
| `operators` | SELECT | list tenants (jobs, admin console) |
| `users` | SELECT, INSERT, UPDATE | Better Auth sign-in / sign-up / profile (no tenant yet) |
| `sessions`, `accounts`, `verifications`, `two_factors` | ALL | Better Auth |
| `mobile_refresh_tokens` | SELECT | find a refresh token by hash before the tenant is known; rotate/revoke in `withTenant` |
| `subscriptions` | SELECT, UPDATE | state cron, webhooks, admin "extend" |
| `subscription_events` | SELECT, INSERT, UPDATE | Razorpay webhooks (append-only except processing columns) |
| `audit_events` | SELECT, INSERT where `operator_id IS NULL` | platform-level events only, never a tenant's |
| `jobs` (T-023) | SELECT, INSERT, UPDATE (no DELETE) | the job worker enqueues and claims every tenant's jobs (`FOR UPDATE SKIP LOCKED`), then works in `withTenant` |
| `receipt_links` (T-023) | SELECT | the public receipt page finds a link by token hash before the tenant is known; counting and revoking happen in `withTenant` |
| `support_access_grants` (T-086) | SELECT | the admin console lists who has support access where; grants are written and ended in the tenant's transaction |
| `subscription_offline_payments` (T-086) | SELECT | the admin console lists offline fee payments; written in the tenant's transaction with the subscription change |
| `customers` (T-086) | SELECT of `operator_id`, `status` **only** | customer counts per tenant (admin console) |
| `billing_runs` (T-086) | SELECT of ids, period, trigger, status, skip reason, counts, times (**no** `total_charges_paise`, `actor_id`) | job monitor, billing success rate (PRD §16) |
| `billing_run_items` (T-086) | SELECT of `operator_id`, `run_id`, `outcome`, `reason` **only** | billing exception rate by reason (PRD §16) |
| `invariant_checks` (T-086) | SELECT of everything but `samples` | nightly books-check status per tenant |
| `receipt_actions` (T-086) | SELECT of `operator_id`, `action`, `at` **only** | receipt action usage (PRD §16) |
| `collection_sessions` (T-086) | SELECT of `operator_id`, `status`, `business_date`, `discrepancy_reason` **only** | reconciliation discrepancy rate (PRD §16) |

**Column-limited platform reads (T-086).** For the six tenant tables marked "only" above, a
`USING (true)` SELECT policy lets `app_platform` see the rows, and a custom migration revokes the
table-wide SELECT the default privileges gave it and grants SELECT on the listed columns
(`PLATFORM_READ_COLUMNS` / `platformReadGrantsSql()` in `src/schema/platform-admin.ts`). So
`SELECT *`, names, phones, amounts, notes and per-customer ids are refused by the database
(`42501 permission denied`) on the platform path, whatever the application code does. A test
compares the catalog with `PLATFORM_READ_COLUMNS`. Adding a column to that list is a reviewed
decision, like adding a policy.

**The audit holds this table (T-086c).** `auditDatabaseSecurity`'s `platformRead` check compares
everything `app_platform` can read (a SELECT/ALL policy for it or PUBLIC, or RLS off, plus its
column privileges) with the `PLATFORM_READ` allow-list in `src/testing/harness.test.ts`: per
table, the columns (`"all"` or the exact list, taken from `PLATFORM_READ_COLUMNS`), the rows
(`"all"` or the exact USING filter) and the reason. A new platform or PUBLIC policy, an extra
column grant, a table-wide SELECT on a column-limited table or a widened row filter fails the
@cb/db suite until the list is updated in a reviewed PR. When you add a platform policy, add the
row to the table above and the entry to `PLATFORM_READ`.

## API

```ts
import { createDb, type Tx } from "@cb/db";

const db = createDb({ connectionString: process.env.DATABASE_URL! }); // one per process
// driver: "auto" (default) = Neon WebSocket Pool for *.neon.tech hosts, node-postgres otherwise.

const rows = await db.withTenant(ctx.operatorId, (tx) =>
  tx.select().from(customers).where(eq(customers.id, id)),
);
await db.withTenant(ctx.operatorId, async (tx) => { … }, { isolationLevel: "serializable" });
const tenantIds = await db.withPlatform((tx) => tx.select({ id: operators.id }).from(operators));
await db.end(); // scripts only
```

- `withTenant` validates `operatorId` as a UUID (TypeError otherwise). It must come from the server
  session/token (T-025's `TenantContext`), never from request input.
- Commit on resolve; rollback and rethrow on throw. Nested `tx.transaction()` = savepoint.
- Don't let `tx` escape the callback: using it afterwards throws `TransactionFinishedError`.
- Errors: drizzle wraps driver errors; `sqlStateOf(error)` reads the SQLSTATE through `cause`,
  `isImmutableRowError(error)` detects the append-only trigger. RLS write violations are `42501`.
- Don't change `role` or `app.operator_id` inside a callback.
- Ids: `uuidv7()` (monotonic within a process, time-ordered across processes, pure TS),
  `isUuid`, `isUuidV7`, `uuidV7Timestamp`, and the column helper `primaryId()`.

## Conventions for schema modules (T-021 onwards)

- **One file per module**: `src/schema/<module>.ts`, plus one export line in `src/schema/index.ts`
  (shared file, append only).
- **Ids**: `id: primaryId()` (uuid, UUIDv7 made in the app). Display numbers are never keys.
- **Tenant tables**: `operatorId: operatorIdColumn()`, `tenantKey(t)` (UNIQUE `(operator_id, id)`),
  `...tenantPolicies(t)`, and `.enableRLS()`. Every unique constraint that is per tenant includes
  `operator_id` first.
- **References between tenant tables** are composite:
  `foreignKey({ columns: [t.operatorId, t.customerId], foreignColumns: [customers.operatorId, customers.id] })`.
- **Money**: `bigint("…_paise", { mode: "number" })` (integer paise, never floats). `@cb/domain`'s
  `Paise` is a branded safe-integer `number` (T-024): convert reads with `toPaise(...)`.
- **Instants**: `timestamp("…_at", { withTimezone: true })` (timestamptz, UTC).
  **Business dates**: `date("…", { mode: "string" })` (`BusinessDate`, computed in Asia/Kolkata).
  **Billing period**: `date` (`Period`) with
  `check("…_period_first_day", sql\`extract(day from ${t.period}) = 1\`)`.
- **Legacy**: `legacy_source text`, `legacy_id text` on migrated tables.
- **Global tables** (no `operator_id`): enable RLS with explicit policies, or add the table to
  `ALLOW_WITHOUT_RLS` in `src/testing/harness.test.ts` with the reason (reviewed).
- **Views** must be `WITH (security_invoker = true)`; avoid materialized views and SECURITY DEFINER
  functions (the audit fails unless they're allow-listed with a reason).

```ts
// src/schema/tenancy.ts (sketch)
export const areas = pgTable(
  "areas",
  { id: primaryId(), operatorId: operatorIdColumn(), name: text("name").notNull() },
  (t) => [
    tenantKey(t),
    uniqueIndex("areas_operator_name_unique").on(t.operatorId, sql`lower(${t.name})`),
    ...tenantPolicies(t),
  ],
).enableRLS();
```

### Append-only tables

Triggers aren't in Drizzle's schema, so add them in a custom migration:

```bash
pnpm --filter @cb/db db:generate --custom --name=payments_append_only
```

and paste the SQL from `appendOnlyTriggerSql({ table: "payments", allowedColumns: ["review_status", "review_reason"] })`
(optionally `when: "OLD.status <> 'draft'"`). Test it with an UPDATE/DELETE that must fail
(`isImmutableRowError`).

## Migrations

| Command | What |
|---|---|
| `pnpm --filter @cb/db db:generate --name=<what>` | SQL from schema changes (drizzle-kit) into `migrations/` |
| `pnpm --filter @cb/db db:generate --custom --name=<what>` | Empty SQL file for triggers, functions, grants |
| `pnpm --filter @cb/db db:migrate` | Apply pending migrations to `DATABASE_URL_UNPOOLED` (else `DATABASE_URL`) |
| `pnpm --filter @cb/db db:check` | drizzle-kit consistency check of `migrations/meta` |

- Generate **last, right after rebasing** on `feature/mvp` (tasks/README.md §6). On a
  `meta/_journal.json` conflict, delete your generated files, rebase, regenerate.
- Never edit a migration that is already on `feature/mvp`.
- All migrations must run as the **same owner role** (the one that ran 0000): its default privileges
  give `app_rw`/`app_platform` access to new tables. The audit test fails if a table lacks them.
- Migration 0000 (`0000_foundation.sql`) creates: extension `btree_gist`; roles `app_rw` and
  `app_platform` (if missing; roles are cluster-wide); schema `app`; default privileges;
  `app.current_operator()`; `app.forbid_update_delete()`.
- Migrations run from a trusted workflow, never from the Vercel build (PLAN §17).

## Seed data (T-036)

`pnpm db:seed [--scale small|legacy|10x] [--seed N] [--as-of YYYY-MM-DD] [--migrate]` fills an
**empty**, migrated database (`DATABASE_URL_UNPOOLED`, else `DATABASE_URL`) with deterministic fake
tenants, customers, connections and months of bills and payments made with the `@cb/domain` rules.
Local hosts only unless `--allow-remote`; never production. `pnpm db:seed --help` for every option;
code and rules in `src/seed/` (`@cb/db/seed`); staging/preview use: `docs/runbooks/environments.md`
§4.13.

## Testing

DB integration tests run against a real Postgres 17 (CI: the `postgres:17` service; locally: the
server from `apps/web/.env.example`).

```ts
import { createTenant, describeDb, useTestDatabase } from "@cb/db/testing";

describeDb("areas", () => {
  const t = useTestDatabase(); // fresh migrated database for this file
  it("is tenant-scoped", async () => {
    const a = await createTenant(t.current);
    await t.current.db.withTenant(a.operatorId, async (tx) => { … });
  });
});
```

- `t.current.db`: the app client (shape A). `t.current.admin`: raw owner pool for seeding and
  checking rows (bypasses RLS; never use it to test isolation). `t.current.createLoginRole()`:
  a shape-B login role URL. `t.current.url`: this database's admin URL.
- `createTenant(t.current, { name? })` inserts an `operators` row (default settings) and returns
  `{ operatorId, name }`. `createUser(t.current, { operatorId, role?, login? })` inserts a user
  (no password; `operatorId: null` makes a platform admin) and returns `{ userId, operatorId, role, login }`.
- How it works: the first test file builds a template database `cb_tpl_<hash of migrations/>`
  (under an advisory lock), later files and runs clone it (`CREATE DATABASE … TEMPLATE`, ~100 ms),
  and each file's `cb_test_*` database is dropped afterwards. Leftovers older than 6 h are cleaned
  automatically; `pnpm --filter @cb/db db:test:clean` drops all harness databases and roles.
- Environment: `DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/cable_billing`)
  must be a local host with CREATEDB/CREATEROLE rights (`CB_TEST_DATABASE_ALLOW_REMOTE=1` to
  override). No server → the suites **fail** with a message saying how to fix it.
  `CB_SKIP_DB_TESTS=1` skips them explicitly (shown as skipped, never as passed; CI never sets it).
- **Other packages** using the harness (e.g. `@cb/core`): add `@cb/db` as a dependency and list
  `"DATABASE_URL", "CB_SKIP_DB_TESTS", "CB_TEST_DATABASE_ALLOW_REMOTE"` under `tasks.test.env` in the
  package's `turbo.json` (turbo strict env mode), as `packages/db/turbo.json` does.

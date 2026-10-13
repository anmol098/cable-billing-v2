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
- **Shape B (recommended for production, follow-up for H-01).** Runtime `DATABASE_URL` uses a
  separate LOGIN role that is only a member of `app_rw` and `app_platform`, no BYPASSRLS, owns
  nothing; the owner URL is used only as `DATABASE_URL_UNPOOLED` for migrations. Then even a raw
  connection that never set the tenant sees zero rows. Tested in `tenant.test.ts`. Setup:
  ```sql
  CREATE ROLE cb_app LOGIN PASSWORD '<generated>' INHERIT IN ROLE app_rw, app_platform;
  ```

### What `withPlatform` may do

Only cross-tenant work that has no tenant: list tenants and their subscription state, enqueue and
claim jobs, record webhook events. It may read/write a table only if that table has a policy for
`app_platform` (e.g. `operators` for listing tenants, added by the task that owns the table and
reviewed) or is a global table allow-listed without RLS. It can't see tenant rows. To work on a
tenant's data, list tenant ids in `withPlatform`, then call `withTenant` per tenant (PLAN §9.1).
Platform admin "support access" is a separate, audited path (not built yet).

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
- `createTenant(t.current)` returns `{ operatorId, name }`. **T-021** must extend it to insert the
  `operators` row once that table exists.
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

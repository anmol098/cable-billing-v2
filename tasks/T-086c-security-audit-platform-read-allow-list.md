---
id: T-086c
title: Security audit checks app_platform read policies and column grants against an allow-list
phase: 4
area: db
status: done
owner: agent-t086c
claimed_at: 2026-10-14T20:57:27.912Z
branch: task/T-086c-security-audit-checks-app-platform-read
depends_on: [T-086]
review: required
claimable_by: agent
size: S
paths: [packages/db/src/testing/security-audit.ts, packages/db/src/testing/harness.test.ts]
---

# T-086c — Security audit checks app_platform read policies and column grants against an allow-list

**Phase** 4 · **Area** db · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-086

## Goal

No tenant table can get platform read access unnoticed. A future `USING (true)` policy for
`app_platform`, or a table-wide or column SELECT grant to it, fails the @cb/db suite unless it is
on a reviewed allow-list.

## Scope

T-086 gave `app_platform` `USING (true)` SELECT policies on six tenant tables, plus column grants
limited to `PLATFORM_READ_COLUMNS` (`packages/db/src/schema/platform-admin.ts`).
`platform-admin.test.ts` checks those six tables. It does **not** look at other tables. A later
migration could add a platform policy to `payments` or `customers`. Because the default privileges
give `app_platform` table-wide SELECT on new tables, that policy alone opens every column.

- Extend `auditDatabaseSecurity` (`packages/db/src/testing/security-audit.ts`) with an option such
  as `platformRead: Record<table, { columns: readonly string[] | "all"; reason: string }>`:
  - every policy on a table with `operator_id` that applies to `app_platform` (or PUBLIC) must
    be on a listed table;
  - on a listed table, `app_platform`'s readable columns (`has_column_privilege`) must equal the
    listed columns. `"all"` is only for the T-086 tables the platform may read whole
    (`support_access_grants`, `subscription_offline_payments`);
  - on a table with `operator_id` and no platform policy, `app_platform` may still hold a
    privilege (RLS returns no rows), but it is reported if the table is also in no list. Decide
    and document.
- Pass the allow-list from `harness.test.ts`, built from `PLATFORM_READ_COLUMNS` plus the two
  whole-table entries, each with its reason.

## Out of scope

- Changing which columns the platform reads (that is a product/security review per table).

## Acceptance criteria

- [x] The suite fails, with a clear message, when a test migration adds
      `CREATE POLICY … TO app_platform USING (true)` to a tenant table not on the list, or
      grants an extra column on a listed one.
- [x] Today's database passes.

## Tests required

- Unit/integration tests of the new checks in the harness test (a scratch table with a platform
  policy is reported; adding it to the list clears it; an extra column grant is reported).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/testing/security-audit.ts`
- `packages/db/src/testing/harness.test.ts`

## References

PLAN §9.4, PRD §3; T-020 (security audit) and T-086 completion notes.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/db/src/testing/security-audit.ts` | Check 5 of `auditDatabaseSecurity`: option `platformRead: Record<table, PlatformReadRule>` with `PlatformReadRule = { columns: readonly string[] \| "all"; rows: "all" \| "<exact USING expression>"; reason: string }`. Omitted means empty (every readable table is reported). |
| `packages/db/src/testing/harness.test.ts` | `PLATFORM_READ`, the reviewed allow-list (20 tables), passed to the audit of the migrated database; the six column-limited entries are built from `PLATFORM_READ_COLUMNS` (columns) and `PLATFORM_READ_COLUMN_REASONS: Record<PlatformReadTable, string>` (a new `PLATFORM_READ_COLUMNS` entry fails typecheck until it has a reason). Four new tests. |
| `packages/db/README.md` | One paragraph under "Column-limited platform reads": the audit holds the platform-access table; add a policy → add the `PLATFORM_READ` entry. |

**How "readable by app_platform" is decided (from the catalog, not from names)**

- Relations of kind table / partitioned table / materialized view / foreign table, in any schema
  `app_platform` has USAGE on (system schemas excluded), where `has_any_column_privilege(SELECT)`
  is true (table-wide grants, column grants and role membership all count),
- **and** rows reach the role: RLS off (or no RLS at all, e.g. a matview), or a **permissive**
  `SELECT`/`ALL` policy (`pg_policy`) whose roles include PUBLIC (oid 0) or any role
  `app_platform` is a member of (`pg_has_role(..., 'MEMBER')`). Restrictive policies only narrow.
- Readable columns: `has_column_privilege` per live column. Row filter: `pg_get_expr(polqual)`.

**What it reports** (each message names the table, the policy and its USING, and the fix)

1. A readable table not on the list ("… is readable by app_platform (policy X USING true) but is
   not on the platform read allow-list …"; or "(row-level security is off)").
2. On a column-listed entry: a table-wide SELECT ("opens every column"), extra readable columns,
   and listed columns that aren't readable.
3. On a row-filtered entry: any applicable policy whose USING differs from the listed filter
   (e.g. a second `USING (true)` policy on `audit_events`), or RLS off.
4. An entry whose table app_platform can't read (stale list), and an entry with a blank reason.

**The allow-list as it stands** (verified against the live catalog of a freshly migrated database:
exactly these 20 tables are readable; no restrictive or PUBLIC policies; `app_platform` is a member
of no role; nothing readable outside `public`)

| Table | Columns | Rows | Reason |
|---|---|---|---|
| `accounts`, `sessions`, `two_factors`, `verifications` | all | all | T-021 Better Auth (sign-in before a tenant is known) |
| `users` | all | all | T-021 Better Auth sign-in / sign-up / profile |
| `operators` | all | all | T-021 list tenants |
| `subscriptions` | all | all | T-021 state cron, webhooks, admin extend |
| `subscription_events` | all | all | T-021 Razorpay webhooks |
| `audit_events` | all | `(operator_id IS NULL)` | T-021 platform-level events only |
| `jobs` | all | all | T-023 job worker |
| `mobile_refresh_tokens` | all | all | T-021 refresh by token hash before the tenant is known |
| `receipt_links` | all | all | T-023 public receipt page by token hash |
| `support_access_grants`, `subscription_offline_payments` | all | all | T-086 admin console lists |
| `customers`, `billing_runs`, `billing_run_items`, `invariant_checks`, `receipt_actions`, `collection_sessions` | exactly `PLATFORM_READ_COLUMNS` | all | T-086 aggregates (PRD §16) |

**Decisions**

- **Privilege without a policy is not reported** (the task's "decide and document"). The default
  privileges give `app_platform` table-wide SELECT on every new table, so all ~19 tenant tables
  with no platform policy (payments, invoices, ledger, …) hold it, and RLS returns no rows. Listing
  them would be noise. It stays safe because rows can only reach the role by a new
  platform/PUBLIC policy or by turning RLS off, and both make the table "readable", so it must be
  listed with its columns, and a table-wide SELECT is then reported unless the entry says `"all"`.
  Documented in the `security-audit.ts` header.
- **The list covers every readable table, not only tenant tables or T-086's** (coordinator's
  instruction: "any table or column readable by app_platform"). So the T-021/T-023 whole-table reads
  (`users`, `jobs`, …) are entries with `columns: "all"` and a reason. The task text said `"all"` is
  only for the two T-086 tables; that was written about T-086's tables, and the older ones
  legitimately read whole rows today (narrowing them is out of scope: follow-up T-086e).
- **`rows` is required** (not defaulted to `"all"`), so a row-filtered entry can't silently lose its
  filter; `audit_events`'s filter is now pinned, which nothing checked before.
- `"all"` columns means the whole row including future columns; no column check is done for it.
- The allow-list lives in `harness.test.ts` (owned path), not in `platform-admin.ts`, and reuses
  `PLATFORM_READ_COLUMNS` by reference (a test asserts the same arrays are used).

**Tests** (`harness.test.ts`, all against the migrated test database)

- The migrated database passes with `PLATFORM_READ` (and the list has exactly the 20 tables).
- A new tenant table: no platform policy → clean (privilege alone is fine); `CREATE POLICY … FOR
  SELECT TO app_platform USING (true)` → reported; listed `"all"` → clean; listed with columns →
  table-wide SELECT + extra columns reported; revoke + column grant → clean; unlisted → still
  reported; listed column not granted + blank reason → reported.
- Listed table: `GRANT SELECT (name, phone) ON customers` → extra columns reported; table-wide
  `GRANT SELECT ON billing_runs` → table-wide and `total_charges_paise` reported; restored → clean.
- A second `USING (true)` platform policy on `audit_events` → widened rows reported; a PUBLIC
  `USING (true)` policy, an RLS-off allow-listed global table, a policy to a role `app_platform`
  is a member of (unique scratch role, dropped after) → each reported; a stale entry → reported.
- Mutation check (`t086c-mutate.sh`, scratch): disabling each of membership, table-wide, row
  filter, extra column, stale entry, RLS-off and not-listed checks makes the suite fail (7/7).

**Follow-up (security finding, not changed here)**

- **T-086e** (created in this PR): `app_platform` reads **whole rows of `users`** for every tenant
  (team and lineman names, phones, emails, logins) because Better Auth's adapter runs on
  `withPlatform` and selects every column; also `jobs` (`payload`, `last_error`), `receipt_links`
  and `mobile_refresh_tokens` whole. No customer, payment, invoice or ledger data is readable.
  T-086e reviews whether to narrow these (column grants) or record them as accepted.

**Deviations / files outside the owned paths**

- `packages/db/README.md` (one paragraph) and the new task file `tasks/T-086e-*.md`.
- The coordinator mentioned a review finding "N6" of T-086; it is not in the repo or on PR #75, so
  the table list above was taken from the live catalog instead.

**Verification**

Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17, on `feature/mvp` 0c7c530 (after T-086b):

- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm build` (10/10),
  `pnpm generate` (no diff), `pnpm --filter @cb/db db:check`, `node scripts/tasks.mjs check --local`.
- `TURBO_FORCE=1 pnpm test --concurrency=1`: 10/10 packages green (`@cb/db` 273/273 incl.
  `harness.test.ts` 12, `@cb/core` 1257 + 3 skipped, `@cb/web` 565, others unchanged).
- Catalog listing of a freshly migrated scratch database (`has_any_column_privilege`,
  `pg_policies`, role memberships, non-`public` schemas) matched the 20-table list above.
- Mutation check: 7/7 mutants of the new check fail the harness test.

## Board log
- 2026-10-14T20:57:27.913Z claimed by agent-t086c
- 2026-10-14T21:18:19.164Z completed on task/T-086c-security-audit-checks-app-platform-read

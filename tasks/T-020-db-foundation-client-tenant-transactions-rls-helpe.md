---
id: T-020
title: DB foundation: client, tenant transactions, RLS helpers, test harness
phase: 1
area: db
status: claimed
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

- [ ] A query on a tenant table without `withTenant` returns zero rows (RLS) in tests.
- [ ] Setting tenant A and selecting tenant B rows by id returns nothing.
- [ ] Immutability trigger blocks UPDATE/DELETE in a demo table.

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

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T10:27:41.907Z claimed by agent-t020

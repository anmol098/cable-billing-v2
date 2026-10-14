---
id: T-086c
title: Security audit checks app_platform read policies and column grants against an allow-list
phase: 4
area: db
status: claimed
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

- [ ] The suite fails, with a clear message, when a test migration adds
      `CREATE POLICY … TO app_platform USING (true)` to a tenant table not on the list, or
      grants an extra column on a listed one.
- [ ] Today's database passes.

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

_The agent fills this in before opening the PR._

## Board log
- 2026-10-14T20:57:27.913Z claimed by agent-t086c

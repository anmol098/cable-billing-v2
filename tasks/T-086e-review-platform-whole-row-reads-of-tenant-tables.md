---
id: T-086e
title: Review app_platform's whole-row reads of tenant-scoped tables (users first)
phase: 4
area: db
status: todo
owner:
claimed_at:
branch:
depends_on: [T-086c]
review: required
claimable_by: agent
size: S
paths: [packages/db/src/schema/auth.ts, packages/db/src/schema/auth.test.ts, packages/db/src/testing/harness.test.ts]
---

# T-086e — Review app_platform's whole-row reads of tenant-scoped tables (users first)

**Phase** 4 · **Area** db · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-086c

## Goal

The platform role reads only the tenant-scoped columns it needs, or each whole-row read is a
recorded, reviewed decision.

## Scope

T-086c's security audit lists every table `app_platform` can read (`PLATFORM_READ` in
`packages/db/src/testing/harness.test.ts`). Six tables that have `operator_id` are readable
**whole, for every tenant** (`USING (true)` + table-wide SELECT), by T-021/T-023 design:

| Table | Tenant data the platform role can read today | Why it reads it |
|---|---|---|
| `users` | every tenant's team: `name`, `phone`, `email`, `login`, `display_login`, `image`, `language`, `status`, `role`, `legacy_*` | Better Auth sign-in / sign-up / profile (`packages/core/src/auth/adapter.ts` runs the Drizzle adapter on `withPlatform`, and it selects every schema column) |
| `jobs` | `payload`, `last_error`, `dedupe_key` of every tenant's jobs (payloads are ids only by convention, `packages/core/src/jobs/definition.ts`) | the job worker claims every tenant's jobs |
| `receipt_links` | `receipt_id`, `created_by`, `revoked_by`, access counts | public receipt page looks up a token hash |
| `mobile_refresh_tokens` | `user_id`, `device_id`, family/parent ids, token hash | refresh before the tenant is known |
| `subscriptions`, `subscription_events` | our own SaaS billing state and Razorpay payloads (the operator is our customer) | state cron, webhooks, admin extend |

`users` is the one that matters: tenant staff and linemen's names and phones are personal data,
and the platform path (Better Auth, admin console, jobs) can read all of them.

- Find which `users` columns each platform-path caller really reads (Better Auth adapter, the
  admin console's owner contact in `packages/core/src/admin/tenants.ts`, mobile auth, signup).
- Propose either a column grant (like `PLATFORM_READ_COLUMNS`) or a narrower design (e.g. Better
  Auth reading through a view or a smaller schema), or record "whole row accepted" with the reason
  in the README platform-access table.
- Same quick look for `jobs.last_error` (error text can hold tenant data) and `receipt_links`.
- Update the `PLATFORM_READ` entries to match whatever is decided.

## Out of scope

- Customers, payments, invoices and ledger (the platform role can't read them; T-086c's audit keeps
  it that way).

## Acceptance criteria

- [ ] Each whole-row tenant-scoped platform read is either narrowed (column grant, audit entry
      updated) or kept with the reviewed reason written down.
- [ ] Sign-in, sign-up, password reset, TOTP and mobile refresh still work (existing tests).

## Tests required

- The security audit (`harness.test.ts`) passes with the updated `PLATFORM_READ`.
- If columns are revoked: a test that `SELECT *` / a revoked column fails with 42501 on the
  platform path, and the auth suites in `@cb/core` stay green.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/schema/auth.ts` (+ test), a new custom migration if grants change
- `packages/db/src/testing/harness.test.ts` (`PLATFORM_READ` entries)

## References

PRD §3 (platform admin sees platform metadata only), PLAN §9.4; T-021, T-086, T-086c completion
notes; `packages/db/README.md` platform-access table.

## Completion notes

_The agent fills this in before opening the PR._

## Board log

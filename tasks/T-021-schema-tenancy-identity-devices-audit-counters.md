---
id: T-021
title: Schema: tenancy, identity, devices, audit, counters
phase: 1
area: db
status: claimed
owner: agent-t021
claimed_at: 2026-10-13T11:55:23.489Z
branch: task/T-021-schema-tenancy-identity-devices-audit-co
depends_on: [T-020]
review: required
claimable_by: agent
size: M
paths: [packages/db/src/schema/tenancy.ts, packages/db/src/schema/auth.ts, packages/db/src/schema/audit.ts, packages/db/src/schema/counters.ts, packages/db/src/schema/subscriptions.ts, packages/db/src/schema/index.ts, packages/db/migrations/**]
---

# T-021 — Schema: tenancy, identity, devices, audit, counters

**Phase** 1 · **Area** db · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-020

## Goal

Tables for tenants, users and the cross-cutting audit/counter infrastructure.

## Scope

- `operators` (duplicate names allowed; `settings` jsonb with typed Zod schema: mid_month_start_policy, invoice_prefix, receipt_footer, office_phone, default_language).
- Better Auth tables (user/session/account/verification) adapted: users have `operator_id` (nullable for platform admin), `role` enum owner|staff|lineman|platform_admin, globally unique lower-cased `login`, `language`, `status`.
- `devices` (install_id, device_code 3 chars unique per operator, revoked_at), mobile refresh tokens (hashed).
- `areas`, `counters` (+ `next_counter(operator, name)` SQL function using UPDATE…RETURNING), `audit_events`, `subscriptions` (state columns only; logic in T-085).
- RLS on all tenant tables; composite FKs.

## Acceptance criteria

- [ ] Two operators with identical names coexist (FR-002 test).
- [ ] Counter function is gap-free and safe under 50 concurrent calls.

## Tests required

- Constraint + concurrency integration tests.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/schema/tenancy.ts`
- `packages/db/src/schema/auth.ts`
- `packages/db/src/schema/audit.ts`
- `packages/db/src/schema/counters.ts`
- `packages/db/src/schema/subscriptions.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/migrations/**`

## References

PLAN §7.2 (operators, users, devices, areas, counters, audit_events, subscriptions), FR-002, FR-024, FR-025, D-15, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T11:55:23.489Z claimed by agent-t021

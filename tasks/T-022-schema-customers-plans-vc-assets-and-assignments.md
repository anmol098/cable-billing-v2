---
id: T-022
title: Schema: customers, plans, VC assets and assignments
phase: 1
area: db
status: claimed
owner: agent-t022
claimed_at: 2026-10-13T12:25:00.767Z
branch: task/T-022-schema-customers-plans-vc-assets-and-ass
depends_on: [T-021]
review: required
claimable_by: agent
size: M
paths: [packages/db/src/schema/customers.ts, packages/db/src/schema/connections.ts, packages/db/src/schema/plans.ts, packages/db/src/schema/index.ts, packages/db/migrations/**]
---

# T-022 — Schema: customers, plans, VC assets and assignments

**Phase** 1 · **Area** db · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-021

## Goal

Master data tables with the integrity rules enforced by the database.

## Scope

- `customers` with `customer_code_norm` and UNIQUE (operator_id, customer_code_norm); `customer_contact_changes`.
- `plans` (monthly_amount_paise, status active|retired).
- `vc_assets` UNIQUE (operator_id, vc_number_norm); `vc_assignments` with the GiST EXCLUDE constraint preventing overlapping date ranges for the same asset; `assignment_events`.
- Search indexes: trigram (pg_trgm) on name, btree on code/phone/vc_number_norm.
- `legacy_source`, `legacy_id` columns on migrated tables.

## Acceptance criteria

- [ ] Same customer code allowed across operators, rejected within one (PRD §15 #2).
- [ ] Overlapping assignment for the same VC is rejected by the DB; sequential reuse is accepted (PRD §15 #6).

## Tests required

- Integration tests for both constraints and cross-tenant composite FK rejection.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/schema/customers.ts`
- `packages/db/src/schema/connections.ts`
- `packages/db/src/schema/plans.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/migrations/**`

## References

PLAN §7.2, FR-003, FR-004, FR-005, FR-006, FR-007, RULE-02, RULE-06, BR-03 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T12:25:00.767Z claimed by agent-t022

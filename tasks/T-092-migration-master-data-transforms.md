---
id: T-092
title: Migration: master data transforms
phase: 5
area: migration
status: todo
owner:
claimed_at:
branch:
depends_on: [T-091, T-022, T-027]
review: required
claimable_by: agent
size: L
paths: [tools/migration/src/transform/master/**]
---

# T-092 — Migration: master data transforms

**Phase** 5 · **Area** migration · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-091, T-022, T-027

## Goal

Operators, users, customers, VCs and current assignments imported with full traceability.

## Scope

- Tenants via provisionTenant by op_id (never merge by name).
- Customers (duplicate codes → exceptions), VC assets + known current assignment flagged history_limited, linemen as users with forced reset unless hash verified.
- `legacy_id_map` + `migration_exceptions` for every skipped/transformed row; idempotent re-runs.

## Acceptance criteria

- [ ] Re-running produces no duplicates; every source row is either mapped or in exceptions.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/migration/src/transform/master/**`

## References

PLAN §15 step 3, FR-026, FR-027, RULE-21, BR-14 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

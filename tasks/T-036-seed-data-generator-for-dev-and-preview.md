---
id: T-036
title: Seed data generator for dev and preview
phase: 1
area: db
status: todo
owner:
claimed_at:
branch:
depends_on: [T-023, T-024]
review: self
claimable_by: agent
size: M
paths: [packages/db/src/seed/**, packages/db/package.json]
---

# T-036 — Seed data generator for dev and preview

**Phase** 1 · **Area** db · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-023, T-024

## Goal

Realistic fake data so UI and performance work don't need the legacy dump.

## Scope

- `pnpm db:seed --scale small|legacy|10x`: operators (incl. two with the same name), areas, plans, customers with Indian names (Hindi + English), VCs incl. reused VCs, 12 months of invoices/payments/adjustments generated through domain functions where available (fallback: direct inserts marked TODO).
- Deterministic with a seed value; never uses real personal data.
- Neon preview branches run `small` automatically (document in environments runbook).

## Acceptance criteria

- [ ] `legacy` scale ≈ 8 operators / 7.6k customers / 146k invoices finishes in < 3 min locally.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/seed/**`
- `packages/db/package.json`

## References

PRD §11 (scale), PRD Appendix A — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

---
id: T-024
title: Domain foundations: money, periods, business dates
phase: 1
area: domain
status: todo
owner:
claimed_at:
branch:
depends_on: [T-001]
review: self
claimable_by: agent
size: S
paths: [packages/domain/src/money/**, packages/domain/src/time/**, packages/domain/src/result.ts, packages/domain/src/index.ts]
---

# T-024 — Domain foundations: money, periods, business dates

**Phase** 1 · **Area** domain · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-001

## Goal

Pure helpers everyone uses for money and time, so nobody re-invents them.

## Scope

- Money: paise as `bigint`-safe integers (use `number` with safe-integer guard or branded type – document choice), `rupeesToPaise` (whole rupees only, D-17), `formatINR` (Indian grouping, en/hi), parse from user input.
- Time: IST business date from an instant, `periodOf(date)` (1st of month), `nextPeriod`, `periodLabel` (en/hi month names), billing day helpers.
- `Result<T, E>` type + error code union base.

## Acceptance criteria

- [ ] No floating-point arithmetic on money anywhere in the package.

## Tests required

- Unit + fast-check property tests (round-trips, grouping for 0…10^12, IST boundary at 18:30 UTC).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/money/**`
- `packages/domain/src/time/**`
- `packages/domain/src/result.ts`
- `packages/domain/src/index.ts`

## References

PLAN §7.1, D-17, PRD §12 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

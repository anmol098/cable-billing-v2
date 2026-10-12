---
id: T-062
title: Collection sessions, cash handover and web Linemen page
phase: 3
area: web
status: todo
owner:
claimed_at:
branch:
depends_on: [T-046, T-029]
review: self
claimable_by: agent
size: M
paths: [packages/core/src/collections/**, apps/web/src/app/(operator)/linemen/**, packages/i18n/messages/*/linemen.json]
---

# T-062 — Collection sessions, cash handover and web Linemen page

**Phase** 3 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-046, T-029

## Goal

Owner/staff see each lineman's cash and UPI per day and accept handovers.

## Scope

- Services: session totals, submit handover (discrepancy reason codes + note), accept, return with note (all audited).
- Linemen page: day picker, per-lineman cards (cash, UPI, count, handover status, unsynced warning from device last-seen), review screen with Accept/Return.

## Acceptance criteria

- [ ] Expected cash excludes UPI; discrepancy computed server-side.

## Tests required

- Service + isolation tests; Playwright accept flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/collections/**`
- `apps/web/src/app/(operator)/linemen/**`
- `packages/i18n/messages/*/linemen.json`

## References

PLAN §8.7, FR-022, J-05, B-016 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

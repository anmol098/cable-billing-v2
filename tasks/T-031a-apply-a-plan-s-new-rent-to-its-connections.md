---
id: T-031a
title: Apply a plan's new rent to its connections
phase: 2
area: core
status: todo
owner:
claimed_at:
branch:
depends_on: [T-031, T-045]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/plans/apply-rent/**, apps/web/src/app/(operator)/settings/plans/_apply-rent/**]
---

# T-031a — Apply a plan's new rent to its connections

**Phase** 2 · **Area** core · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-031, T-045

## Goal

After changing a plan's rent, the Owner can move the plan's connections to the new rent from next month in one step.

## Scope

- **Product owner decision first** (raised by T-031): should a plan's new rent be offered for its existing connections at all, and from which month (the T-031 scope said "Apply to existing connections from next month?")? Until then T-031 only says how many connections keep the old rent.
- A bulk action on Settings → Plans: "Use ₹{new} for these {n} connections from {next month}?" with the count and the month, Owner only, audited.
- Each connection gets an ordinary plan change (T-034 `changePlanInTx`, T-045 hook), effective the 1st of the next month, so nothing already billed changes (FR-007, PLAN §8.3). Connections whose rent already equals the plan's are skipped.
- One transaction per connection (or small batches) through the job queue if the count is large; a report of changed / skipped / failed.

## Out of scope

- Changing issued bills (never).
- Plans themselves (T-031).

## Acceptance criteria

- [ ] Only connections still on the plan (active or stopped) are changed; removed ones are untouched.
- [ ] No bill already made changes; the new rent shows on the next month's bill.
- [ ] Each change appears in the connection's "What happened" list and in the audit log.

## Tests required

- Service tests with the real billing run; isolation cases; a component test of the confirm sheet.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/plans/apply-rent/**`
- `apps/web/src/app/(operator)/settings/plans/_apply-rent/**`

## References

FR-007, BR-07, PLAN §8.3, T-031 and T-045 completion notes — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR._

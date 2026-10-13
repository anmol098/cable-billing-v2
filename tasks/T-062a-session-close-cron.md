---
id: T-062a
title: Session-close cron (flag unsubmitted handovers)
phase: 3
area: core
status: todo
owner:
claimed_at:
branch:
depends_on: [T-062, T-043]
review: self
claimable_by: agent
size: S
paths: [packages/core/src/collections/session-close/**, apps/web/src/app/api/cron/session-close/**]
---

# T-062a — Session-close cron (flag unsubmitted handovers)

**Phase** 3 · **Area** core · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-062, T-043

## Goal

After each IST business day, the office learns which linemen still hold that day's cash.

## Scope

- Replace the T-043 stub `apps/web/src/app/api/cron/session-close/route.ts` (`cronStub("session_close", "T-062")`)
  with a real `cronRoute` handler (PLAN §14 `session-close`, `0 19 * * *` = 00:30 IST): for every tenant,
  in its own `withTenant` transaction, list the previous IST day's `collection_sessions` that are still
  `open` or `returned` with cash expected > 0 (the "unsubmitted handovers").
- Decide with the product owner what "flag" means before building it (open question from T-062):
  a row in a per-tenant table read by the Home alerts (T-083), an email to the Owner, or only a count in
  the cron log. The totals need no snapshot: `collection_sessions` already holds the running totals and
  `handover_events` the submitted snapshots (T-062), and the Linemen page shows any past day.
- Isolation cases for any new tenant service; the route answers with counts only (no names, no PII).

## Out of scope

- Changing how totals are computed (T-046 / T-062).
- Notifications to linemen.

## Acceptance criteria

- [ ] Running the job twice for the same day flags each unsubmitted handover once (idempotent).
- [ ] A day whose handover was submitted or accepted is never flagged.

## Tests required

- Service tests with an injected clock (IST midnight edges), route test like `api/cron/invariants/route.test.ts`.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/collections/session-close/**`
- `apps/web/src/app/api/cron/session-close/**`

## References

PLAN §14 (`session-close`), PLAN §8.7, FR-022, T-062 completion notes — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR._

---
id: T-061
title: Mobile API: payment batch, collections, handover, receipts
phase: 3
area: api
status: claimed
owner: agent-t061
claimed_at: 2026-10-13T19:32:56.618Z
branch: task/T-061-mobile-api-payment-batch-collections-han
depends_on: [T-028, T-046, T-050, T-062]
review: required
claimable_by: agent
size: M
paths: [apps/web/src/app/api/mobile/v1/payments/**, apps/web/src/app/api/mobile/v1/collections/**, apps/web/src/app/api/mobile/v1/receipts/**]
---

# T-061 — Mobile API: payment batch, collections, handover, receipts

**Phase** 3 · **Area** api · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-028, T-046, T-050, T-062

## Goal

Thin adapters from the contract to core services, with per-item batch results.

## Scope

- `POST /payments:batch` (≤50 items, each through postPayment; outcomes posted|duplicate|posted_needs_review|rejected).
- `GET /collections/{date}`, `POST /collections/{date}/handover`.
- `POST /receipts/{paymentId}/link`, `POST /receipts/actions:batch` (observable actions only).

## Acceptance criteria

- [ ] Replaying the same batch 10× concurrently yields identical results and no duplicates.
- [ ] Payments still accepted when tenant is read_only (D-13).

## Tests required

- Integration + contract tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/api/mobile/v1/payments/**`
- `apps/web/src/app/api/mobile/v1/collections/**`
- `apps/web/src/app/api/mobile/v1/receipts/**`

## References

PLAN §10.2, PLAN §10.4, FR-015, FR-016, FR-019, FR-020, FR-022 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T19:32:56.618Z claimed by agent-t061

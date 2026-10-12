---
id: T-060
title: Mobile API: roster sync, customer detail, phone update
phase: 3
area: api
status: todo
owner:
claimed_at:
branch:
depends_on: [T-028, T-033, T-034, T-023]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/api/mobile/v1/sync/**, apps/web/src/app/api/mobile/v1/customers/**, packages/core/src/mobile-sync/**]
---

# T-060 — Mobile API: roster sync, customer detail, phone update

**Phase** 3 · **Area** api · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-028, T-033, T-034, T-023

## Goal

Phones hold the whole tenant roster and stay fresh cheaply.

## Scope

- `GET /sync/customers?cursor=` delta with tombstones, gzip, page size 500.
- `GET /customers/{id}` fresh detail with open bills and last payments.
- `PATCH /customers/{id}/phone` audited with source android.

## Acceptance criteria

- [ ] Full roster for 1k customers < 1 MB gzipped.
- [ ] Responses validate against `@cb/contracts`.

## Tests required

- Integration + contract tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/api/mobile/v1/sync/**`
- `apps/web/src/app/api/mobile/v1/customers/**`
- `packages/core/src/mobile-sync/**`

## References

PLAN §10.3, FR-004, B-012 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

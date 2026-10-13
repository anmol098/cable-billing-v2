---
id: T-033
title: Customers: services, list, search, add, profile summary
phase: 1
area: web
status: claimed
owner: agent-t033
claimed_at: 2026-10-13T15:52:41.844Z
branch: task/T-033-customers-services-list-search-add-profi
depends_on: [T-029, T-022, T-025]
review: self
claimable_by: agent
size: L
paths: [packages/core/src/customers/**, apps/web/src/app/(operator)/customers/page.tsx, apps/web/src/app/(operator)/customers/new/**, apps/web/src/app/(operator)/customers/[id]/page.tsx, apps/web/src/app/(operator)/customers/[id]/summary/**, apps/web/src/app/(operator)/customers/_components/**, packages/i18n/messages/*/customers.json]
---

# T-033 — Customers: services, list, search, add, profile summary

**Phase** 1 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-029, T-022, T-025

## Goal

Office staff can find, add and edit customers easily.

## Scope

- Services: create/edit/deactivate, code normalisation + optional auto-code from counter, phone change audit (`customer_contact_changes`, source web), search by code/name (trigram)/phone/VC number with ranking.
- List page: search box, area/status filters, DataTable (code, name, area, due, status).
- Add-customer Stepper step 1 (Customer) and step 3 (Check & save); step 2 slot left for T-034.
- Profile shell with tabs (Summary implemented; Connections/Bills/Payments/History tabs are placeholders for T-034/T-048/T-049) and a 'Take payment' button placeholder.

## Acceptance criteria

- [ ] Duplicate code in same tenant shows a friendly inline error.
- [ ] Search returns results < 300 ms on 10k customers (seed).

## Tests required

- Service + isolation tests; Playwright add + search.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/customers/**`
- `apps/web/src/app/(operator)/customers/page.tsx`
- `apps/web/src/app/(operator)/customers/new/**`
- `apps/web/src/app/(operator)/customers/[id]/page.tsx`
- `apps/web/src/app/(operator)/customers/[id]/summary/**`
- `apps/web/src/app/(operator)/customers/_components/**`
- `packages/i18n/messages/*/customers.json`

## References

FR-003, FR-004, RULE-02, PLAN §12.1, PLAN §12.2 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T15:52:41.844Z claimed by agent-t033

---
id: T-047
title: Bills UI: runs, preview, register, detail, printable bill
phase: 2
area: web
status: claimed
owner: agent-t047
claimed_at: 2026-10-13T19:32:52.461Z
branch: task/T-047-bills-ui-runs-preview-register-detail-pr
depends_on: [T-044, T-029]
review: self
claimable_by: agent
size: L
paths: [apps/web/src/app/(operator)/bills/page.tsx, apps/web/src/app/(operator)/bills/runs/**, apps/web/src/app/(operator)/bills/register/**, apps/web/src/app/(operator)/bills/[id]/**, apps/web/src/components/bills/**, packages/i18n/messages/*/bills.json]
---

# T-047 — Bills UI: runs, preview, register, detail, printable bill

**Phase** 2 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-044, T-029

## Goal

Owners understand and control the monthly bill run without jargon.

## Scope

- Month calendar with run status per month; 'Preview this month' (Staff/Owner) with plain summary + problem list; 'Run now' / 'Retry problems' (Owner).
- Missed bill runs card after reactivation (manual only).
- Bill register (filters: month, area, status) and bill detail (lines per VC, adjustments, payments allocated, balance).
- Printable A5 bill (print CSS or PDF) in operator language.

## Acceptance criteria

- [ ] Staff cannot see Run/Retry buttons; server enforces too.

## Tests required

- Playwright: preview → run → open bill.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/bills/page.tsx`
- `apps/web/src/app/(operator)/bills/runs/**`
- `apps/web/src/app/(operator)/bills/register/**`
- `apps/web/src/app/(operator)/bills/[id]/**`
- `apps/web/src/components/bills/**`
- `packages/i18n/messages/*/bills.json`

## References

PLAN §12.1, J-03, FR-009, FR-011 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T19:32:52.461Z claimed by agent-t047

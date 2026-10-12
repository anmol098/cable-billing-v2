---
id: T-086
title: Platform admin console
phase: 4
area: web
status: todo
owner:
claimed_at:
branch:
depends_on: [T-026, T-043, T-085]
review: required
claimable_by: agent
size: L
paths: [apps/web/src/app/admin/**, packages/core/src/admin/**, packages/i18n/messages/*/admin.json]
---

# T-086 — Platform admin console

**Phase** 4 · **Area** web · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-026, T-043, T-085

## Goal

We can run the SaaS without touching the database by hand.

## Scope

- Tenants list/detail (status, trial/subscription, counts, last activity), create tenant (uses provisionTenant), extend/record offline payment (audited).
- Job monitor (billing runs across tenants, failures, retry), Razorpay event log, platform audit log, metrics from PRD §16.
- Support access: time-boxed (2h), reason required, visible in tenant audit log; no routine access to tenant financial data.

## Acceptance criteria

- [ ] All admin routes require platform_admin + 2FA.

## Tests required

- Integration tests for support-access expiry and audit.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/admin/**`
- `packages/core/src/admin/**`
- `packages/i18n/messages/*/admin.json`

## References

PLAN §12.4, PLAN §9.4, PRD §3 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

---
id: T-027
title: Self sign-up and tenant provisioning
phase: 1
area: web
status: claimed
owner: agent-t027
claimed_at: 2026-10-13T14:30:29.073Z
branch: task/T-027-self-sign-up-and-tenant-provisioning
depends_on: [T-026, T-007]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(auth)/signup/**, apps/web/src/app/(auth)/verify/**, packages/core/src/tenants/**, packages/i18n/messages/*/signup.json]
---

# T-027 — Self sign-up and tenant provisioning

**Phase** 1 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-026, T-007

## Goal

An operator can create their own account and start a 30-day trial.

## Scope

- Sign-up form: business name, owner name, mobile, email, password; Turnstile; rate limit.
- Email verification; on verify, transaction creates operator + owner user + `subscriptions` (trialing, trial_ends_at = +30 days) + counters + default settings.
- `provisionTenant()` service is reusable by the admin console and migration (no email step there).

## Acceptance criteria

- [ ] Unverified accounts cannot sign in.
- [ ] Provisioning is idempotent on retry.

## Tests required

- Integration test of provisioning; Playwright sign-up → verify (email captured via test transport) → home.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(auth)/signup/**`
- `apps/web/src/app/(auth)/verify/**`
- `packages/core/src/tenants/**`
- `packages/i18n/messages/*/signup.json`

## References

D-15, D-20, PLAN §12.3 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T14:30:29.075Z claimed by agent-t027

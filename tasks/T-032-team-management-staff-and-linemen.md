---
id: T-032
title: Team management (staff and linemen)
phase: 1
area: web
status: todo
owner:
claimed_at:
branch:
depends_on: [T-029, T-028]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/settings/team/**, packages/core/src/team/**, packages/i18n/messages/*/team.json]
---

# T-032 — Team management (staff and linemen)

**Phase** 1 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-029, T-028

## Goal

Owner adds staff and linemen, resets lineman passwords and signs out lost phones.

## Scope

- Add staff (email + temp password or invite email) and lineman (login suggestion = mobile number, simple password, show-password).
- 'Share login on WhatsApp' button (wa.me link with login + app link; password NOT included).
- Reset lineman password (Owner sets new), deactivate user, list lineman phones (model, last seen, app version) with 'Sign out this phone'.

## Acceptance criteria

- [ ] Deactivated lineman's refresh fails; queued payments still accepted with review flag (contract with T-061).

## Tests required

- Service tests + isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/team/**`
- `packages/core/src/team/**`
- `packages/i18n/messages/*/team.json`

## References

D-07, D-16, PLAN §11.6 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

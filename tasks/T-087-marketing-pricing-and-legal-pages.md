---
id: T-087
title: Marketing, pricing and legal pages
phase: 4
area: web
status: claimed
owner: agent-t087
claimed_at: 2026-10-13T15:27:46.680Z
branch: task/T-087-marketing-pricing-and-legal-pages
depends_on: [T-007]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(marketing)/**, packages/i18n/messages/*/marketing.json]
---

# T-087 — Marketing, pricing and legal pages

**Phase** 4 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-007

## Goal

Public pages needed for sign-up, Razorpay and the Play Store listing.

## Scope

- Landing (what it does, in plain words), pricing (₹400 + GST/month, unlimited customers, 30-day free trial), privacy policy and terms drafts (clearly marked for legal review), contact.
- Hyper-minimal, bilingual, fast on 3G.

## Acceptance criteria

- [ ] Lighthouse mobile performance ≥ 90.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(marketing)/**`
- `packages/i18n/messages/*/marketing.json`

## Notes

- Legal text must be reviewed by a human before launch.

## References

D-15, D-19, D-21, D-22 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T15:27:46.681Z claimed by agent-t087

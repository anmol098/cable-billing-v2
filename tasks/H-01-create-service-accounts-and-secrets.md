---
id: H-01
title: Create service accounts and secrets
phase: 0
area: human
status: todo
owner:
claimed_at:
branch:
depends_on: [T-011]
review: self
claimable_by: human
size: M
paths: [(external accounts)]
---

# H-01 — Create service accounts and secrets

**Phase** 0 · **Area** human · **Size** M · **Review** self · **Claimable by** human · **Depends on** T-011

## Goal

Accounts agents cannot create.

## Scope

- Vercel Pro team + project, Neon project (closest India region) + Vercel integration, Sentry, Resend, Upstash, Cloudflare Turnstile, Razorpay (test + live), Google Play Console, backup bucket.
- Add secrets to Vercel envs and GitHub environments as listed in `.env.example`.

## Acceptance criteria

- [ ] Preview deployment of the integration branch works with a Neon branch.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `(external accounts)`

## References

PLAN §17, docs/runbooks/environments.md — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

---
id: T-095a
title: Capacity run on a Vercel preview and Neon branch
phase: 5
area: qa
status: todo
owner:
claimed_at:
branch:
depends_on: [T-095]
review: self
claimable_by: agent
size: S
paths: [tools/load/**, docs/testing/performance.md, .github/workflows/load.yml]
---

# T-095a — Capacity run on a Vercel preview and Neon branch

**Phase** 5 · **Area** qa · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-095 (and H-01: Vercel, Neon, Upstash accounts)

## Goal

Measure the T-095 performance budget on real infrastructure at legacy and 10× scale, and record the result.

## Scope

- Follow `docs/testing/performance.md` §4: a `load/<date>` preview with its own Neon branch seeded `legacy`
  (then `10x`) with last month as "today", `CRON_SECRET` and non-prod Upstash on the preview.
- `pnpm load run --profile legacy --gate`, then `10x` (warm the sign-in cache first), from a machine near
  Singapore if possible; paste both `summary.md` into §6 of the doc.
- Add `.github/workflows/load.yml` from the doc (`workflow_dispatch` only, secrets in the `load-test`
  environment, `LOAD_FORBIDDEN_HOSTS` set to the production host).
- One follow-up task per failed budget line (metric, numbers, suspected query or route). Watch
  `/payments:batch` (local smoke: 50-item batches near T-061's 30 s budget with 60 phones at once) and
  `/receipts/actions:batch`.

## Out of scope

- Fixing what the run finds (separate tasks), production load tests (never).

## Acceptance criteria

- [ ] T-095's criterion: p95 < 2 s for the listed operations at `10x`, with the report committed in
  `docs/testing/performance.md` §6 (or follow-up tasks for every failed line).
- [ ] The billing run at legacy and 10× size meets B-BILLING-RUN (or a follow-up task explains why not).
- [ ] The manual CI workflow exists and has run once.

## Tests required

- None new; the tool's own tests stay green.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/load/**`, `docs/testing/performance.md`, `.github/workflows/load.yml`

## References

PRD §11, T-095 completion notes, `docs/testing/performance.md`, `docs/runbooks/environments.md` §4.

## Completion notes

_The agent fills this in before opening the PR._

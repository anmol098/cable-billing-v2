---
id: T-086f
title: Rate-limit payment sync and decide retention for the sync metric tables
phase: 4
area: core
status: todo
owner:
claimed_at:
branch:
depends_on: [T-086a]
review: required
claimable_by: agent
size: S
paths: [apps/web/src/app/api/mobile/v1/payments/_lib/**, packages/core/src/sync-metrics/**]
---

# T-086f — Rate-limit payment sync and decide retention for the sync metric tables

**Phase** 4 · **Area** core · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-086a

## Goal

One lineman's token can't flood the database or skew the PRD §16 sync figures, and the
T-086a tables don't grow without limit.

## Scope

- **Rate limit `/payments:batch`** per device or per user, using the existing `RateLimiter`
  (`@cb/core` auth, `getRateLimiter()` in `apps/web/src/lib/auth/server.ts`). Over the limit, the
  answer is 429 `RATE_LIMITED` with `retry_after_seconds`, and nothing is posted or counted. The
  phone already treats this as "send again later". Choose a limit that still lets a full day's
  queue (many batches of 50) sync after a long offline period.
  - Found in the T-086a review: with fresh UUIDs, 4 requests wrote 200 permanent
    `payment_sync_rejections` rows and 0 payments. They also skew that tenant's rate and
    duplicate count.
- **Retention decision (product owner first)** for `payment_sync_batches` (counts) and
  `payment_sync_rejections` (one row per refused payment id: effectively a per-id refusal log, no
  PII). Implement one of these:
  - a reviewed purge job for rows older than N days (both tables are append-only, so it needs a
    narrow, reviewed exception such as a SECURITY DEFINER function allow-listed in the security
    audit, or a dedicated role); or
  - monthly partitions that are dropped.
  - The 30-day console window needs at least 31 days of `payment_sync_batches`. A refusal key
    that is dropped only means a very late replay counts as a new refusal.

## Out of scope

- Changing what is counted (T-086a), or the T-061 wire contract.

## Acceptance criteria

- [ ] `/payments:batch` refuses requests over the limit with 429 `RATE_LIMITED` and writes
      nothing.
- [ ] The retention decision is recorded (completion notes and `packages/db/README.md`), and
      rows older than it are removed by a reviewed path, or partitions are dropped.

## Tests required

- Handler test: requests over the limit get 429 with nothing posted or counted; requests under
  the limit pass.
- Purge or partition test: old rows go, recent rows stay, and the append-only triggers still
  refuse every other UPDATE or DELETE.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/api/mobile/v1/payments/_lib/**`
- `packages/core/src/sync-metrics/**`

## References

PRD §16, PLAN §9.4 ("mobile sync" rate limit), T-061 and T-086a completion notes.

## Completion notes

_The agent fills this in before opening the PR._

## Board log

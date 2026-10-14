---
id: T-086a
title: Record payment sync attempts and duplicates for the PRD §16 metrics
phase: 4
area: core
status: claimed
owner: agent-t086a
claimed_at: 2026-10-14T21:32:13.218Z
branch: task/T-086a-record-payment-sync-attempts-and-duplica
depends_on: [T-086]
review: required
claimable_by: agent
size: S
paths: [packages/core/src/admin/metrics.ts, packages/core/src/sync-metrics/**]
---

# T-086a — Record payment sync attempts and duplicates for the PRD §16 metrics

**Phase** 4 · **Area** core · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-086

## Goal

The admin console shows the two PRD §16 field metrics it says are "not measured yet": payment sync
success rate and duplicate prevention count.

## Scope

- Count, per tenant and IST day, mobile payment batch attempts, payments accepted, idempotent
  replays (`duplicate`) and refusals by code, where T-061's `/payments:batch` handler and T-046's
  posting service already know them (a small counters table, append-only or upsert-by-day; no PII,
  no amounts).
- A reviewed `app_platform` column grant for it (see `PLATFORM_READ_COLUMNS` in
  `packages/db/src/schema/platform-admin.ts`) and the two numbers in `platformMetrics`.
- Migration exception count once T-092 stores its exception rows (or leave "not measured").

## Out of scope

- Per-payment logs or anything with amounts, names or phone numbers.

## Acceptance criteria

- [ ] `/admin` shows a sync success rate (accepted ÷ attempts, deduplicated by payment id) and a
      duplicate count for the last 30 days instead of "Not measured yet".

## Tests required

- Integration test: a batch with new, replayed and refused payments moves the counters exactly once
  per payment id; the platform reads only the counters.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/admin/metrics.ts`
- `packages/core/src/sync-metrics/**`

## References

PRD §16, PLAN §10.4, T-086 completion notes.

## Completion notes

_The agent fills this in before opening the PR._

## Board log
- 2026-10-14T21:32:13.219Z claimed by agent-t086a

---
id: T-085
title: Razorpay subscription and read-only mode
phase: 4
area: core
status: claimed
owner: agent-t085
claimed_at: 2026-10-14T04:25:41.531Z
branch: task/T-085-razorpay-subscription-and-read-only-mode
depends_on: [T-025, T-043, T-029]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/subscriptions/**, apps/web/src/app/api/webhooks/razorpay/**, apps/web/src/app/api/cron/subscription-states/**, apps/web/src/app/(operator)/settings/subscription/**, packages/i18n/messages/*/subscription.json]
---

# T-085 — Razorpay subscription and read-only mode

**Phase** 4 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-025, T-043, T-029

## Goal

Operators pay ₹400 + GST/month online; access follows subscription state.

## Scope

- Config-driven plan (₹400 + 18% GST = ₹472; RAZORPAY_PLAN_ID).
- Subscription checkout (UPI Autopay/card), webhook endpoint with HMAC verification + idempotent `subscription_events`, state machine trialing→active→grace(15d)→read_only, cancelled.
- Daily cron: date-based transitions, Razorpay reconciliation, reminder emails (T-7, T-1, grace start).
- Banners in shell; `assertWritable` integration; missed-run list hook for T-044.

## Acceptance criteria

- [ ] In read_only: web mutations blocked except allowlist; Android payment sync still works (PRD/D-13).
- [ ] Duplicate webhook delivery has no effect.

## Tests required

- State machine unit tests; webhook signature + idempotency integration tests (Razorpay test mode fixtures).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/subscriptions/**`
- `apps/web/src/app/api/webhooks/razorpay/**`
- `apps/web/src/app/api/cron/subscription-states/**`
- `apps/web/src/app/(operator)/settings/subscription/**`
- `packages/i18n/messages/*/subscription.json`

## Notes

- Needs H-01 (Razorpay keys) and H-10 (GSTIN) before production; build and test with fixtures first.

## References

PLAN §13, FR-025, D-12, D-13, D-20, D-22, D-25 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T04:25:41.533Z claimed by agent-t085

---
id: T-066
title: Android: collect flow, durable payment queue and push sync
phase: 3
area: android
status: claimed
owner: agent-t066
claimed_at: 2026-10-13T14:25:34.419Z
branch: task/T-066-android-collect-flow-durable-payment-que
depends_on: [T-065]
review: required
claimable_by: agent
size: L
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/collect/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/waiting/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/PaymentSync*.kt, apps/android/app/src/main/java/com/cablebilling/lineman/data/payments/**, packages/i18n/messages/*/mobile_collect.json]
---

# T-066 — Android: collect flow, durable payment queue and push sync

**Phase** 3 · **Area** android · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-065

## Goal

A payment is never lost and never duplicated.

## Scope

- Amount (pre-filled due, chips), Method (Cash/UPI tiles, optional UPI ref with Skip), Confirm (spoken summary), Done (receipt no. permanent or provisional `P-<device>-<seq>`, action tiles wired as placeholders for T-069).
- UUIDv7 + provisional ref created before the Room insert; Room transaction completes before 'Saved' is shown.
- PaymentSync worker: unique work, network constraint, batches of 50, maps outcomes to states (SAVED_ON_PHONE, SENT_TO_OFFICE, NEEDS_OFFICE_HELP), links permanent receipt number, never deletes.
- Waiting screen (unsynced/problem list, 'Try now', call office).
- Different user signs in with queued payments from another user → hold queue + flag (PLAN §9.2).

## Acceptance criteria

- [ ] Kill app right after Save → payment present after restart and syncs once.
- [ ] Retrying a batch after a timeout produces no duplicates (server returns duplicate outcome).

## Tests required

- ViewModel + worker tests with MockWebServer fault injection; Compose UI test of full flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/collect/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/waiting/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/PaymentSync*.kt`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/payments/**`
- `packages/i18n/messages/*/mobile_collect.json`

## References

PLAN §10.4, PLAN §11.3 (Amount, Method, Confirm, Done, Waiting), FR-015, FR-016, BR-11, RULE-16, RULE-17 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T14:25:34.420Z claimed by agent-t066

---
id: T-069
title: Android: receipt PDF, WhatsApp/SMS sharing and receipt actions
phase: 3
area: android
status: claimed
owner: agent-t069
claimed_at: 2026-10-13T20:48:51.202Z
branch: task/T-069-android-receipt-pdf-whatsapp-sms-sharing
depends_on: [T-066, T-068]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/receipt/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/receipts/**, apps/android/app/src/main/res/xml/file_paths.xml, packages/i18n/messages/*/mobile_receipt.json]
---

# T-069 — Android: receipt PDF, WhatsApp/SMS sharing and receipt actions

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-066, T-068

## Goal

Give the customer a receipt without ever claiming delivery.

## Scope

- Wire Done-screen tiles: Print (T-068), WhatsApp (confirm/edit phone → wa.me link with preview URL; 'Share PDF' via FileProvider), SMS (`smsto:` with link).
- Local PDF via `PdfDocument` (works offline with provisional no.; regenerate after sync).
- Phone change from receipt flow → `PATCH /customers/{id}/phone` (queued if offline).
- Receipt actions outbox → `/receipts/actions:batch`; states limited to printed/print_failed/whatsapp_opened/sms_opened/pdf_shared.
- Offline link request queued with 'Link will be ready after sync' message.

## Acceptance criteria

- [ ] No UI string or state says 'sent' or 'delivered' for messages (PRD §15 #11).
- [ ] Print/share failure never changes payment state (PRD §15 #10).

## Tests required

- Unit tests for intent construction and outbox; UI test for phone confirm.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/receipt/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/receipts/**`
- `apps/android/app/src/main/res/xml/file_paths.xml`
- `packages/i18n/messages/*/mobile_receipt.json`

## References

PLAN §11.7, FR-017–FR-020, FR-004, J-07, RULE-18, RULE-19 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T20:48:51.203Z claimed by agent-t069

---
id: T-050
title: Receipt preview links and public receipt page
phase: 2
area: web
status: claimed
owner: agent-t050
claimed_at: 2026-10-13T13:50:31.974Z
branch: task/T-050-receipt-preview-links-and-public-receipt
depends_on: [T-046, T-005]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/receipts/links/**, apps/web/src/app/r/[token]/**, packages/i18n/messages/*/receipt.json]
---

# T-050 — Receipt preview links and public receipt page

**Phase** 2 · **Area** web · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-046, T-005

## Goal

A safe, minimal web receipt customers can open from WhatsApp/SMS.

## Scope

- Create/reuse link (32-byte token, SHA-256 stored, 90-day expiry), revoke, access logging, rate limit per IP/token.
- Public page: operator name/phone, receipt no., date, amount, method, first name + masked phone, allocation summary, 'Cancelled' stamp if reversed; noindex; bilingual; works on low-end phones (no JS required).
- A5 PDF download of the same receipt.

## Acceptance criteria

- [ ] Expired/revoked/unknown tokens show the same generic page (no existence leak).
- [ ] Receipt of tenant A never reachable with tenant B context (it's token-only, but test it).

## Tests required

- Integration tests for expiry, revocation, rate limit.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/receipts/links/**`
- `apps/web/src/app/r/[token]/**`
- `packages/i18n/messages/*/receipt.json`

## References

FR-019, FR-020, FR-021, RULE-19, RULE-22, D-14, PLAN §9.4 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T13:50:31.974Z claimed by agent-t050

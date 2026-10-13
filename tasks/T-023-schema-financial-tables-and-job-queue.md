---
id: T-023
title: Schema: financial tables and job queue
phase: 1
area: db
status: claimed
owner: agent-t023
claimed_at: 2026-10-13T12:41:22.397Z
branch: task/T-023-schema-financial-tables-and-job-queue
depends_on: [T-022]
review: required
claimable_by: agent
size: L
paths: [packages/db/src/schema/billing.ts, packages/db/src/schema/payments.ts, packages/db/src/schema/ledger.ts, packages/db/src/schema/receipts.ts, packages/db/src/schema/collections.ts, packages/db/src/schema/jobs.ts, packages/db/src/schema/index.ts, packages/db/migrations/**]
---

# T-023 — Schema: financial tables and job queue

**Phase** 1 · **Area** db · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-022

## Goal

All money tables, append-only by construction.

## Scope

- `billing_runs`, `billing_run_items`, `invoices` (partial UNIQUE (operator_id, customer_id, period) WHERE kind='regular'; UNIQUE invoice_number per operator), `invoice_lines`, `adjustments`.
- `payments` (id = client UUID; UNIQUE (operator_id, id); CHECK amount > 0; method enum; upi_verification default 'unverified'), `payment_reversals` (UNIQUE payment_id), `allocations`, `ledger_entries`, `customer_balances`.
- `receipts`, `receipt_links`, `receipt_actions` (enum WITHOUT any 'delivered' value), `collection_sessions` (UNIQUE operator+collector+business_date), `jobs`.
- Immutability triggers on payments (except review fields), allocations, ledger_entries, invoice_lines, issued invoices.

## Acceptance criteria

- [ ] Inserting a second regular invoice for the same customer+period fails.
- [ ] UPDATE/DELETE on a posted payment amount fails at DB level.

## Tests required

- Integration tests per constraint/trigger.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/schema/billing.ts`
- `packages/db/src/schema/payments.ts`
- `packages/db/src/schema/ledger.ts`
- `packages/db/src/schema/receipts.ts`
- `packages/db/src/schema/collections.ts`
- `packages/db/src/schema/jobs.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/migrations/**`

## References

PLAN §7.2, PLAN §8, FR-009–FR-017, FR-022, RULE-05, RULE-20, BR-13 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T12:41:22.397Z claimed by agent-t023

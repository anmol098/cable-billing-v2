---
id: T-060
title: Mobile API: roster sync, customer detail, phone update
phase: 3
area: api
status: done
owner: agent-t060
claimed_at: 2026-10-14T04:57:27.748Z
branch: task/T-060-mobile-api-roster-sync-customer-detail-p
depends_on: [T-028, T-033, T-034, T-023]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/api/mobile/v1/sync/**, apps/web/src/app/api/mobile/v1/customers/**, packages/core/src/mobile-sync/**]
---

# T-060 — Mobile API: roster sync, customer detail, phone update

**Phase** 3 · **Area** api · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-028, T-033, T-034, T-023

## Goal

Phones hold the whole tenant roster and stay fresh cheaply.

## Scope

- `GET /sync/customers?cursor=` delta with tombstones, gzip, page size 500.
- `GET /customers/{id}` fresh detail with open bills and last payments.
- `PATCH /customers/{id}/phone` audited with source android.

## Acceptance criteria

- [x] Full roster for 1k customers < 1 MB gzipped. (Measured: 55,127 bytes gzipped / 520,776 bytes JSON, 2 pages.)
- [x] Responses validate against `@cb/contracts`.

## Tests required

- Integration + contract tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/api/mobile/v1/sync/**`
- `apps/web/src/app/api/mobile/v1/customers/**`
- `packages/core/src/mobile-sync/**`

## References

PLAN §10.3, FR-004, B-012 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `apps/web/src/app/api/mobile/v1/sync/customers/route.ts`, `sync/_lib/sync.ts` | `GET /sync/customers?cursor=&limit=` (`syncCustomersHandler`, `gzipResponse`, `acceptsGzip`) |
| `apps/web/src/app/api/mobile/v1/customers/[id]/route.ts`, `customers/[id]/phone/route.ts`, `customers/_lib/customers.ts` | `GET /customers/{id}` (`customerDetailHandler`), `PATCH /customers/{id}/phone` (`updatePhoneHandler`) |
| `apps/web/src/app/api/mobile/v1/customers/_lib/wire.ts` | `rosterCustomerWire`, `openBillWire`, `recentPaymentWire` (core → contract) |
| `packages/core/src/mobile-sync/` | Services `syncRoster` (`mobile_sync.roster`), `getRosterCustomerDetail` (`mobile_sync.customer_detail`), `getRosterCustomer` (`mobile_sync.roster_customer`), all `customers.view`, REPEATABLE READ, READ ONLY. `cursor.ts` (encode/decode), `rows.ts` (row/bills/payments loaders, contract-limit clipping), `types.ts` (`RosterRow`, `RosterPage`, `RosterCustomerDetail`, …), isolation cases. |
| `packages/db/src/schema/roster.ts` + migrations `0013_roster_versions.sql`, `0014_roster_versions_triggers.sql` | `roster_versions (customer_id PK, operator_id, change_xid xid8, changed_at)`, RLS tenant policy, index `(operator_id, change_xid, customer_id)`; trigger function `app.roster_touch` and triggers on `customers`, `customer_balances`, `vc_assignments`, `areas` (rename), `vc_assets` (number change); backfill for existing customers. |
| `apps/web/e2e/mobile-roster.spec.ts` | HTTP e2e: sign-in → paged full sync → raw gzip bytes → delta with tombstone → detail → phone update ×2 → CURSOR_INVALID / 404 / 401. |

**Endpoints**

- `GET /sync/customers`: no cursor = full pass over **active** customers (no tombstones; the phone drops what it did not receive). With `next_cursor`: changed customers + `removed_customer_ids` for customers inactive now. `limit` 1–500 (default 500) counts customers + tombstones. Customers inside a page are ordered by `(updated_at, id)`. Gzip when `Accept-Encoding` allows it and the body is ≥ 1 KB (`Content-Encoding: gzip`, `Vary: Accept-Encoding`; Next's own compression skips already-encoded bodies, checked on `next start`). 400 CURSOR_INVALID (malformed / other tenant / other version / xid newer than the database), 400 VALIDATION (`query.limit`, `query.cursor`).
- `GET /customers/{id}`: the roster row (same shape as the roster) + open bills (issued, outstanding > 0, oldest first: period then id, T-041's order) + 10 latest payments with a receipt (newest first: `posted_at`, id; `reversed`, `provisional_ref` only if it matches the contract format, `collected_by_name` from `users`). Closed customer → `active: false`. 404 CUSTOMER_NOT_FOUND (unknown / other tenant), 400 VALIDATION (non-UUID id).
- `PATCH /customers/{id}/phone`: T-033 `updateCustomerPhone` (`field: "phone"`) → `customer_contact_changes` row (old, new, lineman, source `android`) + one audit event; the same number again → `changed: false`, nothing written (idempotent). Then the fresh roster row. 400 VALIDATION (body), 404 CUSTOMER_NOT_FOUND, **403 TENANT_READ_ONLY in read-only tenants** (D-13 allowlist: viewing + collecting; a contact edit is neither — matches the contract's TENANT_READ_ONLY text and T-051 decision 8), retryable conflict → 429 RATE_LIMITED `retry_after_seconds: 1`.
- Every 200 goes through T-028's `reply.ok` (validated against `@cb/contracts`); every route via `withMobileAuth` (version gate, bearer, device, user).

**Cursor design (please review)** — `packages/core/src/mobile-sync/cursor.ts`

- An `(updated_at, id)` cursor skips rows whose transaction read its clock before the cursor's time but committed after the read (long billing run, a payment waiting on a lock). Instead each change records the writer's **transaction id** (`roster_versions.change_xid = pg_current_xact_id()`, written by triggers in the same transaction) and the cursor stores the **xmin of the reading snapshot** (`pg_snapshot_xmin(pg_current_snapshot())`, REPEATABLE READ so the page and the xmin share one snapshot). Any transaction not committed at read time has xid ≥ xmin, so the next delta (`change_xid ≥ xmin`) can't miss it. `xid8` is 64-bit: no wraparound.
- A pass (pages until `has_more: false`) walks `(change_xid, customer_id)` from its watermark `w`, remembering the last row (`k`) and the smallest xmin seen since the pass began (`n`); the next pass starts at `n`. Rows that change mid-pass move to a higher xid and may be sent twice (the phone keeps the newest `updated_at`).
- Trade-off: rows committed shortly before a sync are **re-sent** while older transactions are running anywhere in the cluster (any tenant). Harmless (identical upsert) and bounded; tests assert re-sent rows are unchanged copies.
- Cursor = base64url JSON `{v, o (operator), w, n?, k?, f?}`, ≤ ~150 chars. Not signed: tampering only selects a slice of the caller's own tenant; another tenant's operator id or an xid beyond the database's current xmax → CURSOR_INVALID (also covers a database restored to an earlier point).
- `updated_at` on the wire = `roster_versions.changed_at`: strictly increasing per customer at ms precision (`greatest(previous + 1 ms, writer's updated_at)`; one bump per transaction), so T-064's "ignore an older copy" never drops a newer state even when transactions commit out of clock order. After a payment it is ≥ the payment's `posted_at` (T-064 projection rule; tested).

**Decisions**

1. **Migration** (justified: no existing column could express "changed by a transaction that committed after the cursor", and the roster row spans 5 tables). Triggers, not service calls, so web, phone, billing run, import, legacy migration and data fixes can't forget. Zero-balance rows from `lockCustomerBalance` don't touch the roster. Every customer has a roster_versions row (insert trigger + backfill); the sync drives from that table's index.
2. **Whole tenant** roster (D-11 / B-012): no area/assignment filter; "moved-out" doesn't apply. Tombstones = customers inactive now; customers are never deleted.
3. Open-bill summary = issued invoices with charges − Σ allocations > 0 (T-041 `invoiceOutstanding`), computed live; it moves with `customer_balances`, which every money path writes in the same transaction.
4. Values are clipped to contract max lengths (name 200, address 500, …; code/VC fall back to the normalised value) so one over-long legacy row can't 500 a whole page.
5. Recent payments without a receipt row (only possible for migrated data) are not listed (the contract requires `receipt_number`).
6. PATCH on a closed customer is allowed (T-033's service allows it; the phone may still share a receipt).

**Deviations / files outside the owned paths**

- `packages/db/src/schema/roster.ts` (+ test), one line in `packages/db/src/schema/index.ts`, migrations 0013/0014 + meta (allowed by the coordinator's brief; renumbered after T-085's 0012).
- One line in `packages/core/src/index.ts`. New `apps/web/e2e/mobile-roster.spec.ts`.
- The contract text says pages are "ordered by (updated_at, id)": true **within** a page; across pages the order is `(change_xid, id)`. The phone doesn't rely on cross-page order (T-064 compares per row). No contract change (it would regenerate Android DTOs).

**Open questions**

- Read-only tenants: should the lineman's phone correction be allowed (it's part of sharing the receipt)? Today 403 TENANT_READ_ONLY per the contract; T-069 should treat 403 like "keep, retry later" or drop it.
- Rate limit for `/sync/customers` (PLAN §9.4 lists "mobile sync"): not added (no limiter for bearer endpoints yet; same as T-061).
- Pre-existing e2e flake seen before the rebase (`connections.spec.ts:246`, `settings.spec.ts:238`: duplicate `users_login_unique` when a `fullyParallel` worker re-ran a `beforeAll` with module-level ids) is fixed on `feature/mvp` by `e2e/_support/unique.ts` (`newSeedId()` inside `beforeAll`); `mobile-roster.spec.ts` follows the same rule.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` c39217c after T-085)

- `packages/db` `roster.test.ts` (6): insert/update/no-op, out-of-clock-order commit keeps `changed_at` increasing (+1 ms), several changes in one tx counted once, balance (empty row ignored), connections, VC number, area rename (archive doesn't touch), RLS (own rows only; touching another tenant's row → 42501).
- `packages/core` `mobile-sync.test.ts` (16) with a phone model following T-064's rules, checked **equal to a fresh full sync** after: paging (3/3/1), creates/edits/closes/reopens/connection add-suspend-disconnect/area rename/payment/reversal, changes between pages, a **late commit** with an older clock (would be skipped by an `(updated_at, id)` cursor — asserted), and **writers running concurrently with paging**; CURSOR_INVALID cases; detail (balance, bills oldest first, 10 latest payments, reversed, provisional ref, collector), closed customer, NOT_FOUND, clipping; phone correction audit/contact history/idempotency; roles + read-only. `cursor.test.ts` (3). Isolation suite: 6 new cases pass; coverage test passes. Also run while an unrelated transaction held xmin back for 150 s: all pass.
- **Mutation check** (reverted): advancing the cursor to the snapshot's xmax instead of its xmin fails the late-commit and between-pages tests.
- `apps/web` `sync.test.ts` (7) and `customers.test.ts` (9): real T-028 sign-in, injected clock, every body parsed with the contract (keys equal to the fixtures); gzip; **1,000 customers** (Hindi/English names, phones, addresses, areas, 1–2 VCs, 2 open bills each): 55,127 bytes gzipped, 2 pages; version gate/401/426/DEVICE_REVOKED; isolation.
- Playwright (`next start`, scratch DB `cb_e2e_t060`, `E2E_PORT=3260`, pre-installed Chromium, DB dropped), after the rebase on c39217c: the mobile specs (roster, auth, collect) pass; full suite 81 passed, 1 failed: `plans.spec.ts:251` (T-031), the same duplicate-login `beforeAll` flake, because that spec does not use `newSeedId()` yet. Not related to this task.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (all packages), `pnpm build` (lists the three routes), `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `db:check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-14T04:57:27.749Z claimed by agent-t060
- 2026-10-14T05:42:14.326Z completed on task/T-060-mobile-api-roster-sync-customer-detail-p

---
id: T-023
title: Schema: financial tables and job queue
phase: 1
area: db
status: done
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

- [x] Inserting a second regular invoice for the same customer+period fails.
- [x] UPDATE/DELETE on a posted payment amount fails at DB level.

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

All 14 tables are tenant tables in `public` (`operator_id`, standard `tenant_isolation` policy, RLS on);
T-020's security audit passes with them. Every reference between tenant tables is a composite FK, most of
them **with the customer in the key** (`(operator_id, customer_id, x_id) → x(operator_id, customer_id, id)`),
so a row can't point at another tenant's or another customer's invoice / payment / adjustment / reversal.
Money is `bigint *_paise` (mode number → `toPaise`), periods are `date` with `CHECK (extract(day …) = 1)`,
instants `timestamptz`. Each module's header comment documents its rules. Migrations: `0006` (generated
tables) and `0007` (custom: triggers + one trigger function).

**Tables** (`packages/db/src/schema/*.ts`; Drizzle export in parentheses)

| Module | Table | Key points |
|---|---|---|
| billing | `invoices` (`invoices`) | `customer_id`, `period`, `invoice_number`, `kind` `regular\|opening_balance`, `opening_balance_paise` (signed), `charges_paise` ≥ 0, `total_due_paise` (**CHECK = opening + charges**), `issued_at`, `status` `issued\|void` + `voided_at/by`, `void_reason` (CHECK: all set iff void), legacy cols. **Partial UNIQUE `invoices_one_regular_per_period` (operator, customer, period) WHERE kind='regular'** (RULE-05); UNIQUE `(operator_id, invoice_number)`; UNIQUE `(operator_id, customer_id, id)` (FK target). |
| billing | `invoice_lines` (`invoiceLines`) | `type` `rent\|adjustment`; rent: `assignment_id` required, amount ≥ 0 (₹0 line OK, T-040); adjustment: `adjustment_id` required, amount > 0. Partial UNIQUEs: one rent line per (invoice, assignment); an adjustment billed once. FK `(operator_id, adjustment_id, invoice_id) → adjustments(operator_id, id, invoice_id)`: **set `adjustments.invoice_id` first, then insert the line.** `description` optional (the UI renders lines via i18n). |
| billing | `adjustments` (`adjustments`) | `customer_id`, `assignment_id?`, `period?`, `direction` / `source` (enums = `@cb/domain` `ADJUSTMENT_DIRECTIONS` / `ADJUSTMENT_SOURCES`), `amount_paise > 0`, `reason`, `invoice_id?`, `created_by?`, legacy. CHECKs: only debits can be invoiced; plan_change / mid_month_start name assignment + period; mid_month_start is a debit; manual needs reason + author. Index for pending debits. |
| billing | `billing_runs` (`billingRuns`) | UNIQUE (operator, period): one logical run, reused by retries and manual re-runs. `trigger` `cron\|manual\|catch_up`, `status` `pending\|running\|completed\|completed_with_errors\|failed\|skipped`, `skip_reason` (`tenant_read_only`; set iff skipped), counts + `total_charges_paise` ≥ 0, `started_at`, `finished_at` (set iff done), `actor_id` (required for manual). |
| billing | `billing_run_items` (`billingRunItems`) | UNIQUE (run, customer); `outcome` `created\|already_exists\|skipped\|failed`; `invoice_id` set iff billed (same-customer FK); `reason` required otherwise; `details` jsonb object (ids/amounts only); `attempts`. |
| payments | `payments` (`payments`) | **PRIMARY KEY `(operator_id, id)`: `id` is the client idempotency key** (a replay → 23505 `payments_pkey`). `amount_paise > 0`; `method` `cash\|upi`; `upi_reference` only for UPI; `upi_verification` (`unverified` only); `notes`; `collector_id` (required unless migration); `device_id` (set iff `source = 'android'`); `source` `android\|web\|migration`; `recorded_at`, `posted_at`, `business_date`; **`balance_after_paise` / `credit_after_paise`** (required unless migration); `review_status` `none\|needs_review\|resolved`, `review_reason` (= contract `ReviewReason`; set iff flagged), `reviewed_by/at`, `review_note` (set iff resolved); legacy (migration only). |
| payments | `payment_reversals` (`paymentReversals`) | `customer_id`, `payment_id` (**UNIQUE per operator**), `reason` (not blank), `actor_id`, `at`. The FK to the payment includes the customer. |
| ledger | `allocations` (`allocations`) | `customer_id`, `invoice_id`, `source_type` (enum = T-041 `ALLOCATION_SOURCE_TYPES`), `payment_id` / `credit_adjustment_id` (exactly one, real FKs) + generated `source_id`, `kind` `posting\|credit_application\|reversal`, `amount_paise` (≠ 0; **< 0 exactly on reversal rows**), `outstanding_after_paise` ≥ 0, `reversal_id` + `reverses_allocation_id` (reversal rows only; FK to the payment's own reversal; self-FK to a row of the same invoice and payment; UNIQUE, so a row is cancelled at most once; trigger: amount = −original and original > 0). |
| ledger | `ledger_entries` (`ledgerEntries`) | `customer_id`, `seq` (identity: posting order), `type` (= T-041 `LedgerEntryType`, compile-time checked), signed `amount_paise`, typed refs `invoice_id` / `adjustment_id` / `payment_id` / `payment_reversal_id` (exactly one; required and sign fixed by type: invoice/opening_balance ≥ 0, debit_adjustment > 0, credit_adjustment < 0, payment < 0, payment_reversal > 0); partial UNIQUEs: one entry per document. |
| ledger | `customer_balances` (`customerBalances`) | PK `customer_id`; `balance_paise` (signed), `credit_paise` ≥ 0, `oldest_due_period` (a 1st), `updated_at`. Mutable read model; never deleted. |
| receipts | `receipts` (`receipts`) | UNIQUE `(operator_id, payment_id)`, UNIQUE `(operator_id, receipt_number)`, `provisional_ref` (format CHECK `^P-[A-Z0-9]{3}-[0-9]{4,9}$`, indexed, **not unique**), `issued_at`, legacy. |
| receipts | `receipt_links` (`receiptLinks`) | `token_hash` (CHECK 64 lower-case hex, **globally UNIQUE**), `expires_at > created_at`, `created_by`, `revoked_at/by`, `access_count` ≥ 0, `last_access_at`. `app_platform` SELECT policy (lookup by hash before the tenant is known). |
| receipts | `receipt_actions` (`receiptActions`) | PK `(operator_id, id)` (the phone's idempotency key); `action` `printed\|print_failed\|whatsapp_opened\|sms_opened\|pdf_shared` (**no sent/delivered value**, tested on `pg_enum`); `device_id?`, `actor_id?`, `at`, `received_at`. |
| collections | `collection_sessions` (`collectionSessions`) | UNIQUE (operator, collector, business_date); running totals `cash_expected_paise`, `upi_total_paise`, `payment_count` ≥ 0; `status` `open\|submitted\|accepted\|returned`; handover snapshot `handover_submission_id`, `handover_cash_expected_paise`, `cash_handed_over_paise`, **`discrepancy_paise` (CHECK = handed − snapshot expected)**, `discrepancy_reason` (`short\|extra\|pending_sync\|other`; **required when the discrepancy ≠ 0**), `handover_note`, `unsynced_payment_count`, `unsynced_cash_paise`, `submitted_at` (all NULL iff open); `reviewed_by/at` (set iff accepted/returned), `review_note` (required for returned). |
| jobs | `jobs` (`jobs`) | `operator_id?` (NULL = platform job), `type` (dotted snake_case CHECK), `payload` jsonb object, `status` `queued\|running\|succeeded\|failed`, `run_after`, `attempts` ≤ `max_attempts` (default 5), `locked_until` (required when running), `locked_by`, `last_error`, `dedupe_key`, `started_at`, `finished_at` (set iff done). **Partial UNIQUE dedupe (coalesce(operator_id, nil uuid), dedupe_key) WHERE status IN (queued, running)**; partial indexes for claiming (`queued` by run_after) and expired leases (`running` by locked_until). Tenant policy + `app_platform` SELECT/INSERT/UPDATE (no DELETE). |

**Append-only and lifecycle triggers** (migration `0007`; all `app.forbid_update_delete`, SQLSTATE CB001, for
every role including the owner). The allowed columns are the minimum each workflow needs;
`financial-immutability.test.ts` pins them against the catalog and against `appendOnlyTriggerSql`'s exact output.

| Table | May change after insert | Why |
|---|---|---|
| `invoices` | `status`, `voided_at`, `voided_by`, `void_reason` | PLAN §7.1 "issued invoices (except status/void metadata)". Extra trigger: a void invoice is final. No DELETE/TRUNCATE. |
| `adjustments` | `invoice_id` | PLAN §7.2 "set when invoiced". Extra trigger: once set it never changes. |
| `payments` | `review_status`, `reviewed_by`, `reviewed_at`, `review_note` | The office resolves a `needs_review` payment. Extra trigger freezes every payment that is not `needs_review`, so `none`/`resolved` rows can't change at all. `review_reason` is set at posting. |
| `invoice_lines`, `payment_reversals`, `allocations`, `ledger_entries`, `receipts`, `receipt_actions` | nothing | fully append-only |
| `receipt_links` | `revoked_at`, `revoked_by`, `access_count`, `last_access_at` | Revocation is one-way (trigger). **DELETE allowed** for the weekly purge of expired links (PLAN §14). |
| `customer_balances` | all but `customer_id`, `operator_id` | Read model. No DELETE/TRUNCATE (it would silently reset a balance). |
| `billing_runs` / `billing_run_items` | all but id/tenant/period (run) or run/customer (item) | No DELETE/TRUNCATE. A billed item (`created`/`already_exists`) is final except `updated_at`. |
| `collection_sessions` | all but id/tenant/collector/business_date | No DELETE/TRUNCATE. Once `accepted`, only `cash_expected_paise`, `upi_total_paise`, `payment_count`, `updated_at` change (late-synced or reversed payments). |
| `jobs` | everything | a work queue, not a record |

Plus `app.check_allocation_reversal()` (SECURITY INVOKER, BEFORE INSERT on `allocations` for negative rows):
a reversal row must cancel one positive row exactly (23514, constraint name `allocations_reversal_cancels_original`).

**How later tasks use this**

- **T-043 (jobs):** worker in `withPlatform`; the claim statement is in `jobs.ts`'s header (UPDATE … WHERE id IN
  (SELECT … FOR UPDATE SKIP LOCKED) RETURNING; expired leases only while `attempts < max_attempts`). Enqueue
  with `onConflictDoNothing()` and a `dedupe_key` (unique per tenant among live jobs). Backoff: back to `queued`
  with a later `run_after`; at `max_attempts` → `failed` + `finished_at` (alert). No DELETE (a retention cleanup
  would need a reviewed policy). `jobs.test.ts` proves 4 concurrent claimers never share a job and an expired
  lease is claimed again.
- **T-044 (billing run):** upsert `billing_runs` on (operator, period) and items on (run, customer). Per customer,
  one transaction: lock `customer_balances` (insert if missing, then `FOR UPDATE`), `opening = balance`,
  `nextCounter(tx, op, "invoice")`, insert the invoice → **set the pending debit adjustments' `invoice_id` →
  insert the lines** → ledger `invoice` (+charges) → balance → `applyCredit` rows (`kind = 'credit_application'`,
  with `outstanding_after_paise`) → credit −= applied. 23505 on `invoices_one_regular_per_period` means
  `already_exists`. Read-only tenant → run `status = 'skipped'`, `skip_reason = 'tenant_read_only'`; missed runs
  are the skipped runs; a manual re-run reuses the row (`trigger = 'manual'`, `actor_id`).
- **T-045:** T-042 drafts map 1:1 onto `adjustments` (+ customer, reason, created_by). Credit adjustments get a
  `credit_adjustment` ledger entry (−amount) and are allocated with `source_type = 'credit_adjustment'`.
  "Charged so far" records: `invoice_lines` (type rent) + `adjustments` by `(operator_id, assignment_id, period)`.
- **T-046:** insert `payments` with the client id; on 23505 `payments_pkey`, read the row back and compare the
  payload (same → `duplicate` with the stored snapshots and the `posting` allocations; different →
  `ID_REUSED_WITH_DIFFERENT_DATA`). Ledger `payment` (−amount), allocations `kind = 'posting'` with
  `outstanding_after_paise`, receipt (`nextCounter(…, "receipt")`, `provisional_ref`),
  `balance_after_paise`/`credit_after_paise`, session totals. Reversal: `payment_reversals` (23505 = already
  reversed → CONFLICT), ledger `payment_reversal` (+amount), T-041 `reverse()` rows stored with
  `kind = 'reversal'`, `reversal_id`, `reverses_allocation_id`.
- **T-047 / T-049:** register by `invoices_period_idx`; statement = `ledger_entries` ORDER BY `seq` (running
  balance); bill detail = lines + allocations by invoice.
- **T-050:** store `sha256(token)` as hex; look it up in `withPlatform` by `token_hash`, then do everything else
  (`access_count`, revoke, read receipt/payment) in `withTenant(link.operator_id)`. Purge expired links with
  DELETE in `withTenant` (or add a reviewed platform DELETE policy).
- **T-052:** per customer, read the tables into T-041's `LedgerState` exactly as `ledger.test.ts`'s
  `ledgerState()` does (payments ⟕ payment_reversals for `reversed`, credit adjustments = `direction = 'credit'`,
  all allocation rows, all ledger rows, `customer_balances`), then run `checkLedger`.
- **T-061 / T-062:** sessions: `INSERT … ON CONFLICT DO NOTHING` on (operator, collector, business_date), then
  update the totals. A handover writes the snapshot columns (the server computes the discrepancy; the CHECK
  enforces it); idempotency on `handover_submission_id`; Accept/Return set `reviewed_*`; resubmitting after
  `returned` clears them (history goes to `audit_events`). Receipt actions: insert with the phone's id; 23505
  `receipt_actions_pkey` = `duplicate`.
- Also exported: the enum arrays and types (`INVOICE_KINDS`, `INVOICE_STATUSES`, `INVOICE_LINE_TYPES`,
  `BILLING_RUN_TRIGGERS`, `BILLING_RUN_STATUSES`, `BILLING_RUN_SKIP_REASONS`, `BILLING_RUN_ITEM_OUTCOMES`,
  `PAYMENT_METHODS`, `UPI_VERIFICATIONS`, `PAYMENT_SOURCES`, `PAYMENT_REVIEW_STATUSES`, `PAYMENT_REVIEW_REASONS`,
  `ALLOCATION_KINDS`, `LEDGER_ENTRY_TYPES`, `RECEIPT_ACTIONS`, `COLLECTION_SESSION_STATUSES`,
  `DISCREPANCY_REASONS`, `JOB_STATUSES`), the patterns `PROVISIONAL_REF_PATTERN`, `TOKEN_HASH_PATTERN`,
  `JOB_TYPE_PATTERN`, `DEFAULT_JOB_MAX_ATTEMPTS`, and the CHECK helpers `periodFirstDay`, `notBlank`.

**Assumptions about T-041's open questions** (the schema stays neutral where it can)

- **Q-A** (debit adjustment ledger entry at creation?): not decided by the schema. `ledger_entries` allows a
  `debit_adjustment` entry, at most one per adjustment. The integration test follows invariant 3 as written
  (debit adjustments reach the ledger only through the invoice's charges), and `checkLedger` passes.
- **Q-B** (apply credit right after a reversal / credit adjustment?): no schema impact;
  `allocations.kind = 'credit_application'` covers either answer (the test applies a credit adjustment at once).
- **Q-C** (oldest source by `posted_at` or `recorded_at`): both are stored; nothing assumed.
- **Q-D** (opening balance first in the same period?): no ordering column; nothing assumed. Several
  `opening_balance` invoices per customer are allowed (the schema doesn't limit them).
- **Q-E** (reversing credit adjustments): not supported. Reversal rows must have `source_type = 'payment'`
  (CHECK). If credit-adjustment reversals are wanted later, that CHECK and `payment_reversals` need a sibling design.

**Decisions (reviewer please check)**

1. **Payments and receipt actions key on `(operator_id, id)`** (scope: "UNIQUE (operator_id, id)") instead of a
   global PK on `id`: a client id can't collide with, or reveal, another tenant's row, and replays within the
   tenant hit the PK.
2. **Typed references instead of polymorphic `ref_type/ref_id` (ledger) and `source_id` (allocations)**: one
   nullable FK column per kind with exactly-one CHECKs, so every reference is a real composite FK (with the
   customer). `allocations.source_id` exists as a generated column for T-041's `sourceId`. This deviates from
   PLAN §7.2's column list but holds the same information.
3. **Columns beyond PLAN §7.2**: `allocations.customer_id` (per-customer loading, same-customer FKs),
   `allocations.kind`, `allocations.outstanding_after_paise`, `allocations.reverses_allocation_id`,
   `payments.balance_after_paise` / `credit_after_paise` (T-051 decision 5: receipts and replays),
   `payments.reviewed_by/at`, `review_note`, `payment_reversals.customer_id`, `ledger_entries.seq`,
   `billing_runs` counts and `skip_reason`, `billing_run_items.details`/`attempts`/`invoice_id`,
   `receipt_links.created_by/revoked_by`, `receipt_actions.actor_id/received_at`, the `collection_sessions`
   handover snapshot (contract `Handover`), `jobs.max_attempts/locked_by/dedupe_key/started_at/finished_at`.
4. **`billing_runs.status` gained `skipped`** (+ `skip_reason`): PLAN §8.2 / D-13 / D-25 need a recorded skipped
   run, and the PLAN's status list doesn't have one.
5. **Invoice void** is kept as PLAN §7.1 allows (status/void metadata only, void final), but **no flow voids
   invoices and what a void does to the ledger is undefined** (open question). A void invoice still occupies its
   period in the RULE-05 UNIQUE.
6. **`receipts.provisional_ref` is not unique** (only indexed): a collision must never block posting a payment (BR-11).
7. **`upi_verification` has only `unverified`** (BR-10); a verification flow would add a value and allow the
   column in the trigger.
8. **Jobs are tenant-scoped with a nullable `operator_id`**, not a global table: RLS stays on (no
   `ALLOW_WITHOUT_RLS` entry), tenants enqueue and see only their own jobs, the platform worker gets
   SELECT/INSERT/UPDATE (no DELETE).
9. **Same-customer composite FKs** (UNIQUE `(operator_id, customer_id, id)` targets on invoices, adjustments,
   payments, payment_reversals): an allocation, ledger entry, adjustment or run item can only reference its own
   customer's documents.
10. `payments.business_date` is not CHECKed against `recorded_at` (PLAN §8.7: the IST date of `recorded_at`);
    T-046 computes it, so the rule can change without a migration.

**Open questions**

- **Invoice void semantics** (PLAN §7.1 mentions void metadata; nothing defines it): what does a void do to the
  ledger and allocations, who may void, and may the period be billed again? Until answered, nothing should void.
- Should a line's / adjustment's assignment be forced to belong to the invoice's customer? That needs
  `UNIQUE (operator_id, customer_id, id)` on T-022's `vc_assignments` (a small follow-up migration); today it is
  a service rule (T-040 refuses `other_customer`).
- "Σ allocations per source ≤ source amount" and "outstanding ≥ 0" span rows, so only the posting transaction
  (balance row lock) and T-052 keep them. A deferred constraint trigger could enforce them at commit if wanted.
- `receipt_links` purge: a tenant-side DELETE works today; T-050 may prefer a platform DELETE policy limited to
  expired rows (needs review).

**Deviations / shared files**

- `packages/db/src/schema/index.ts`: six appended export lines. `packages/db/README.md` (T-020, done): two rows in
  the platform-policy table (`jobs`, `receipt_links`). No other task's files changed; no dependency changes.
- Tests: `src/schema/{billing,payments,ledger,receipts,collections,jobs,financial-immutability}.test.ts`.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17, after rebasing on `feature/mvp`)

- `pnpm --filter @cb/db test`: 23 files, 217 tests, no skips. T-023 adds 7 files / 64 tests:
  - invoices: RULE-05 sequentially **and** with 4 concurrent runs (exactly one invoice, gap-free number), every
    CHECK by constraint name, immutability (UPDATE/DELETE/TRUNCATE, app role and owner), void final;
  - adjustments (invoiced once, credits never, same-customer FK), invoice lines (shape, uniques, adjustment FK
    order), runs and items;
  - payments: **a replay → 23505 `payments_pkey`; 10 concurrent identical posts → 1 row**; amount > 0; **UPDATE
    and DELETE of a posted payment (amount and other columns) fail for the app role and the owner**; review
    workflow; reversals (one per payment, append-only);
  - allocations (sources, signs, reversal trigger, self-FK, cancelled at most once), ledger (sign/reference per
    type, one entry per document, seq, append-only), balances;
  - receipts, links (hash format, platform read-only, one-way revocation, purge), actions (no sent/delivered in
    `pg_enum`, idempotency key);
  - sessions (discrepancy computed, reason, review, accepted final), jobs (dedupe, policies, SKIP LOCKED with 4
    concurrent workers, lease expiry), the catalog test of the trigger allow-lists;
  - RLS isolation cases in every file; T-020's security audit passes with all new tables.
- **`ledger.test.ts` integration**: invoice → payment (₹700 on ₹500: ₹200 credit) → pending debit adjustment →
  next invoice + credit application → credit adjustment applied → payment reversal, all through the tables with
  T-041's `allocate` / `applyCredit` / `reverse`. After **every** step the rows read back map onto `LedgerState`
  and `checkLedger` returns `[]`; balances and outstanding amounts are asserted; a drifted read model is then
  reported (`BALANCE_MISMATCH`).
- **Mutation checks** (reverted): dropping `invoices_one_regular_per_period` → both RULE-05 tests fail; adding
  `amount_paise` to the payments allow-list → the catalog tests and the review-workflow test fail (the trigger
  that freezes never-flagged payments still blocks the plain amount update: defence in depth).
- `db:generate` → "No schema changes"; `db:check` OK.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9), `pnpm build`
  (9/9), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T12:41:22.397Z claimed by agent-t023
- 2026-10-13T13:07:19.716Z completed on task/T-023-schema-financial-tables-and-job-queue

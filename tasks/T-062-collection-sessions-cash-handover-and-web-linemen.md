---
id: T-062
title: Collection sessions, cash handover and web Linemen page
phase: 3
area: web
status: done
owner: agent-t062
claimed_at: 2026-10-13T15:52:48.116Z
branch: task/T-062-collection-sessions-cash-handover-and-we
depends_on: [T-046, T-029]
review: self
claimable_by: agent
size: M
paths: [packages/core/src/collections/**, apps/web/src/app/(operator)/linemen/**, packages/i18n/messages/*/linemen.json]
---

# T-062 — Collection sessions, cash handover and web Linemen page

**Phase** 3 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-046, T-029

## Goal

Owner/staff see each lineman's cash and UPI per day and accept handovers.

## Scope

- Services: session totals, submit handover (discrepancy reason codes + note), accept, return with note (all audited).
- Linemen page: day picker, per-lineman cards (cash, UPI, count, handover status, unsynced warning from device last-seen), review screen with Accept/Return.

## Acceptance criteria

- [x] Expected cash excludes UPI; discrepancy computed server-side.

## Tests required

- Service + isolation tests; Playwright accept flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/collections/**`
- `apps/web/src/app/(operator)/linemen/**`
- `packages/i18n/messages/*/linemen.json`

## References

PLAN §8.7, FR-022, J-05, B-016 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/collections/` (exported from `@cb/core` with one line `export * from "./collections";`) | Services `getLinemenDay`, `getLinemanDay`, `getOwnCollectionDay`, `submitHandover`, `acceptHandover`, `returnHandover`; pure rules `discrepancyOf`, `storedReason`, `lastContactOf`, `phoneMayHoldPayments`, `PHONE_STALE_AFTER_MS`; inputs `SubmitHandoverInput`, `AcceptHandoverInput`, `ReturnHandoverInput`, `LinemenDayInput`, `LinemanDayInput`, `OwnCollectionDayInput`; `HANDOVER_ERROR_CODES` (`HANDOVER_ALREADY_ACCEPTED`), `MAX_HANDOVER_NOTE_LENGTH` (500), `MAX_UNSYNCED_PAYMENT_COUNT` (10 000); view types in `types.ts`. Internal: `read.ts` (queries), `submitHandoverInTx` / `reviewHandoverInTx`, `test-support.ts`. |
| `packages/db/src/schema/handovers.ts` + migrations `0010_handover_events` (generated) and `0011_handover_events_append_only` (custom) | New tenant table **`handover_events`** (append-only history, see decision 1). |
| `apps/web/src/app/(operator)/linemen/page.tsx` | Linemen page: day picker (GET form + previous/today/next), day totals (cash, UPI, payments, handovers to check), one card per lineman (cash, UPI, count, status pill, difference, phone warnings). |
| `apps/web/src/app/(operator)/linemen/[id]/` | Review screen (`page.tsx`), Server Actions `acceptHandoverAction` / `returnHandoverAction` (`actions.ts`), client `ReviewActions` (Accept with a ConfirmSheet stating the numbers; Send back with a required note). |
| `apps/web/src/app/(operator)/linemen/_lib`, `_components` | `format.ts` (rupees, IST clock, difference words, `pickDay`), `review-result.ts` (service error → message key), `day-parts.tsx` (status pill, phone notes, day picker). |
| `packages/i18n/messages/{en,hi}/linemen.json` | Namespace `linemen` (web only). **All Hindi is machine-drafted and listed in `_review`.** Glossary: new "Cash handover words" table. |

**The exact rules (stated in `packages/core/src/collections/rules.ts`)**

- **Expected cash** of a lineman's day = Σ `amount_paise` of payments with `collector_id` = the lineman, `business_date` = the IST day (IST date of `recorded_at`), `source = 'android'`, **`method = 'cash'`** and **no `payment_reversals` row**. UPI is never expected as cash (BRD B-014; contract `CollectionDay.upi_total_paise` "Not part of the cash handover"); reversed payments are excluded (PLAN §8.6, contract "reversed payments are not in the totals"). These are exactly T-046's running totals on `collection_sessions` (`cash_expected_paise`, `upi_total_paise`, `payment_count`), which the services read; tests recompute them from `payments` ⟕ `payment_reversals` and compare.
- **Discrepancy** = `cash_handed_over_paise − expected` (PLAN §8.7; contract `Handover.discrepancy_paise`; negative = short), computed by the server from the expected cash of the **locked** session row at submission (snapshot `handover_cash_expected_paise`); the phone never sends an expected amount. ≠ 0 needs a reason (`short | extra | pending_sync | other`), else VALIDATION `fields: [{path: "discrepancyReason", code: "required"}]` with `details.cashExpectedPaise` / `discrepancyPaise`; at 0 a sent reason is dropped (stored null).
- **Phone warning** (`phoneMayHoldPayments`): last contact = later of the newest `devices.last_seen_at` (phones of the lineman not signed out) and the day's latest handover `submitted_at`; warn when `lastContact < min(now, end of the IST day) − 30 min`. No phone → no warning ("No phone signed in"). Matches T-066: the phone pushes saved payments on every save, sign-in, app foreground and Try now, so a phone online after the day ended has had its chance. It is worded as "may still be on the phone"; the exact number is the phone's own `unsynced_payment_count` / `unsynced_cash_paise` reported with the handover, shown when > 0. The review also warns when the running cash total moved after the handover (`changedSinceHandover`: a late-synced or reversed payment).

**State machine** (`collection_sessions.status`): `open → submitted`; `submitted → accepted` (final: HANDOVER_ALREADY_ACCEPTED for any later submit) | `returned` (note required) | `submitted` (a resubmission replaces the latest handover); `returned → submitted`. Every step: one READ COMMITTED transaction, `SELECT … FOR UPDATE` on the session row, session update, one `handover_events` row, one audit event (`handover.submit` / `handover.accept` / `handover.return`, entity `collection_session`, amounts and ids only; notes are in `handover_events`, the audit has `has_note`). Lock order: only the session row (posting: balance → counter → session), so no cycles.

**APIs for later tasks**

- **T-061 (mobile endpoints):**
  - `GET /collections/{date}` → `getOwnCollectionDay.call(runtime, ctx, { businessDate: date })` → `CollectionDayView`. Map: `business_date` = `businessDate`, `cash_total_paise` = `cashExpectedPaise`, `upi_total_paise`, `payment_count`, `status`, `handover` (null while open: `cash_expected_paise` = `handover.cashExpectedPaise` (snapshot), `cash_handed_over_paise`, `discrepancy_paise`, `discrepancy_reason`, `note`, `unsynced_payment_count`, `unsynced_cash_paise`, `submitted_at`, `reviewed_at`, `review_note`; ISO strings), `payments[]` (`payment_id`, `customer_id`, `customer_code`, `customer_name`, `amount_paise`, `method`, `recorded_at`, `posted_at`, `receipt_number`, `provisional_ref`, `reversed`; drop `needsReview`). Always the caller's own day (collector = `ctx.userId`); future date → VALIDATION `fields: [{path: "businessDate", code: "future"}]`.
  - `POST /collections/{date}/handover` → `submitHandover.call(runtime, ctx, { businessDate: date, submissionId: submission_id, cashHandedOverPaise: cash_handed_over_paise, discrepancyReason: discrepancy_reason, note, unsyncedPaymentCount: unsynced_payment_count, unsyncedCashPaise: unsynced_cash_paise })` → `{ outcome: "submitted" | "duplicate", day: CollectionDayView }` (respond `session: day` for both). Errors: VALIDATION, HANDOVER_ALREADY_ACCEPTED (409), ID_REUSED_WITH_DIFFERENT_DATA (`details.fields`, names only), CONFLICT `retryable`, FORBIDDEN for non-linemen. Idempotent on **any** earlier `submission_id` (a stale retry after a newer submission returns the current day), per tenant. Allowed in read-only mode (D-13).
- **T-081 (handover report):** `handover_events` is the sign-off history (one `submitted` row per submission with its snapshot, one `accepted`/`returned` row per decision; index `(operator_id, session_id, at)`); `collection_sessions` holds the latest state and the running totals.
- **T-083 (Home alerts):** "handovers waiting" = sessions with `status = 'submitted'` (or `getLinemenDay(...).totals.waitingCount` for a day).
- **T-070 (Android Today):** the server snapshot/discrepancy and the review note come back in `handover`; `returned` means "submit again".
- **Web:** `getLinemenDay.call(runtime, ctx, { businessDate })`, `getLinemanDay.call(runtime, ctx, { linemanId, businessDate })` (`dashboard.view`: Owner, Staff); `acceptHandover.call(runtime, ctx, { sessionId, submissionId, note? })`, `returnHandover.call(runtime, ctx, { sessionId, submissionId, note })` (`handover.review`; TENANT_READ_ONLY in read-only mode). Accept/return name the submission the office looked at: otherwise CONFLICT with `details.reason` = `resubmitted` | `already_accepted` | `already_returned` | `not_submitted` (+ `status`).

**Decisions (reviewer please check)**

1. **New append-only table `handover_events`** (outside the owned paths: `packages/db/src/schema/handovers.ts`, schema index line, migrations 0010/0011). T-023's design keeps only the latest handover on the session and leaves history to `audit_events`; that loses the snapshot of a returned submission from queryable data and makes idempotency on older submission ids impossible. The table: `type submitted|accepted|returned`, `submission_id` (partial UNIQUE per tenant among `submitted`; partial UNIQUE "one decision per submission"), snapshot columns only on `submitted` (CHECKs: discrepancy = handed − expected, reason when ≠ 0, amounts ≥ 0), note required for `returned`, composite FKs to the session and the actor, standard tenant policy, `app.forbid_update_delete()` row + TRUNCATE triggers with no updatable column.
2. **Who submits:** only the lineman, for their own day (`handover.submit` is lineman-only, T-025; PLAN §8.7 "the lineman enters the cash handed over"). The office cannot submit on a lineman's behalf (see open questions). A handover is allowed on a day with no server payments (session created; e.g. everything still on the phone with reason `pending_sync`).
3. **Read services use `dashboard.view`** (O, S; a read capability, so they run READ ONLY); the page itself is gated by `handover.review` like the T-029 menu. The lineman's own day uses `reports.own_day.view` and can only ever read `ctx.userId`'s day.
4. **Linemen listed for a day:** every active lineman, plus anyone with a session that day (a deactivated lineman's cash must still reach the office; shown "Switched off"). Order: waiting → sent back → not handed over → accepted, then name.
5. **Sessions remain Android-only** (T-046 decision 3): counter cash taken by Owner/Staff has no session or handover.
6. **Accept takes an optional note** in the service (contract `review_note` "returned (or accepted)"); the web Accept sheet doesn't ask for one (one job per screen).
7. `submitHandover` is **exempt from the isolation harness** with a written reason (`exemptFromIsolation`): its only id is the phone's own per-tenant idempotency key; `handover.test.ts` proves another tenant's submission id creates an independent submission and leaves that tenant's rows untouched. All other services have isolation cases (`collections.isolation.ts`).

**Open questions (product owner)**

- **Office counter cash session** (T-046 open question): should Owner/Staff counter cash have a session/handover? Today no.
- **Deactivated lineman / lineman without a phone:** their day is listed and reviewable, but nobody can submit their handover (lineman-only, and a disabled user can't sign in, T-028). Option: an office "record handover for lineman" flow (needs `handover.submit` for O/S, a security change) — not done.
- **`session-close` cron** (PLAN §14; T-043 stub says T-062): what "flag unsubmitted handovers" should produce is undefined, and totals need no snapshot. Created **T-062a** (follow-up task file in this PR); the stub route is unchanged.
- Should an accepted day whose running total changes later (late sync, reversal) be re-opened or raise an alert? Today it stays accepted and the review shows "The cash total changed after the handover".

**Deviations / files outside the owned paths**

- `packages/db/src/schema/handovers.ts`, `handovers.test.ts`, `schema/index.ts` (one line), migrations 0010/0011 + snapshots + journal (decision 1).
- `packages/db/src/schema/collections.test.ts` (T-023, done): its TRUNCATE assertion now uses `TRUNCATE collection_sessions CASCADE`, because the new FK from `handover_events` stops a plain TRUNCATE before the trigger (still refused with CB001).
- `apps/web/e2e/shell.spec.ts` (T-029, done): a dynamic route that answers 404 for the made-up id is accepted (a built detail page doesn't know it, like any other tenant's id); placeholders still need 200 + title.
- `packages/core/src/index.ts` (one line), `packages/i18n/glossary.md` (new table), generated `apps/web/messages/*.json`, new `apps/web/e2e/linemen.spec.ts`, new `tasks/T-062a-session-close-cron.md`.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 0d91bf5)

- `pnpm --filter @cb/core test`: 43 files / 576 tests. New: `collections/rules.test.ts` (5: discrepancy, reason, last contact, 30-min boundaries today and for a past day, contract codes/limits), `day.test.ts` (6: **expected cash excludes UPI and reversed payments** and equals the recomputation from payments; counter payments and other days excluded; payment list newest first with reversed flagged; zeros for an empty day; future/invalid dates VALIDATION; cards incl. deactivated with/without session, order, totals, Staff allowed / lineman FORBIDDEN; phone warning boundaries with real `devices.last_seen_at`, revoked phone ignored; handover counts as contact; review screen, NOT_FOUND for owner id / unknown id), `handover.test.ts` (9: exact cash, server discrepancy after a reversal (₹800 handed vs ₹500 expected → reason required), idempotency incl. a stale older submission and ID_REUSED fields, **submit → return (note) → resubmit → accept → HANDOVER_ALREADY_ACCEPTED**, stale accept → `resubmitted`, double accept → `already_accepted`, history rows + append-only, audit rows, snapshot unchanged when totals move after acceptance, handover with no server payments, validation, roles, NOT_FOUND, read-only (submit allowed, accept TENANT_READ_ONLY), per-tenant submission ids), `concurrency.test.ts` (4, deterministic: an admin connection holds the row lock until every caller is blocked: **8 parallel accepts by owner/staff → exactly 1 accepted, 7 CONFLICT `already_accepted`, 1 decision row**; accept vs return → one wins; 8 identical submissions → 1 submitted + 7 duplicates; a handover racing 6 postings snapshots a consistent prefix). Isolation suite: 5 new cases pass; coverage test passes.
- **Mutation check** (reverted): removing `FOR UPDATE` on the session row makes the double-accept and same-submission concurrency tests fail.
- `pnpm --filter @cb/db test`: 30 files / 254 tests (new `handovers.test.ts`: CHECKs by name, partial uniques, append-only incl. owner and TRUNCATE, RLS and cross-tenant FKs).
- `pnpm --filter web test`: 21 files / 175 tests (new: `format.test.ts`, `review-actions.test.tsx`: confirm sheet text, accept call, stale error + refresh, note required, Hindi).
- `pnpm --filter web test:e2e` (scratch DB `cb_e2e_t062` migrated, `E2E_PORT=3262`, pre-installed Chromium; dropped afterwards): **33 passed**, incl. new `linemen.spec.ts` (data seeded through `postPayment` / `submitHandover`): Owner sees totals ₹1,200 cash / ₹200 UPI, Ravi's card "Waiting for check" ₹800 / ₹200 / 3 payments / "₹50 short", opens the review, Accept → confirm sheet "Ravi Kumar gave ₹750. Expected ₹800. ₹50 short." → "Cash accepted", DB status `accepted` + history; Suresh sent back with a note at 360px (no sideways scroll).
- Screenshots (1280px EN/HI, 360px list and review) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10), `pnpm build` (10/10), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `pnpm --filter @cb/db db:check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T15:52:48.116Z claimed by agent-t062
- 2026-10-13T18:56:29.132Z completed on task/T-062-collection-sessions-cash-handover-and-we

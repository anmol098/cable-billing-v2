---
id: T-045
title: Adjustments, plan change and mid-month start wiring
phase: 2
area: core
status: done
owner: agent-t045
claimed_at: 2026-10-14T05:19:39.880Z
branch: task/T-045-adjustments-plan-change-and-mid-month-st
depends_on: [T-042, T-034, T-023, T-041]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/adjustments/**, packages/core/src/connections/hooks/**, apps/web/src/app/(operator)/customers/[id]/connections/_plan-change/**, apps/web/src/app/(operator)/bills/adjustments/**]
---

# T-045 — Adjustments, plan change and mid-month start wiring

**Phase** 2 · **Area** core · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-042, T-034, T-023, T-041

## Goal

Changes after the bill create clear, auditable adjustments instead of edits.

## Scope

- Implement T-034 hooks: plan change → netting adjustment; start/reactivate mid-month → per operator policy.
- Owner manual adjustment (debit/credit, reason required) and guided back-dated change flow.
- Plan-change UI on a connection with an effect preview ('₹50 extra will be added to the next bill').
- Adjustments list page under Bills.

## Acceptance criteria

- [x] No path edits an issued invoice.
- [x] Credit adjustments are applied oldest-first (uses T-041).

## Tests required

- Integration scenarios for each row of PLAN §8.3; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/adjustments/**`
- `packages/core/src/connections/hooks/**`
- `apps/web/src/app/(operator)/customers/[id]/connections/_plan-change/**`
- `apps/web/src/app/(operator)/bills/adjustments/**`

## References

PLAN §8.3, FR-008, BR-07, RULE-10, D-14, D-18 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/connections/hooks/index.ts` | T-034's hooks, implemented. `onAssignmentStarted` / `onAssignmentReactivated`: D-18 per `mid_month_start_policy` (`charge_full_month` → a `mid_month_start` debit for the full rental; `start_next_month` → nothing). `onAssignmentPlanChanged`: T-042 netting (`plan_change` debit/credit). Each decides only the change's own month (`periodOf(effectiveDate)`), stores at most one adjustment, runs in the change's transaction with the customer + balance + VC locks held. A domain refusal of the stored rows throws (→ INTERNAL, the change rolls back). |
| `packages/core/src/adjustments/effects.ts` | Pure rules shared by the hooks, the back-dated flow and the preview: `changeMonthEffect`, `laterMonthEffect`, `startedAfterRun`, `expectedRentPaise`, `signedTotalPaise`. |
| `packages/core/src/adjustments/apply.ts` | `adjustChangeMonth` (the hooks' body), `adjustLaterMonths` (the back-dated flow's billed months after the change), `collectChangeMonth` (lets the back-dated flow put the Owner's reason on the hook's adjustment and read what it did), `loadConnectionFacts`, `isPeriodBilled`. |
| `packages/core/src/adjustments/store.ts` | `insertAdjustment` (row + money effect + audit `adjustments.create`), `applyAvailableCredit` (T-041 `applyCredit`), `billedPeriodsOf` (T-034's "billed" definition), `rentalRecordsOf` (T-042 records: rent lines of issued regular bills + every adjustment of the assignment/month), `readMidMonthStartPolicy`, `creditUsedOf`. |
| `packages/core/src/adjustments/services.ts` | The five services below; exported from `@cb/core` (one line in `packages/core/src/index.ts`). |
| `packages/core/src/adjustments/adjustments.isolation.ts` | 8 isolation cases (every service; `not_found` for customer / connection ids, `no_leak` for the list). |
| `apps/web/src/app/(operator)/customers/[id]/connections/_plan-change/**` | "Change plan" (`?change=<assignmentId>`, Owner + Staff) and "Change from an earlier day" (`?backdate=<assignmentId>`, Owner: plan / stopped / started again / removed) on the Connections tab: plan or own amount, "From which day?", **the effect preview before saving** ("October 2026: ₹50 extra will be added to the next bill." / "… ₹50 less. It is taken off what the customer owes." / "In all: ₹100 more to pay."), reason box when the date reaches a billed month (Owner), "Ask the owner" + Save disabled for Staff. Server Actions `previewChangeAction`, `saveChangeAction`. |
| `apps/web/src/app/(operator)/bills/adjustments/**` | Bills → "Bill changes": list (newest first; customer + VC, "₹50 extra" / "₹50 off" in due/credit colour, why = source word + reason + month, "Next bill" / "On bill INV-…" (links the bill) / "Taken off", date + who), filters (state, made by), "Waiting for the next bills" total, paging; the Owner's "New bill change" (`?new=1[&customer=<id>]`: customer search, Extra charge / Discount, amount, why, summary line with the number). |
| `packages/i18n/messages/{en,hi}/adjustments.json` | New namespace (117 keys, all Hindi in `_review`). `connections.json`: one key `confirm.charge_month` (Hindi in `_review`). Glossary: "Bill change words (web, T-045)", aligned with T-049's "Extra charge" / "Discount". |

**Service API (for T-047, T-049, T-060, T-083, T-084, T-092)**

- `createManualAdjustment` (`adjustments.create_manual`, `adjustments.manage` = Owner) `{ id (form UUID, idempotency key), customerId, direction: "debit"|"credit", amountPaise (1 … ₹1,00,000), reason (3–200, trimmed), assignmentId? }` → `{ outcome: "created"|"duplicate", adjustment: AdjustmentView, creditAppliedPaise }`. Same id + same data → `duplicate` (nothing written, audit skip); same id + other data → CONFLICT `id_reused`; another customer's connection → NOT_FOUND. `period` is null for manual rows (a debit goes on the next bill).
- `backDatedConnectionChange` (`adjustments.back_dated_change`, Owner) `{ assignmentId, effectiveDate, change: { kind: "plan"|"suspend"|"reactivate"|"disconnect", planId?|rentalPaise?, stopReason?, note? }, reason }` → `{ connection, changed, eventId, adjustments[], months: MonthEffectView[], totalPaise }`. Calls T-034's `changePlanInTx` / `changeStatusInTx` with `{ allowBilledPeriod: true }`; the hook adjusts the change's month; every **billed** month after it is corrected to what the bill would charge with the corrected history; every adjustment carries the reason; one extra audit event `adjustments.back_dated_change` lists them.
- `previewConnectionChange` (`adjustments.preview_change`, `dashboard.view` = Owner + Staff, read) same input without `reason` → `ConnectionChangePreview { kind, fromRentalPaise, toRentalPaise, noChange, backDated, latestBilledPeriod, policy, months[], totalPaise }`. Same refusals as the change (VALIDATION `effectiveDate` codes, `change.planId`/`retired`, CONFLICT `invalid_transition`, NOT_FOUND). Tested: the preview equals what the change then does.
- `listAdjustments` (`adjustments.list`, `billing.preview`, read; works in read-only mode) `{ page?, source?, state?: "pending"|"billed"|"credit", customerId? }` → `{ rows: AdjustmentListRow[], page, hasMore, pendingDebitPaise }` (50 per page; another tenant's `customerId` → NOT_FOUND).
- `connectionChargedMonths` (`adjustments.charged_months`, `customers.view`, read) `{ customerId }` → `{ policy, charged: { [assignmentId]: Period[] } }` (the last 6 months + this one that already have rent > ₹0) — the "Start again" sheet uses it to add "₹300 for October 2026 will be added to the next bill." only when true.

**PLAN §8.3 scenarios** (`packages/core/src/adjustments/scenarios.test.ts`, real T-033/T-034/T-044/T-046 services, fixed clock; **after every scenario: no issued bill or bill line changed (row-for-row snapshot), `checkLedger` = [] for every customer, and billing the month again adds nothing**)

| Row | Scenario | Result |
|---|---|---|
| Plan change (D-14, BR-07) | ₹400 billed → ₹500 → ₹300 → ₹450 → ₹450 again: +₹100, −₹200 (credit pays the October bill at once), +₹150, nothing; November bill = rent ₹450 + the two debits; billing November again changes nothing; preview said +₹100 first | pass |
| Plan change | change before the month is billed: no adjustment, the bill charges the new amount | pass |
| New connection / reactivation mid-month (D-18) | `charge_full_month`: start on 10 Oct → `mid_month_start` debit ₹300 (no ledger entry until billed), November bill = rent + debit; October and November billed again → nothing | pass |
| … | `start_next_month`: nothing now, billed from November | pass |
| … | start on the 1st before the month is billed → the bill charges it (`billed_by_run`), no adjustment | pass |
| … | start on the 1st **after** the run: billed customer → debit; customer the run skipped → debit, and re-billing October makes a bill with only the adjustment line (no rent line: T-044's guard); a customer the run never saw → no debit, the re-run bills rent. Never both. | pass |
| … | reactivation mid-month under both policies (+₹300 / nothing) | pass |
| … | billed on the 1st, stopped, started, stopped, started in the same month → nothing (`already_charged`) | pass |
| Disconnection / suspension mid-month | stop on 10 Oct, remove on 12 Oct: no adjustment; November has no rent for them; preview says "no change" | pass |
| Back-dated into a billed period | plan change dated 15 Sep with Sep + Oct billed: Staff refused (`billed_period`), Staff can't call the Owner flow (FORBIDDEN), blank reason → VALIDATION; Owner: Sep +₹100 (hook), Oct +₹100 (later month), reason + author on both, one `adjustments.back_dated_change` audit; preview == result; November bill carries both | pass |
| … | stop dated 20 Sep with Sep + Oct billed: September stays charged, October credited ₹300, and the credit pays **September first** (oldest) | pass |
| … | start again dated 10 Sep after months the run skipped: October gets a `mid_month_start` debit (policy `start_next_month` leaves September); billing October twice → one bill with one charge | pass |
| … | payment in between + back-dated downgrade: −₹200 in all, balance 0, books clean | pass |

Also: `concurrency.test.ts` (6 customers; the October run racing a plan change and a new connection on the 1st for each, real parallel transactions; whatever order wins, each connection's October rent is charged once at the latest amount, books clean, re-run changes nothing — run 3× here); `manual.test.ts` (Owner debit waits and becomes a bill line; Owner credit pays Sep then Oct oldest first; duplicate / `id_reused`; reason / amount VALIDATION; Staff + Lineman FORBIDDEN; another customer's connection NOT_FOUND; read-only tenant → TENANT_READ_ONLY while the list still works; the list's states, bill number, author, filters; preview refusals; charged months + a ₹0 rent line netting up); isolation 8 cases + coverage. Mutation check (reverted): forcing `startedAfterRun = true` fails 6 tests.

**Decisions (please check: `review: required`)**

1. **Credit adjustments are applied at once** (T-041 Q-B for credit adjustments): ledger `credit_adjustment` (−amount), credit += amount, then `applyCredit` over **all** the customer's credit sources, oldest first, to the oldest open bills (BRD §16 / PRD §18 "apply available credit to oldest outstanding invoices by default"; D-14 "credit auto-applies oldest-first"). T-044 keeps applying at the next bill as well; reversals (T-046) still wait for the next bill.
2. **Debit adjustments reach the ledger only through the next bill** (T-041 Q-A default, invariant 3 as written; T-044 bills pending debits). So between the change and the next bill, a pending debit is visible on Bills → Bill changes ("Next bill", and the "Waiting for the next bills" total) but not in the balance. A downgrade netting a *pending* debit (e.g. a mid-month start then a cheaper plan) shows as credit until that bill — it nets exactly at the bill.
3. **`startedAfterRun`** (T-042 Q-2) = NOT (the connection is active during the 1st with the new history (T-040 `isBillable`) AND the month is not billed for the customer yet (T-034's definition: regular bill, or the run's item `created`/`already_exists`/`skipped`)). So a reactivation on the 1st follows the policy (T-040 Q-1), a start on the 1st before the run is the bill's, and a failed run item is the retry's.
4. **Back-dated flow corrections for billed months after the change's month**: should-charge X (T-040 eligibility + `rentalForPeriod`) vs charged Y: base exists → `plan_change` netting of X−Y (also down to ₹0 for a back-dated stop); no base and X > 0 → a `mid_month_start` debit of X (the month's base charge, so T-044's guard never adds rent too). No new adjustment source was needed (no schema/enum change). A month whose rent was netted to ₹0 that is started again follows the policy as a netting debit (T-042 allows one base charge).
5. **Months between the change and the latest billed month that are *not* billed** (e.g. a missed run) are not corrected: their run will bill them from the corrected history.
6. **Automatic adjustments record the person who made the change** in `created_by` (the T-023 column comment says NULL for hooks; the actor is more useful in the list and audit). Their `reason` is NULL unless they come from the Owner's back-dated flow.
7. **Manual adjustments**: Owner only (D-16 / `adjustments.manage`), customer-level (optional connection), `period` NULL (goes on the next bill), max ₹1,00,000, reason 3–200 characters, idempotent on the form's UUID. A closed customer can still get one (corrections after closing).
8. **The Owner's back-dated plan change uses the same "Change plan" screen**: when the preview says the date reaches a billed month, the Owner gets the reason box and saving goes through `adjustments.back_dated_change`; Staff see "Bills for {month} are already made. Ask the owner to change it from this day." and cannot save. Back-dated stop / start again / remove are on "Change from an earlier day".
9. Words follow T-049's account history: **"Extra charge" / "Discount"** (एक्स्ट्रा चार्ज / छूट); the list says "₹50 extra" / "₹50 off" and "Taken off" for credits.

**Open questions**

- Q-1: Decision 1 — apply credit adjustments at once (today) vs only at the next bill (T-041/T-046 default for reversals). Changing it is one call in `store.ts`.
- Q-2: Decision 2 — should a pending debit show in the customer's "Due" before the next bill? Today it doesn't (only on Bill changes).
- Q-3: T-042 Q-1 still open: a later plan change does not net an Owner's manual discount for the same month.
- Q-4: should the back-dated flow also correct a billed month whose bill was voided (no flow voids bills yet)?
- Q-5: Hindi in `adjustments.json` `_review` (H-03), esp. "एक्स्ट्रा चार्ज", "छूट", "घटा दिया", "पहले की तारीख से बदलें".
- Follow-up **T-045a** (new task file): the Owner's back-dated *new connection* (a start dated into a billed month); today "Add connection" still refuses it with `billed_period` for everyone.

**Deviations / files outside the owned paths**

- `packages/core/src/index.ts`: one line `export * from "./adjustments";`.
- T-034 (done), smallest changes: `customers/[id]/connections/page.tsx` (reads `?change=` / `?backdate=`, renders the T-045 panel, `?saved=plan|backdate` notices, loads `connectionChargedMonths`), `_parts/connections-view.tsx` ("Change plan" / "Change from an earlier day" links on each current connection; passes the charged months to the sheet), `_parts/status-actions.tsx` + `_parts/effect.ts` (the "Start again" charge line, as T-034's notes asked), `packages/i18n/messages/{en,hi}/connections.json` (`confirm.charge_month`).
- "New bill change" lives on `/bills/adjustments?new=1` instead of a new route, because T-029's nav test requires every page to be a NAV route.
- No schema, migration, dependency or contract changes.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` c88028d / 29b8e74)

- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm build` (10/10), `pnpm generate` (no diff), `tokens:build --check`, `icons:build --check`, `i18n:build --check`, `openapi:build --check`, `pnpm i18n:check`, `node scripts/tasks.mjs check --local`: all pass.
- `pnpm test`: core 62 files / 890 passed (1 skipped benchmark), web 43 files / 387, domain 373, db 254, contracts 175, ui 210, design-tokens 109, i18n 42, migration 106, config 4.
- Playwright against `next start` (scratch DB `cb_e2e_t045`, `E2E_PORT=3245`, pre-installed Chromium): new `e2e/adjustments.spec.ts` (2 tests: Staff can't save a billed-month plan change and get 404 on Bill changes; the Owner sees each month's "₹50 extra", "In all: ₹100 more to pay", writes why, saves, sees two "Next bill" rows with the reason and ₹100 waiting; a plan change today back down shows "₹50 less …"; New bill change "Discount ₹100" with its summary line, shown on the list; the list fits 360px). Whole suite: 75 tests; with `--workers=2` 70 passed and 3 *other* specs (auth, connections, settings) failed in their `beforeAll` seeding (`users_login_unique`: the same worker re-running a describe's `beforeAll` with the same run id; not touched by this task) — re-run with `--workers=1`: auth + connections + settings + team + adjustments **18/18 passed**. CI uses retries, which start a fresh worker.
- Not done: no look at the screens by eye in Hindi at 360px beyond the automated overflow check.

## Board log

- 2026-10-14T05:19:39.880Z claimed by agent-t045
- 2026-10-14T06:16:48.671Z completed on task/T-045-adjustments-plan-change-and-mid-month-st

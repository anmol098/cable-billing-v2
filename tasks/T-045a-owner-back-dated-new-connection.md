---
id: T-045a
title: Owner back-dated new connection (start dated into a billed month)
phase: 2
area: core
status: done
owner: agent-t045a
claimed_at: 2026-10-14T14:00:30.496Z
branch: task/T-045a-owner-back-dated-new-connection-start-da
depends_on: [T-045]
review: required
claimable_by: agent
size: S
paths: [packages/core/src/adjustments/back-dated-add/**, apps/web/src/app/(operator)/customers/[id]/connections/_backdated-add/**]
---

# T-045a — Owner back-dated new connection (start dated into a billed month)

**Phase** 2 · **Area** core · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-045

## Goal

The Owner can add a connection that really started in a month whose bills are already made, with
an explicit bill change for every billed month (PLAN §8.3 "back-dated effective date").

## Scope

- A service (capability `adjustments.manage`) that calls T-034's `addConnectionInTx(…, { allowBilledPeriod: true })`
  inside `collectChangeMonth` and then T-045's `adjustLaterMonths` (kind `start`), with the Owner's
  reason on every adjustment, plus one `adjustments.back_dated_change` audit event; a preview the
  same way (`changeMonthEffect` / `laterMonthEffect` on the would-be timeline).
- The "Add connection" form (T-034): for the Owner, a start date in a billed month shows the
  per-month effect and asks for a reason instead of refusing with `billed_period`.

## Out of scope

- Plan changes and stop / start again / remove dated back (done in T-045).

## Acceptance criteria

- [x] A start dated two billed months back charges the start month per the D-18 policy and each
      later billed month its full rent, once; billing those months again adds nothing.
- [x] Staff are still refused (`billed_period`); no issued bill or line changes; `checkLedger` clean.

## Tests required

- Integration scenarios (both policies, a later billed month that was skipped), isolation cases, a
  Playwright flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/adjustments/back-dated-add/**`
- `apps/web/src/app/(operator)/customers/[id]/connections/_backdated-add/**`

## References

PLAN §8.3, D-18, T-034 / T-045 completion notes — see `docs/IMPLEMENTATION_PLAN.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/adjustments/back-dated-add/services.ts` | `backDatedAddConnection` (`adjustments.back_dated_add`, `adjustments.manage` = Owner) and `previewAddConnection` (`adjustments.preview_add`, `dashboard.view` = Owner + Staff, read). Exported from `@cb/core` through one line in `packages/core/src/adjustments/index.ts`. |
| `…/back-dated-add/months.ts` | `coveredPeriods` (the months that must be charged explicitly) and `planOfAdd` (start-month correction, later months, whether the Owner's flow is needed). |
| `…/back-dated-add/inputs.ts`, `types.ts` | `BackDatedAddConnectionInput` (= T-034 `AddConnectionInput` ∩ `{ reason, expectedTotalPaise }`), `PreviewAddConnectionInput` `{ customerId, planId? \| rentalPaise?, startDate }`; `AddConnectionPreview`, `BackDatedAddConnectionResult`. |
| `…/back-dated-add/back-dated-add.isolation.ts` | 4 isolation cases (both services; another tenant's customer, with and without its plan → NOT_FOUND, nothing written). |
| `…/back-dated-add/scenarios.test.ts` | 11 integration scenarios (below). |
| `apps/web/src/app/(operator)/customers/[id]/connections/_backdated-add/**` | The Owner's "Add connection" (`?add=1`): T-034's `ConnectionFields` with no lower date limit; after each edit it asks `previewAddAction` (stale answers ignored); when the add needs the Owner's flow it shows the effect month by month ("New connection: ₹300 a month from 10 Sep 2026.", T-045's month / total / "Bills up to … are already made" lines), the reason box and "Save with bill changes", and posts the shown total. A stale save ("The bills changed while you were looking. Check the new amounts below, then save again.") re-asks the preview. `?saved=backdate` only when adjustments were made. Staff keep T-034's form. |
| `apps/web/e2e/backdated-add.spec.ts` | Playwright: Staff refused; Owner sees "₹300 extra" for last month and this month + "In all: ₹600 more to pay.", is refused without a reason, then saves; two "Next bill" rows with the reason in Bills → Bill changes, ₹600 waiting; the form fits 360px. |
| `tasks/T-045b-…md` | Follow-up: the same gap in the plain `connections.add` / "start again" (below). |

**Which months are charged** (`months.ts`)

- A month P is **covered** when it is billed for the customer (T-034: a regular bill, or the run's item `created` / `already_exists` / `skipped`) **or** P has a billing run that is not `skipped` (pending, running, completed, completed with errors, failed). A completed run never comes back (T-044, D-25) and a running one may already have passed the customer (`candidateCustomers` takes only customers with a connection or pending debit on the 1st, ids ascending). A `mid_month_start` debit for P is safe whatever the run does next: T-044's per-period guard then bills the debit instead of a rent line, once. A `skipped` run (read-only tenant) billed nobody; if the Owner starts it by hand it bills the rent like everyone's.
- **Start month:** the D-18 policy (the T-045 hook), **except a start on the 1st** (`isBillable(timeline, startPeriod)`) of a covered month: the full rent, whatever the policy (PLAN §8.1: active on the 1st → charged; D-18 covers mid-month starts only). Merged into one `change_month` line.
- **Every covered month after the start month:** the full rent (T-045 `laterMonthEffect`, via `adjustLaterMonths` with the new optional `months` list).
- **A month with no run at all** (a missed run): nothing; its run, when started, bills the connection.
- The add **needs the Owner's flow** (`backDated` in the preview) when it has a month to correct; otherwise it is an ordinary add.

**Service API**

- `backDatedAddConnection.call(rt, ctx, { customerId, vcNumber, planId? | rentalPaise?, startDate, reason, expectedTotalPaise })` → `{ connection, vcAssetCreated, previous, eventId (the activated event), adjustments: AdjustmentView[], months: MonthEffectView[], totalPaise }`. Steps: T-034 `addConnectionInTx(…, { allowBilledPeriod: true })` inside T-045 `collectChangeMonth(reason)` (the hook decides the start month with the Owner's reason) → covered months → T-045 `adjustLaterMonths({ kind: "start", months })` → total compared with `expectedTotalPaise` → one `adjustments.back_dated_change` audit event (`kind: "start"`, `effectiveDate`, `reason`, `eventId`, `adjustmentIds`, `totalPaise`).
  Refusals, nothing written (the transaction rolls back): `connections.add`'s (NOT_FOUND, VALIDATION, CONFLICT `customer_closed` / `vc_retired` / `vc_in_use`), VALIDATION `reason` (3–200), **VALIDATION `startDate`/`not_back_dated`** (nothing to correct: an ordinary add belongs to `connections.add`, so no back-dated audit event is ever written for it), **CONFLICT `preview_stale`** (`details.totalPaise` = the new total; e.g. a run started between preview and save). Staff → FORBIDDEN. A second click with the same VC → `vc_in_use`.
- `previewAddConnection.call(rt, ctx, { customerId, planId? | rentalPaise?, startDate })` → `AddConnectionPreview { customerId, startDate, rentalPaise, backDated, latestBilledPeriod (latest billed-or-run month), policy, months, totalPaise }`. Same refusals as the add (except the VC's) in the same order; the same rules on the would-be timeline. Tested: the add's `months` / `totalPaise` equal the preview's.

**Scenarios** (`scenarios.test.ts`; real T-033/T-034/T-044 services, fixed clock; every save sends the previewed total; each checks no issued bill or line changed and `checkLedger` = [])

| Scenario | Result |
|---|---|
| Start 10 Sep with Sep, Oct, Nov billed (today 14 Nov), **`charge_full_month`** | Staff `connections.add` → `billed_period`; Staff on the Owner service → FORBIDDEN; blank / 2-letter reason → VALIDATION; a wrong total → `preview_stale`; nothing written. Then Sep +₹300, Oct +₹300, Nov +₹300 (₹900), reason + Owner on each, ledger unchanged, one audit event; second click → `vc_in_use`; re-billing Sep–Nov changes nothing; December = rents ₹700 + ₹900, once | pass |
| Same, **`start_next_month`** | Sep nothing; Oct +₹300, Nov +₹300 (₹600); December ₹700 + ₹600 | pass |
| Later months the run **skipped** (customer stopped from 20 Sep), start 25 Sep, both policies | Oct +₹250, Nov +₹250 (+ Sep under `charge_full_month`); re-billing Oct and Nov twice: one bill each, adjustment lines only | pass |
| **Review repro:** VC removed 20 Oct, **Nov run completed with no item for the customer**, start 10 Sep (`charge_full_month`) | Sep, Oct **and Nov** +₹300 (₹900, preview too); re-running Nov twice + December: Nov bill = the three debits, December = rent; each month once | pass |
| Nov run **in progress with its cursor past the customer**, start 10 Sep (`start_next_month`) | Oct and Nov +₹300; the run finishes without the customer; December bills the two debits + rent, once | pass |
| A month with **no run** (Sep and Nov ran, no Oct run), start 10 Sep | Sep and Nov only; the late Oct run bills a rent line once | pass |
| Start on **1 Oct** with Oct billed, `start_next_month` | Oct +₹300 (full rent, PLAN §8.1), Nov +₹300; preview = result | pass |
| **Reviewer's test:** Oct item `skipped`, start 1 Oct, `start_next_month`, Oct billed again twice | exactly one ₹250 charge for October (adjustment line), November rent | pass |
| An ordinary start day (10 Nov, nothing to correct) | preview `backDated: false`; the Owner flow refuses `not_back_dated`, no assignment, no back-dated audit event; `connections.add` takes it | pass |
| Refusals | start after tomorrow (add + preview), plan and amount both, Lineman FORBIDDEN, the Owner's own customer with **another tenant's plan** → NOT_FOUND (add + preview), VC already on the customer → `vc_in_use`; nothing written | pass |

Mutation checks (reverted): no later months in `planOfAdd` → 8 of 11 fail; covered months = billed months only (no run rows) → the two run scenarios fail.

**Decisions (please check: `review: required`)**

1. **Covered months** as above (billed for the customer, or a non-skipped run). (Review fix 1.)
2. **A start on the 1st of a covered month is charged that month's full rent, whatever the D-18 policy** (PLAN §8.1). This replaces the first version's "start month always follows the policy". (Review fix 2.)
3. **The save carries the previewed total**; a different total → CONFLICT `preview_stale`, nothing saved, the form re-asks the preview with a plain-words message. (Review fix 3.)
4. **`not_back_dated` is refused** (VALIDATION) rather than falling through to a plain add: the Owner flow only ever writes back-dated adds; the web form sends ordinary days to `connections.add` and treats the refusal like a stale preview. (Review fix 4.)
5. **Isolation:** the harness passes the victim's seed for the attack, so "A's customer + B's plan" can't be a harness case (T-034's "another tenant's plan" case also stops at the customer lookup). It is tested directly in `scenarios.test.ts`. (Review note 5.)
6. The Owner's add form is one form (only an add that needs the flow shows the effect and reason); the date box has no `min` for the Owner. Preview capability `dashboard.view`; the VC number is not part of the preview.
7. Audit: the existing `adjustments.back_dated_change` action with kind `start` (en + hi sentence). The service's own name is never written (listed in `actions.test.ts`'s `NEVER_THE_DEFAULT_ACTION`).
8. A ₹0 rent back-dated add makes no adjustments; the tab then says "Connection added." (honest states).
9. `adjustLaterMonths` (T-045) got an optional `months` list; the start-month correction's `adjustments.create` audit row says `scope: "later_month"` (it comes from that function); the result and the back-dated audit event list it under the start month.

**Open questions**

- Q-1: **T-045b** (new task file): the same gap in the plain `connections.add` / "start again" — a start on the 1st of a month whose run has passed without the customer, or a later such month, is not charged. Proposed: refuse with `billed_period` and route to the Owner's flow.
- Q-2 (existing, T-034/T-045): a customer no run ever looked at, with no run rows after the start month, has nothing covered: a plain add, billed by later runs only.
- Q-3: Hindi review (H-03): `adjustments.add_backdated.headline`, `adjustments.add_backdated.stale`, the `start` case of `audit.sentence.adjustments.back_dated_change` (all in `_review`).

**Deviations / files outside the owned paths** (smallest changes)

- `packages/core/src/adjustments/index.ts`: one line `export * from "./back-dated-add";`; `packages/core/src/adjustments/apply.ts`: optional `months` on `adjustLaterMonths` (T-045, done).
- `packages/core/src/connections/services.ts`: `resolveRental` exported (T-034, done).
- `packages/core/src/audit-query/actions.test.ts`: one entry in `NEVER_THE_DEFAULT_ACTION` (T-035, done).
- `packages/i18n/messages/{en,hi}/audit.json`: `start` case (T-035, done); `packages/i18n/messages/{en,hi}/adjustments.json`: `add_backdated.headline`, `add_backdated.stale` (Hindi in `_review`); generated `apps/web/messages/*.json`.
- `apps/web/src/app/(operator)/customers/[id]/connections/page.tsx`: the Owner gets `BackDatedAddPanel` (T-034, done).
- `apps/web/e2e/backdated-add.spec.ts`: a new file in T-088's folder; no existing spec edited.
- `tasks/T-045b-…md`: new follow-up task.
- No schema, migration, dependency, contract or token changes.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` b70a86c)

- `pnpm install --frozen-lockfile`, `pnpm lint` (Biome, 1205 files), `pnpm typecheck` (10/10), `pnpm build` (10/10), `pnpm generate` (no diff), `tokens:build --check`, `icons:build --check`, `i18n:build --check`, `pnpm i18n:check`, `openapi:build --check`, `node scripts/tasks.mjs check --local`: all pass.
- `TURBO_FORCE=1 pnpm test --concurrency=1`: 10/10 packages pass; core 1,266 passed (3 skipped), web 571 passed. New or changed: `back-dated-add/scenarios.test.ts` (11), 4 isolation cases + coverage, `actions.test.ts` (audit registry), `_backdated-add/backdated-add.test.tsx` (8: effect text en/hi, preview input, error mapping, plain add, back-dated add with effect + reason + the posted total, stale preview message and re-preview, preview refusal).
- Mutation checks (reverted): no later months → 8 of 11 scenarios fail; covered months without run rows → the completed-run and running-run scenarios fail.
- Playwright against `next start` (fresh scratch DB, `E2E_PORT=3457`, pre-installed Chromium), `--workers=1`: `backdated-add.spec.ts` 2/2, `adjustments.spec.ts` 2/2, `bills.spec.ts` 3/3, `connections.spec.ts` 2/2, `journey-month.spec.ts` (T-088, adds connections as the Owner) 9/9. Before the review: whole suite 107 passed, 1 failed (`signup.spec.ts` under load, passed alone).
- Not done: no look at the form by eye in Hindi at 360px beyond the automated overflow check.

## Board log

- 2026-10-14T14:00:30.496Z claimed by agent-t045a
- 2026-10-14T19:56:10.011Z completed on task/T-045a-owner-back-dated-new-connection-start-da

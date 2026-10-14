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
| `…/back-dated-add/inputs.ts`, `types.ts` | `BackDatedAddConnectionInput` (= T-034 `AddConnectionInput` ∩ `{ reason }`), `PreviewAddConnectionInput` `{ customerId, planId? \| rentalPaise?, startDate }`; `AddConnectionPreview`, `BackDatedAddConnectionResult`. |
| `…/back-dated-add/back-dated-add.isolation.ts` | 4 isolation cases (both services; another tenant's customer, with and without its plan → NOT_FOUND, nothing written; own ids → ok). |
| `…/back-dated-add/scenarios.test.ts` | 7 integration scenarios (below). |
| `apps/web/src/app/(operator)/customers/[id]/connections/_backdated-add/**` | The Owner's "Add connection" (`?add=1`): T-034's `ConnectionFields` with no lower date limit; after each edit it asks `previewAddAction` (stale answers ignored); when the start day reaches back into a billed month it shows the effect month by month (headline "New connection: ₹300 a month from 10 Sep 2026.", T-045's month / total / "Bills up to … are already made" lines), the reason box ("Why are you changing old bills?") and "Save with bill changes". `saveAddAction` → `adjustments.back_dated_add` (back-dated) or `connections.add` (any other day). `?saved=backdate` ("Saved. The bill changes are made.") only when adjustments were made. Staff keep T-034's form. |
| `apps/web/e2e/backdated-add.spec.ts` | Playwright: Staff refused ("Bills for … are already made", nothing saved); Owner sees "₹300 extra" for last month and this month + "In all: ₹600 more to pay.", saving without a reason is refused, then saves; connection on the tab; two "Next bill" rows with the reason in Bills → Bill changes, ₹600 waiting; the form fits 360px. |

**Service API**

- `backDatedAddConnection.call(rt, ctx, { customerId, vcNumber, planId? | rentalPaise?, startDate, reason })` → `{ connection, vcAssetCreated, previous, eventId (the activated event), adjustments: AdjustmentView[], months: MonthEffectView[], totalPaise }`.
  1. T-034 `addConnectionInTx(…, { allowBilledPeriod: true })` inside T-045 `collectChangeMonth(reason)`: the add, `connections.add` audit, and the T-045 hook deciding the **start month** by D-18 (`charge_full_month` → `mid_month_start` debit of the full rent; `start_next_month` → nothing), with the Owner's reason on its adjustment.
  2. T-045 `adjustLaterMonths({ kind: "start" })`: every month after the start month that is billed for the customer gets a `mid_month_start` debit of the full rent (the month's base charge, so T-044's guard never adds a rent line too).
  3. One `adjustments.back_dated_change` audit event, `after.kind = "start"` (+ `effectiveDate`, `reason`, `eventId`, `adjustmentIds`, `totalPaise`).
  Refusals = `connections.add`'s (NOT_FOUND, VALIDATION, CONFLICT `customer_closed` / `vc_retired` / `vc_in_use`) + VALIDATION `reason` (3–200). Staff → FORBIDDEN. A second click with the same VC → CONFLICT `vc_in_use` (`sameCustomer`), nothing written.
- `previewAddConnection.call(rt, ctx, { customerId, planId? | rentalPaise?, startDate })` → `AddConnectionPreview { customerId, startDate, rentalPaise, backDated, latestBilledPeriod, policy, months, totalPaise }`. Same refusals as the add (except the VC's) in the same order; it builds the would-be timeline (a start, nothing else) and runs the same `changeMonthEffect` / `laterMonthEffect` on the same facts. Tested: the add's `months` / `totalPaise` equal the preview's.

**Scenarios** (`scenarios.test.ts`; real T-033/T-034/T-044 services, fixed clock; each checks no issued bill or line changed and `checkLedger` = [])

| Scenario | Result |
|---|---|
| Start 10 Sep with Sep, Oct, Nov billed (today 14 Nov), **`charge_full_month`** | Staff `connections.add` → CONFLICT `billed_period` (period Nov); Staff on the Owner service → FORBIDDEN; blank / 2-letter reason → VALIDATION `reason`; nothing written. Preview = result: Sep +₹300 (change month), Oct +₹300, Nov +₹300, total ₹900; 3 `mid_month_start` debits with reason + Owner, pending; ledger unchanged; one `back_dated_change` audit; second click → `vc_in_use`; re-billing Sep, Oct, Nov changes nothing; December bill = rents ₹400 + ₹300 + the three debits (₹1,600), billed once | pass |
| Same, **`start_next_month`** | Sep "no charge, rent starts from the next month"; Oct +₹300, Nov +₹300, total ₹600; December ₹700 + ₹600 | pass |
| **Later billed months the run skipped** (customer stopped from 20 Sep, so the Oct and Nov runs found nothing to bill), start 25 Sep, both policies | Oct +₹250, Nov +₹250 (+ Sep ₹250 under `charge_full_month`); Owner re-bills Oct and Nov twice each: one bill each, adjustment lines only (no rent line); December = rent ₹250 | pass |
| **A later month whose run was missed** (Sep and Nov billed, no Oct run), start 10 Sep | Sep +₹200 and Nov +₹200 only; Oct gets nothing; the late Oct run bills a ₹200 rent line (plus Sep's waiting debit) once; December rent + Nov debit | pass |
| Start on the 1st of a billed month (Oct 1, `start_next_month`) | Oct follows the policy (nothing), Nov +₹300 | pass |
| Refusals | start after tomorrow (add + preview), plan and amount both, Lineman → FORBIDDEN, VC already on the customer → `vc_in_use`; a start inside the latest billed month is `backDated: false` | pass |

Mutation check (reverted): not correcting the later months fails 6 of the 7 scenarios.

**Decisions (please check: `review: required`)**

1. **The start month follows the D-18 policy even when the start day is the 1st** of an already-billed month (the T-045 hook's rule, T-045 decision 3: the month's bill did not charge it). Under `start_next_month` that month is free, although "on the 1st before the run" would have been charged. The acceptance criterion says "the start month per the D-18 policy", so I kept it; the alternative is a one-line special case.
2. **Later billed months get the full rent** as a `mid_month_start` debit (T-045's `laterMonthEffect`), whatever the policy. A month the run *skipped* for the customer counts as billed (T-034's definition) and is charged; a month whose run never happened is left to that run (T-045 decision 5).
3. **The Owner's add form is one form**: for the Owner, "Add connection" is this form for every start day; only a back-dated day shows the effect and asks why. Staff keep T-034's form and its `billed_period` refusal. The Owner's date box has no `min`.
4. **Preview capability** `dashboard.view` (read, like T-045's preview); the VC number is not part of the preview (its problems come with the save).
5. Audit: the existing `adjustments.back_dated_change` action with the new kind `start` (en + hi sentence: "… added VC … from an earlier day, {date}"). The service's own name is never written as an action (listed in `actions.test.ts`'s `NEVER_THE_DEFAULT_ACTION`).
6. A ₹0 rent back-dated add makes no adjustments; the tab then says "Connection added." instead of "The bill changes are made." (honest states).

**Open questions**

- Q-1: decision 1 (start on the 1st of a billed month under `start_next_month`).
- Q-2 (existing, T-034/T-045): a customer the runs never looked at has no billed month, so any start date is a plain add and the months already run are only billed if the Owner re-runs them. Not changed here.
- Q-3: Hindi `adjustments.add_backdated.headline` and the `start` case of `audit.sentence.adjustments.back_dated_change` (H-03; both already in `_review`).

**Deviations / files outside the owned paths** (smallest changes)

- `packages/core/src/adjustments/index.ts`: one line `export * from "./back-dated-add";` (T-045, done).
- `packages/core/src/connections/services.ts`: `resolveRental` exported (one word + comment) for the preview (T-034, done).
- `packages/core/src/audit-query/actions.test.ts`: one entry in `NEVER_THE_DEFAULT_ACTION` (T-035, done).
- `packages/i18n/messages/{en,hi}/audit.json`: `start` case in `sentence.adjustments.back_dated_change` (T-035, done); `packages/i18n/messages/{en,hi}/adjustments.json`: one key `add_backdated.headline` (Hindi in `_review`); generated `apps/web/messages/*.json`.
- `apps/web/src/app/(operator)/customers/[id]/connections/page.tsx`: the Owner gets `BackDatedAddPanel` instead of `AddConnectionForm` (T-034, done).
- `apps/web/e2e/backdated-add.spec.ts`: a new file in T-088's folder (as T-034/T-045 did); no existing spec edited.
- No schema, migration, dependency, contract or token changes.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 5452f5d)

- `pnpm install --frozen-lockfile`, `pnpm lint` (Biome, 1181 files), `pnpm typecheck` (10/10), `pnpm build` (10/10), `pnpm generate` (no diff), `tokens:build --check`, `icons:build --check`, `i18n:build --check`, `pnpm i18n:check`, `openapi:build --check`, `node scripts/tasks.mjs check --local`: all pass.
- `TURBO_FORCE=1 pnpm test --concurrency=1`: 10/10 packages pass; core 1,225 passed (3 skipped), web 554 passed. New: `back-dated-add/scenarios.test.ts` (7), 4 isolation cases + coverage, `actions.test.ts` (audit registry), `_backdated-add/backdated-add.test.tsx` (7: effect text en/hi, preview input, error mapping, form plain add / back-dated add with effect + reason / preview refusal).
- Playwright against `next start` (fresh scratch DB `cb_e2e_t045a`, `E2E_PORT=3457`, pre-installed Chromium): new `backdated-add.spec.ts` 2/2. Whole suite with `--workers=2`: 107 passed, 1 failed (`signup.spec.ts`: a 5 s URL wait after "Start" under load; not touched by this task) which passed when re-run alone (2/2).
- Not done: no look at the form by eye in Hindi at 360px beyond the automated overflow check.

## Board log

- 2026-10-14T14:00:30.496Z claimed by agent-t045a
- 2026-10-14T19:56:10.011Z completed on task/T-045a-owner-back-dated-new-connection-start-da

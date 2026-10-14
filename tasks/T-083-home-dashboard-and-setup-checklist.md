---
id: T-083
title: Home dashboard and setup checklist
phase: 4
area: web
status: done
owner: agent-t083
claimed_at: 2026-10-14T05:47:07.708Z
branch: task/T-083-home-dashboard-and-setup-checklist
depends_on: [T-044, T-046, T-062]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/home/**, packages/core/src/dashboard/**, packages/i18n/messages/*/home.json]
---

# T-083 — Home dashboard and setup checklist

**Phase** 4 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-044, T-046, T-062

## Goal

One glance tells the owner how today and this month are going.

## Scope

- Tiles: today cash, today UPI, month billed vs collected, total due, last bill run status.
- Alerts: handovers waiting, payments needing review, subscription state.
- Setup checklist (plans → customers → linemen → install app with Play link/QR) auto-ticks from data.

## Acceptance criteria

- [x] Loads < 1 s on `legacy` seed (cached aggregates acceptable). Measured without caching: `dashboard.home` median **33 ms** (7 calls: 23–164 ms, transaction included) for the biggest operator of the `legacy` seed (1,393 customers, 23 months). See `dashboard.bench.test.ts`.

## Tests required

- Service tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/home/**`
- `packages/core/src/dashboard/**`
- `packages/i18n/messages/*/home.json`

## References

PLAN §12.1 (Home), PLAN §12.3, BRD §12 (Operator dashboard) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/dashboard/` (`export * from "./dashboard";` in core's index) | Service **`homeDashboard`** (`dashboard.home`, capability `dashboard.view`: Owner + Staff, read-only, allowed in read-only mode), input `HomeDashboardInput` (`{}`, strict). Types `HomeDashboard`, `CollectedMoney`, `SubscriptionSummary`, `SETUP_STEP_KEYS` / `SetupStepKey`. Pure rules `daysBetween`, `subscriptionSummary`. Isolation case `dashboard.isolation.ts`. Tests: `home.test.ts` (DB), `rules.test.ts`, and `dashboard.bench.test.ts` (legacy seed, off unless `CB_HOME_BENCH=1`). |
| `apps/web/src/app/(operator)/home/page.tsx` | `/home`: `ShellPageHeader` ("Home" + one sentence) with the primary action **Take payment** (`/payments/new`, pinned at the bottom on phones), then `HomeView`. |
| `apps/web/src/app/(operator)/home/_components/home-view.tsx` | Body: **setup checklist** first (hidden once all done), **Today** (cash and UPI tiles, `text-amount`, plus the payment count), **To check** (alert rows), **This month** (Bills made, Money taken split cash/UPI, Total due in the due colour, the latest bill run's `RunStatePill`). Each tile and alert is a link, or a plain card when the role can't open the target. `homeSetupSteps(can, setup, detail)` adds the Play Store link and QR code to the app step. |
| `.../home/_components/app-qr.tsx` | `AppQr` + `qrPath(text)`: the Play Store URL as an SVG QR code (one path, `currentColor`, server-rendered), using the new dependency **`uqr@0.1.3`** (MIT, no dependencies) in `apps/web`. |
| `.../home/_lib/links.ts` | `homeLinks(view, can)` gives each tile and alert its target, or `null` when `canSeeRoute` says no. |
| `packages/i18n/messages/{en,hi}/home.json` | Namespace `home` (web only). **All Hindi is machine-drafted and listed in `_review`.** Glossary: new "Home words" table. |

**How each number is defined** (each is tested to equal its source for the same IST day; `home.test.ts`)

| Tile / alert | Definition | Equals | Link |
|---|---|---|---|
| Cash today / UPI today | Σ `payments.amount_paise` with `business_date` = today (IST), by method, no `payment_reversals` row; all sources (field, counter) | `listPayments({ from: today, to: today }).totals` | `/payments?method=cash` / `?method=upi` |
| Money taken (month) | same, `business_date` from the 1st to today | `listPayments({ from: period, to: today }).totals` | `/payments?from=…&to=…` |
| Bills made | count and Σ `charges_paise` of regular, issued invoices of the current period | `billingMonths` month card | `/bills/register?month=` |
| Total due | Σ max(Σ `ledger_entries.amount_paise`, 0) per customer; customers with credit count 0. Also equals Σ positive `customer_balances` (tested) | the dues report's total due (T-080) | `/reports/dues` |
| Latest bill run | newest `billing_runs` row by period (any status) | `billingMonths(...).run` | `/bills/runs?month=` (or `/bills` before the first run) |
| Handovers to check | `collection_sessions.status = 'submitted'`, any day; count + oldest day | `getLinemenDay(...).totals.waitingCount` per day | `/linemen?date=<oldest>` |
| Payments to check | `payments.review_status = 'needs_review'` | `listPayments({ status: "to_check" }).totals.count` | `/payments/review` |
| Missed bill runs | `billing_runs.status = 'skipped'`; count + oldest | `missedRuns` | `/bills/runs?month=<oldest>&preview=1` |
| Free trial | `subscriptions.status = 'trialing'`: the IST end day and days left (never below 0) | — | `/settings/subscription` (Owner only) |
| Checklist | plans: any `plans` row · customers: any `customers` row · linemen: any user with role `lineman` · app: any `devices` row (a lineman has signed in on a phone) | — | T-029's `setupStepsFor` routes; app → Play Store (new tab) |

**Decisions**

1. **One service and one snapshot.** `dashboard.home` reads everything in one `REPEATABLE READ`, `READ ONLY` transaction with three set-based statements (one row of aggregates, the latest run, the subscription row). It doesn't call the other services, because each of those opens its own transaction. Instead, tests check that every number equals what those services return. No caching: it runs in 33 ms on the legacy seed.
2. **Total due comes from the ledger**, using the same rule as T-080's `duesReport`, not from the `customer_balances` read model. T-080 isn't merged yet, so Home doesn't import `duesReport`, which would also do the ageing and list work Home doesn't need. The test compares Home's total with the ledger and with `customer_balances`. Once T-080 merges, a test can assert `duesReport(...).totals.duePaise` equality.
3. **"Today" and "this month" use IST business dates** (`payments.business_date`, the day the money was taken), the same as the payment register. Undone payments are left out. Counter and field payments both count. A phone payment synced late counts on the day it was taken.
4. **Subscription on Home:** only the **free trial** row (Owner only, with "Pay now"). Grace and view-only already show in the shell banner directly above the page, so a second copy on Home would repeat it. PLAN §11.9 also limits the grace warning to the Owner. Home never uses `role="status"`, so the banner stays the only status region (`shell.spec.ts` relies on that).
5. **Handovers waiting covers any day**, not only today. The link opens the Linemen page on the oldest day with a waiting handover.
6. **Layout for low literacy:** the checklist comes first for a new business. Numbers are the biggest text. Every tile has an icon, a colour and a short word. Today's tiles take a full row each on phones (`text-amount`). No alerts shows "Nothing to check now." with a green tick.
7. **The QR code is drawn on the server as SVG in token colours** (`text-text` on `bg-bg`). There is no image file and no client JavaScript. It encodes T-032's `LINEMAN_APP_URL` (the placeholder application id until H-02).

**Deviations / files outside the owned paths**

- `apps/web/src/components/shell/setup-checklist.tsx` (T-029, done): `SetupStep` gets two optional fields, `external` (opens `href` in a new tab with `rel="noopener noreferrer"`) and `detail` (shown under a step that isn't done). `setupStepsFor` is unchanged, so T-029's tests pass unchanged.
- `apps/web/e2e/shell.spec.ts` (T-029, done): its "Staff's checklist has one step" assertion used a business that already has a customer. With real done flags, Staff's only step is done there and the checklist hides. It now asserts no checklist. `home.spec.ts` covers Staff's single step on a new business.
- `apps/web/package.json` + `pnpm-lock.yaml`: `uqr` (QR code).
- `packages/core/src/index.ts` (one line), `packages/i18n/glossary.md` (new table), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/home.spec.ts`.

**Open questions (product owner)**

- Should Home also show grace / view-only (today only the shell banner does), and should Staff see the trial? Today: no and no (PLAN §11.9).
- The "app installed" tick means a lineman has signed in on a phone at least once (a `devices` row, even if later signed out). Is that the right meaning?
- Total due includes inactive (closed) customers who still owe, matching the ledger and the dues report. Confirm.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core` `dashboard/home.test.ts` (DB, 6 tests): a busy tenant on 14 Oct 2026, built through the real services. It has October bills, counter and field cash/UPI today, an undone payment, an earlier-this-month and a last-month payment, a flagged payment from a closed customer, a customer with credit, a submitted handover, the October run and two missed months. A second busy tenant is added on the same day. Every number equals `listPayments` (today and month), `billingMonths`, `missedRuns`, `getLinemenDay`, `listPayments(to_check)`, the ledger, and Σ positive `customer_balances`, plus absolute values. Staff get the same view. Handovers waiting across days pick the oldest. A new business gets zeros and checklist flags that tick one by one (plan, customer, lineman, phone). Read-only mode and no subscription row read as view-only. Trial days left are counted in IST days. Lineman → FORBIDDEN, unknown input → VALIDATION. `rules.test.ts` covers days across months, years and leap years, the IST day boundary of the trial end, and never-negative days. The isolation case `dashboard.home` (no_leak, Owner and Staff) passes, and so does the coverage test.
- Bench (`CB_HOME_BENCH=1`, legacy seed, 75 s to seed): median 33 ms; its due equals the ledger.
- `apps/web` vitest: `home-view.test.tsx` (12 tests: today tiles and links, month tiles incl. the cash/UPI split and the due colour, the run pill, alert rows and links, run problems in red, Hindi, the new-business checklist with the external Play link and QR before the numbers, ticking, zeros + trial + "Not made", the trial's last day in Hindi, Staff's one step without the trial, Hindi checklist; `qrPath` quiet zone and finder) and `links.test.ts` (4).
- Playwright `e2e/home.spec.ts` (4 tests, serial, per-run unique logins): a **new business** Owner sees the checklist "0 of 4 done", the Play link (new tab) and QR, zeros, the trial row → `/settings/subscription`, no `status` region, "Add plans" → `/settings/plans`. At 360 px, EN and HI, there is no sideways scroll. Staff see one step and no trial. In a **busy business** every tile and alert opens the page that shows the same number: register cash ₹340 / UPI ₹150 (today and month), bill register ₹800 / 2 bills, `/reports/dues`, the month's run summary, Linemen "1 handover to check" on today, "Payments to check" listing the closed customer, the missed month's preview. A 360 px Staff user sees "Take payment" → `/payments/new`, in Hindi too. Screenshots (1280 busy, 360 new EN/HI, 360 busy HI) checked by eye.
- Whole e2e suite against a fresh migrated scratch DB (`E2E_PORT=3283`): 75 passed, 2 failed in `connections.spec.ts` / `settings.spec.ts` (unchanged files). Their `beforeAll` re-inserts the same logins when a worker runs it twice (the known e2e-seeding issue another agent is fixing). Both pass when run alone.
- Root: `pnpm install`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10, DB suites ran: core 875, web 391), `pnpm build` (10/10), `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-14T05:47:07.708Z claimed by agent-t083
- 2026-10-14T06:27:56.007Z completed on task/T-083-home-dashboard-and-setup-checklist

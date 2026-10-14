---
id: T-081
title: Reports: daily collections, handover, connection status, billing runs
phase: 4
area: web
status: done
owner: agent-t081
claimed_at: 2026-10-14T08:08:30.046Z
branch: task/T-081-reports-daily-collections-handover-conne
depends_on: [T-062, T-044, T-034]
review: self
claimable_by: agent
size: M
paths: [packages/core/src/reports/operations/**, apps/web/src/app/(operator)/reports/collections/**, apps/web/src/app/(operator)/reports/handover/**, apps/web/src/app/(operator)/reports/connections/**, apps/web/src/app/(operator)/reports/billing-runs/**]
---

# T-081 — Reports: daily collections, handover, connection status, billing runs

**Phase** 4 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-062, T-044, T-034

## Goal

Operational reports from BRD §12.

## Scope

- Daily lineman collections (cash/UPI split), cash handover reconciliation, connection status/rental report, billing-run report (created/skipped/failed with reasons).

## Acceptance criteria

- [x] Cash and UPI always separate columns.

## Tests required

- Report query tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/reports/operations/**`
- `apps/web/src/app/(operator)/reports/collections/**`
- `apps/web/src/app/(operator)/reports/handover/**`
- `apps/web/src/app/(operator)/reports/connections/**`
- `apps/web/src/app/(operator)/reports/billing-runs/**`

## References

FR-023, BRD §12 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/reports/operations/` (exported from `@cb/core` with one line `export * from "./reports/operations";`) | Four read services (below), `range.ts` (`resolveDayRange`, `daysInRange`, `REPORT_MAX_DAYS` = 31), `types.ts`, isolation cases (`operations.isolation.ts`, 9 cases), a scripted test world (`test-world.ts`, not exported) and DB tests per report. |
| `apps/web/src/app/(operator)/reports/collections/` | `/reports/collections?from=&to=&collector=&page=` (default today): as-of line, filters (from / to day, taken by), totals row (Cash, UPI + "UPI is not cash", payments + "n cancelled (₹x), not counted", people), **Who took how much** (Who, Cash, UPI, Payments) and **Day by day** (Who and day, Cash, UPI, Payments), pages. Cash and UPI column headings carry their icon + colour + word. A row opens `/reports/payments` for that person and those days. `_lib/days.ts` (`pickDays`, `paymentsReportHref`, shared with the handover page), `_lib/test-fixtures.ts`, `_components/collections-view.tsx`. |
| `apps/web/src/app/(operator)/reports/handover/` | `/reports/handover?from=&to=&lineman=&status=&difference=&page=` (default the last 7 days): as-of, filters (days, lineman, status, short / extra), totals row (cash expected + "UPI ₹x is not cash", cash handed over, "₹50 short · ₹20 extra" or "Cash matches", not handed over yet), a status line (waiting / sent back / accepted / not handed over), one row per lineman's day (Lineman and day, Cash expected (+ UPI apart, + "₹x expected at handover" when the total moved), Cash handed over, Difference + lineman's reason, Status + **What happened** `<details>` with every step, who, when (IST) and notes). A row opens T-062's `/linemen/[id]?date=`. |
| `apps/web/src/app/(operator)/reports/connections/` | `/reports/connections?date=&area=&status=&plan=&page=` (default today; `plan=own` = own amount): as-of, filters, "Connections on {day}", totals row (Active n + customers, monthly rent of active connections, Stopped, Removed + all), table (Customer + code · area, VC number, Status pill + "From {day}", Monthly rent + plan / Own amount). A row opens the customer's Connections tab. |
| `apps/web/src/app/(operator)/reports/billing-runs/` | `/reports/billing-runs?month=&outcome=&area=&page=` (default the latest run's month): as-of, filters (month with its run state, result, area), run summary (state pill + T-047's sentence, "Made by itself on the 1st" / "Made by itself later" / "Made by {name}", started / finished), totals row (customers checked (+ already had a bill), new bills + their total, nothing to bill, problems), table (Customer, Result pill, Bill amount + number, Why in plain words + tries), problems first. A row opens the bill, or the customer when there is no bill. Link to `/bills/runs` for that month. |
| `packages/i18n/messages/{en,hi}/reports.json` | New top-level keys `days`, `collections`, `handover`, `connections`, `billing_runs` (T-080's namespace, as its notes ask). **All new Hindi is machine-drafted and listed in `_review`.** Handover, connection and bill-run words are reused from `linemen`, `connections` and `bills` (one vocabulary). Glossary: new "Operations report words" table. |
| `apps/web/e2e/reports-operations.spec.ts` | Playwright (below). |

**APIs for later tasks** (`@cb/core`; capability `reports.view` = Owner + Staff; READ ONLY + REPEATABLE READ, so rows and totals come from one snapshot; allowed in read-only mode; "as of" = the call's clock; another tenant's / made-up filter id → NOT_FOUND; lineman → FORBIDDEN)

| Service | Input → output |
|---|---|
| `collectionsReport` (`reports.collections`) | `{ from?, to? (IST days, default today, ≤ 31 days, not after today, else VALIDATION fields from/to: future / before_from / too_many_days), collectorId?, page? }` → `CollectionsReport { asOf, from, to, collectors: ReportPerson[], totals: CollectionAmounts & { people }, byCollector: CollectionPersonRow[] (+ days), rows: CollectionDayRow[] (50 per page; newest day, then name), rowCount, page, pageSize }`. `CollectionAmounts { cashPaise, upiPaise, count, cancelledCount, cancelledPaise }` (cash and UPI never summed); `collectorId: null` = payments from the old app. |
| `handoverReport` (`reports.handover`) | `{ from?, to? (default the last 7 days), linemanId?, status?: open\|submitted\|accepted\|returned, difference?: short\|extra, page? }` → `HandoverReport { asOf, from, to, linemen, totals { days, cashExpectedPaise, upiTotalPaise, cashHandedOverPaise, notHandedOverPaise, shortPaise, extraPaise, differenceCount, byStatus }, rows: HandoverReportRow[] { sessionId, linemanId, linemanName, linemanActive, businessDate, status, cashExpectedPaise, upiTotalPaise, paymentCount, handover (latest: snapshot expected, handed, discrepancy, reason, note, submittedAt, reviewedAt, reviewedByName, reviewNote) \| null, changedSinceHandover, history: HandoverEventView[] }, page, pageSize }`. |
| `connectionsReport` (`reports.connections`) | `{ date? (default today; future → VALIDATION field date), areaId?, status?: active\|suspended\|disconnected, plan?: <plan id> \| "own" (OWN_AMOUNT), page? }` → `ConnectionsReport { asOf, date, isToday, areas, plans (+ retired), totals { connections, byStatus, activeRentPaise, activeCustomers }, rows: ConnectionReportRow[] { assignmentId, customer…, area…, vcNumber, status, since, startDate, endDate, planId, planName, rentPaise }, page, pageSize }`. |
| `billingRunReport` (`reports.billing_runs`) | `{ period? (YYYY-MM-01; default the latest run's month, else this month), outcome?: created\|already_exists\|skipped\|failed, areaId?, page? }` → `BillingRunReport { asOf, period, runs: { id, period, status }[] (newest first), areas, run: BillingRunReportRun \| null (status, trigger, skipReason, started/finished, startedByName, the run's own counters and total), totals { customers, byOutcome, createdChargesPaise, alreadyExistsChargesPaise }, rows: BillingRunReportRow[] { itemId, customer…, outcome, reason (machine code), invoiceId, invoiceNumber, chargesPaise, attempts, lastTriedAt }, page, pageSize }`. |

- **T-082 (CSV exports):** call these with the page's filters and walk `page` until a short page (collections: `rowCount`); put `asOf.at` in the file name or header. Cash and UPI stay two columns in the files too. Translate reasons with `problemReasonKey` (T-047) and the `reports.billing_runs.why.*` words, never export machine codes as the only text.

**Decisions**
1. **Collections include every person** (linemen's phone payments, Owner / Staff counter payments, payments from the old app with no collector) so the totals equal the payment register (`listPayments`) for the same days and person; each row says the person's role, so "lineman" collections are the lineman rows. A lineman's day equals T-062's session totals (tested).
2. **Cash and UPI are never added together** in these reports (B-014 / RULE-14): two columns and two totals, no "Cash + UPI" figure (the payment register keeps T-080's).
3. **IST business days** (`payments.business_date`, the day the money was taken = the day of the lineman's session), at most 31 days per report (one long month); bad URL days fall back to the default with a message.
4. **As of now** for all four (like T-080's bill and payment registers): payments counted when they reached the office (`posted_at`) and undos when made, both before the call's clock; one REPEATABLE READ snapshot. Handover and connection rows are the current state (the history column shows earlier steps).
5. **Handover "Cash expected" = the running total now** (T-062's rule: phone cash, not undone); the difference is the one stored at handover (vs the snapshot), and when the total moved after the handover the row also shows "₹x expected at handover", as T-062's review screen does. UPI is shown apart as "not part of the cash".
6. **Connection status = the status during the chosen day** (T-040 `assignmentStatusOn`: a stop / start again / removal counts from the next day), "since" = the first day of that status; **rent = the month's rent** (T-040 `rentalForPeriod`, the plan of the month). Computed in SQL with T-044's mapping; compared with T-040's functions for every connection on 39 days.
7. **Billing run report** lists `billing_run_items` (customers the run looked at), problems first; customers the run never looked at (removed before the 1st, not started) are not in it. Reasons are plain words: `nothing_to_bill` → "No connection was on on the 1st.", failures through T-047's three reason sentences.
8. All web pieces stay in the owned route folders (`_components`, `_lib`); T-080's `AsOfNote`, `TotalsRow`, `Pager` and `query` / `pick*` helpers are reused, and T-062's `HandoverStatus`, `differenceText`, `whenText`, `linemanHref` are imported from `linemen/_components` and `linemen/_lib` (not copied).

**Open questions (product owner)**
- Should the collections report be linemen only (BRD §12 "Daily lineman collections")? Today it includes counter payments and the old app's payments so it reconciles with the payment register; the role is shown per row.
- Should the handover report also list a lineman's day with no payments and no handover (nothing to hand over)? Today only days with a session.
- Hindi words (H-03), especially "रोज़ का कलेक्शन", "बिल बनाने को कुछ नहीं", "क्या हुआ (n बार)".

**Deviations / files outside the owned paths**
- `packages/core/src/index.ts` (one export line), `packages/i18n/messages/{en,hi}/reports.json` (new top-level keys, as T-080 asked), `packages/i18n/glossary.md` (new table), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/reports-operations.spec.ts`.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 9d996b6)
- `@cb/core` operations tests, all against a real database (world made by the real services: 2 bill runs with the job worker, phone and counter payments, an undo, a handover sent back, handed over again and accepted, another short and waiting):
  - `collections.test.ts` (6): hand-checked days (cash ₹850 / UPI ₹300 on 31 Oct, the undone ₹300 listed not counted); Σ rows = Σ people = totals; **totals = T-048 `listPayments` (cash, UPI, counted, cancelled) and counted cash + UPI = −Σ ledger (payment + undo entries) for 6 ranges × 6 people**; **every lineman's day = its `collection_sessions` running totals and T-062 `getLinemanDay` (UPI never as cash)**; as of an earlier moment (a late phone payment and a later undo not yet in it); filters, pages, Staff ok, lineman FORBIDDEN, future / backwards / 33 days / bad date VALIDATION, unknown person NOT_FOUND.
  - `handover.test.ts` (4): hand-checked rows (expected now vs at handover, handed, −₹50 "short", status order, changed since handover), the full history (submitted → sent back with note → submitted → accepted, actors, IST times), totals; **every row = `getLinemanDay` (status, numbers, history ids) and = the phone cash payments not undone; Σ cash expected = the collections report's linemen cash, Σ UPI = their UPI**; filters (lineman, status, short / extra, days, page); roles and refusals.
  - `connections.test.ts` (5): **every connection on every day 25 Sep … 2 Nov = T-040 `assignmentStatusOn` / `rentalForPeriod` + the plan rule (> 200 comparisons)**; hand-checked stop / start again / removal / mid-month start / plan change days; **active rent on the 1st = the rent lines of that month's bill run for every billed customer** (only the failed customer is active and unbilled); filters (area, status, plan, own amount), pages, roles, refusals.
  - `billing-runs.test.ts` (4): latest month by default, rows problems first with reasons; **totals = the run's counters and total, Σ new bills = Σ their ledger entries, failed rows = T-047 `billingRunProblems`** for both months; filters, a month without a run; roles, refusals.
  - `range.test.ts` (3, pure). Isolation: 9 new cases pass, the coverage test passes.
  - Mutation checks (reverted): counting undone cash, or letting a status change count on its own day, fails 7 tests.
- `apps/web` vitest: 5 new files / 23 tests (days parsing, collections tables + totals (cash and UPI headings, cancelled, old app, links, Hindi), handover table + history + totals, connections table + totals, bill run table + summary + totals, empty states, Hindi).
- Playwright `e2e/reports-operations.spec.ts` (5 tests; real billing run + job worker, phone payments, an undo, a counter payment, a handover): Owner opens each report from `/reports`; daily collection (cash ₹500 / UPI ₹100 / 1 cancelled, by person, Ravi filter, row → payments report with the same cash); cash handover (₹300 expected, ₹250 handed, ₹50 short, reason, What happened, Accepted filter empty, row → Linemen review); connections (2 active ₹400, stopped Bina, Stopped filter, the first day: 3 active ₹650, row → Connections tab); bill run (Some problems, 3 customers, 1 new bill ₹300, nothing to bill, problem with its reason, New bill filter, row → bill); Staff open all four **with filters at 360 px** with no sideways scroll. Screenshots (1280 / 360, EN / HI) checked by eye.
- Root (after the rebase): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test --concurrency=1` (core 83 files / 1086 tests + 3 opt-in benches skipped, web 59 / 504, all other packages green), `TURBO_FORCE=1 pnpm build`, `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `pnpm i18n:check`, `node scripts/tasks.mjs check --local`.
- Whole e2e suite (scratch DB `cb_e2e_t081`, `E2E_PORT=3281`, pre-installed Chromium, `--workers=2`): 96 passed, 1 failed: T-031's `plans.spec.ts` "a read-only Owner …" hit `users_login_unique` in its own seed (its seed id is made at describe level, the problem `_support/unique.ts` describes, so with 2 workers it seeds twice). Run on its own: 3/3 passed. Not touched by this task.

## Board log

- 2026-10-14T08:08:30.047Z claimed by agent-t081
- 2026-10-14T08:51:52.259Z completed on task/T-081-reports-daily-collections-handover-conne

---
id: T-080
title: Reports: dues and ageing, bill register, payment register
phase: 4
area: web
status: done
owner: agent-t080
claimed_at: 2026-10-14T04:25:46.155Z
branch: task/T-080-reports-dues-and-ageing-bill-register-pa
depends_on: [T-044, T-046, T-029]
review: self
claimable_by: agent
size: M
paths: [packages/core/src/reports/dues/**, packages/core/src/reports/registers/**, apps/web/src/app/(operator)/reports/dues/**, apps/web/src/app/(operator)/reports/bills/**, apps/web/src/app/(operator)/reports/payments/**, packages/i18n/messages/*/reports.json]
---

# T-080 — Reports: dues and ageing, bill register, payment register

**Phase** 4 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-044, T-046, T-029

## Goal

Money reports whose totals always match the ledger.

## Scope

- Dues list + ageing buckets 0–30/31–60/61–90/90+ by area.
- Bill register, payment register (method, collector, sync/posting/review status).
- Each report shows its 'as of' time and totals row.

## Acceptance criteria

- [x] Report totals equal ledger totals for the same filters (automated test).

## Tests required

- Reconciliation tests on seeded data; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/reports/dues/**`
- `packages/core/src/reports/registers/**`
- `apps/web/src/app/(operator)/reports/dues/**`
- `apps/web/src/app/(operator)/reports/bills/**`
- `apps/web/src/app/(operator)/reports/payments/**`
- `packages/i18n/messages/*/reports.json`

## References

FR-023, BRD §12 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/reports/dues/` | `duesReport` (`reports.dues`), the ageing rule (`ageing.ts`), the as-of moment shared by the money reports (`as-of.ts`), types, isolation cases, DB tests on a scripted world (`test-world.ts`) and on T-036's seed (`seeded.test.ts`), a legacy-size bench (`dues.bench.test.ts`, run with `CB_REPORTS_BENCH=1`). |
| `packages/core/src/reports/registers/` | `billRegisterReport` (`reports.bill_register`, 1–12 months), isolation cases, tests (incl. agreement with T-047's `listBills`), and the ledger reconciliation of T-048's `listPayments` (`payments.test.ts`). |
| `apps/web/src/app/(operator)/reports/dues/page.tsx` | `/reports/dues?date=&area=&show=due\|advance&age=&page=`: as-of line, filters (day, area, who, how old), totals row (total due, credit, due minus credit), 4 ageing cards (each opens the list of that age), due by area (area + 4 buckets, Total row), customer list (Customer, Due, Unpaid since, How old; or Customer, Credit) with its own totals row, pages. Rows open the customer. |
| `apps/web/src/app/(operator)/reports/bills/page.tsx` | `/reports/bills?from=&to=&area=&paid=&page=`: as-of line, filters (from/to month, area, Paid?), table (Customer, Month + bill no., Bill amount, Paid, Paid? pill + still due), totals row (count, billed, paid, still due), pages. Rows open `/bills/[id]`. |
| `apps/web/src/app/(operator)/reports/payments/page.tsx` | `/reports/payments?from=&to=&collector=&method=&status=&page=` (default this month): as-of line, filters, table (Customer + receipt no., Amount + Cash/UPI pill, Taken by + where, When: money taken, plus "Reached the office …" when it arrived more than 10 min later, Status pill), totals row (count + cancelled, cash, UPI, cash + UPI + to check), pages. Rows open `/payments/[id]`. Reuses T-048's `listPayments` and its `payments` words and pills. |
| `apps/web/src/components/reports/` | `format.ts` (pure: param pickers, `asOfText`, `BUCKET_PILL`, `duesHref`, `query`), `parts.tsx` (`AsOfNote`, `TotalsRow`, `AgeingCards`, `DuesByAreaTable`, `DuesList`, `Pager`), test fixtures, 2 test files. |
| `packages/i18n/messages/{en,hi}/reports.json` | Namespace `reports` (`as_of.*`, `total`, `dues.*`, `bills.*`, `payments.*`). **All Hindi is machine-drafted and listed in `_review`.** Pay-state words come from `bills` and payment words from `payments` (one vocabulary). Glossary: new "Report words" table. |
| `apps/web/e2e/reports.spec.ts` | Playwright (below). |

**APIs for later tasks** (`@cb/core`; capability `reports.view` = Owner + Staff; READ ONLY and REPEATABLE READ, so rows and totals come from one snapshot; allowed in read-only mode; another tenant's area → NOT_FOUND)

| Service | Input → output |
|---|---|
| `duesReport` (`reports.dues`) | `{ asOfDate?: YYYY-MM-DD (a past IST day; default now; future → VALIDATION), areaId?, kind?: "due" \| "advance" (default due), bucket?: AgeingBucket, page? }` → `DuesReport { asOf: { at, date, endOfDay }, areas, totals: DuesTotals, byArea: DuesAreaTotals[], rows: DuesRow[] (50 per page), listTotals: DuesTotals, page, pageSize }`. `DuesTotals { dueCustomers, duePaise, buckets: { d0_30, d31_60, d61_90, d90_plus }, advanceCustomers, advancePaise, netPaise, customersByBucket }`. `DuesRow { customerId, customerCode, customerName, phone, customerStatus, areaId, areaName, balancePaise, duePaise, advancePaise, buckets, oldestDuePeriod, oldestBucket }`. |
| `billRegisterReport` (`reports.bill_register`) | `{ from, to (periods, at most 12 months), areaId?, payState?, page? }` → `BillRegisterReport { asOf, from, to, areas, totals: { count, chargesPaise, paidPaise, outstandingPaise, byState }, rows: BillRow[] (T-047's type), page, pageSize }`. |
| Payment register | T-048's `listPayments` (`payments.list`, `dashboard.view`): `totals.cashPaise + totals.upiPaise` = −Σ ledger entries of those payments and their undos (tested). |
| Helpers | `AGEING_BUCKETS`, `AGEING_BUCKET_LIMITS`, `ageingBucket(period, asOf)`, `ageingBucketOfDays`, `billAgeInDays`, `spreadDue` (the reference spreading), `resolveAsOf(now, date?)`. |

- **T-082 (CSV exports):** call the same services with the page's filters and walk `page` until a short page; put `asOf.at` in the file name or header so an export says when it is from. `totals` / `listTotals` give the totals row.
- **T-081 (operations reports):** reuse `AsOfNote`, `TotalsRow`, `Pager` and `query` from `apps/web/src/components/reports/`, and `resolveAsOf` + `isolationLevel: "repeatable read"` for consistent totals. Add your words to `reports.json` under your own top-level keys.
- **T-083 (Home):** total due = `duesReport({}).totals.duePaise` (or `netPaise` for due minus credit); an ageing card can link to `/reports/dues?age=d90_plus`.

**Decisions**
1. **Ageing rule** (`ageing.ts`): a bill's due is as old as the days from the **1st of the bill's month** to the as-of IST date (BRD §9: calendar month, run on day 1; the data model has no due date, PLAN §7.2). Buckets: up to 30 days (also a bill dated later) / 31–60 / 61–90 / 91 and more. On 31 Oct the October bill is 30 days old (0–30); on 1 Nov it is 31 (31–60). Catch-up bills (D-25) age from their month, not from the day they were made. Migrated old-due bills age from their period.
2. **Which part of a due is old:** unused credit pays the oldest bills first (D-14, PLAN §8.5), so the customer's ledger balance is spread over the unpaid part of their bills **from the newest back**; any due not on a bill counts as 0–30. So Σ buckets = due, and a customer either owes (buckets) or has credit, never both. A customer with credit not yet applied (T-041 Q-B) shows the net.
3. **The ledger is the source**, not `customer_balances`: totals reconcile by construction, and the report can be read **as of the end of any past IST day** (`ledger_entries.at`, `allocations.created_at`, `invoices.issued_at` before the next 00:00 IST). A phone payment counts from when it reached the office (when it entered the books). "Now" is the call's clock.
4. **The totals row covers every matching row**, not only the page. The dues page has two: the whole report (area filter) and the list (area + who + age).
5. **The age filter lists customers with some due of that age**, and the list's Due column then shows that part ("Due: Over 90 days — ₹500 of ₹800 due"), so a card's amount and customer count equal the list it opens and its totals row (tested). The "How old" pill shows the customer's oldest due.
6. **One bill register definition:** `/reports/bills` has its own service (T-047's `listBills` covers one month; the report needs a month range, an as-of snapshot and pay-state counts), but it uses T-047's paid rule (Σ allocations, net of undone payments), `billPayState`, the `BillRow` type and the `bills` words. For one month its totals and rows equal `listBills` (tested). Every bill counts, also a cancelled (void) one, because its ledger entry stays (there is no void flow yet, T-023).
7. **One payment register:** `/reports/payments` calls T-048's `listPayments` (no second payment query). Sync status is shown honestly: the server only knows a payment once it reaches the office, so the When cell shows when the money was taken (the phone's time) and, if it arrived more than 10 minutes later, "Reached the office {time}". Posting status is Counted / Cancelled; review is To check / Checked.
8. Bills report: default range is the last 3 months, months to choose go 36 back. Payments report: default is this month.
9. Set-based SQL: the dues report is 2 statements (totals by area with `GROUPING SETS` + the list's totals, then the page), each scanning the tenant's ledger, allocations and bills once; the bill register is 2 as well.

**Open questions (product owner)**
- Ageing from the bill's month start (decision 1) or from the day the bill was made? Should migrated old dues age from their real legacy date? The migration only gives a period.
- Should the age filter mean "oldest due is this old" (a worst-age list) instead of "has some due this old" (decision 5)?
- Should a cancelled (void) bill drop out of the bill register totals once a void flow exists (T-023 open question)?
- Hindi report words (H-03), especially "बाकी में से एडवांस घटाकर" (due minus credit) and "कितना पुराना" (how old).

**Deviations / files outside the owned paths**
- `apps/web/src/components/reports/**` (new shared report components that T-081 / T-082 can reuse; same pattern as T-047's `components/bills`).
- `packages/core/src/index.ts`: two export lines (`./reports/dues`, `./reports/registers`).
- `packages/i18n/glossary.md` (new table), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/reports.spec.ts`.
- The report test world (`test-world.ts`) and the isolation seed (`test-seed.ts`) are non-test modules in `reports/dues/` (not exported from the package) so both report folders can share them.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 24c71ba, which has T-034 and T-048)
- `@cb/core` report tests (all against a real database, no skips except the opt-in bench):
  - `dues/ageing.test.ts` (pure): day counts across months/years/leap years, bucket edges 30/31, 60/61, 90/91, October's bill moving to 31–60 on 1 Nov, `spreadDue` (newest back, credit pays oldest, due not on a bill, ties by id), `resolveAsOf` (now, end of a past IST day = next 00:00 IST, future refused, just after IST midnight).
  - `dues/dues.test.ts`: a world made by the real services (4 monthly runs + job worker, cash/UPI payments, a ₹1,000 advance used by two later bills, a part payment, an undone payment, a migrated opening-balance bill, payments at 23:45 and 00:15 IST): **for 5 as-of moments × 3 area filters, total due − credit = Σ `ledger_entries` before the cutoff; Σ buckets = due; Σ areas = total; each list's totals row = Σ its rows = Σ the ledger of exactly those customers**; every customer's buckets equal the reference `spreadDue` and its balance the ledger (and, now, `customer_balances`); hand-checked numbers now / end of 31 Oct / end of 1 Nov / 15 Aug / 31 Aug; age cards = the lists they open; area, kind, bucket, page filters; Staff ok, lineman FORBIDDEN, future/invalid date VALIDATION, unknown area NOT_FOUND. The world passes T-052's `checkTenantInvariants`.
  - `dues/seeded.test.ts` on T-036's `small` seed (3 operators, seed 7; asserts the seed has undone payments, credit applications, reversal rows, opening balances, credit adjustments, part payments and advances): dues = ledger for every operator × 4 as-of days × 3 area filters, buckets = reference for every customer; bill register (12-month windows) billed = Σ the bills' ledger entries, paid = Σ their allocations, count and pay-state counts add up, Σ still due − Σ credit = ledger = dues net; **payment register counted cash + UPI = −Σ ledger (payment + undo entries) month by month × method**; timing sanity (median < 2 s).
  - `registers/registers.test.ts`: bill register totals = ledger for 4 ranges × 3 areas, hand-checked totals and pay-state counts, **rows and totals equal T-047's `listBills` month by month**, ordering, pay-state filter, page 2 keeps totals, roles and validation.
  - `registers/payments.test.ts`: T-048 `listPayments` counted cash + UPI = ledger for 9 filters (ranges, method, collector), the undone payment listed but not counted, IST day edges.
  - Isolation: 4 new cases (`reports.dues` no-leak + other tenant's area, `reports.bill_register` no-leak + area) pass; the coverage test passes.
  - Bench (`CB_REPORTS_BENCH=1`, legacy seed: 8 operators, 7,616 customers, 23 months; biggest operator 1,393 customers): dues now ~99 ms, as of a month end ~89 ms, over-90 list ~96 ms, bill register 12 months ~115 ms (medians of 5, transaction included); dues total = ledger.
- `apps/web` vitest: `components/reports/format.test.ts`, `parts.test.tsx` (17 tests: params, as-of text EN/HI, totals row, age cards, area table with Total row, dues list incl. the age-filtered Due column, credit list, Hindi, empty state, pager).
- Playwright `e2e/reports.spec.ts` (4 tests, real billing run + job worker + payments): Owner opens each report from `/reports`; dues totals ₹800 / ₹600 / ₹200, age cards ₹300 / ₹500, area table + Total row, list + totals row, Over 90 days filter (₹500 of ₹800, totals = card), area South, credit list, **as of the end of yesterday (₹700 only)**, row → customer; bill register over 5 months (3 bills, ₹1,400 / ₹600 / ₹800), Paid? filter, row → bill; payment register (2 payments, cash ₹1,000, UPI ₹200), UPI filter, row → payment; Staff opens all three at 360 px with no sideways scroll. Screenshots (1280 EN, 360 EN, 360 HI) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10, run with `--concurrency=1`; core 62 files / 879 tests, web 41 / 375), `TURBO_FORCE=1 pnpm build` (10/10), `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `pnpm i18n:check`, `node scripts/tasks.mjs check --local`.
- Whole e2e suite (scratch DB `cb_e2e_t080`, `E2E_PORT=3280`, pre-installed Chromium, `--workers=2`): 74 passed, 1 failed: T-034's `connections.spec.ts` "phone (360px)" hit `users_login_unique` in its own `seedTenant` (its describe is not serial, so with 2 workers its setup can run twice). Run again on its own with `reports.spec.ts`: 6/6 passed. Not touched by this task.

## Board log

- 2026-10-14T04:25:46.155Z claimed by agent-t080
- 2026-10-14T05:34:45.868Z completed on task/T-080-reports-dues-and-ageing-bill-register-pa

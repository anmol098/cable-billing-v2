---
id: T-047
title: Bills UI: runs, preview, register, detail, printable bill
phase: 2
area: web
status: done
owner: agent-t047
claimed_at: 2026-10-13T19:32:52.461Z
branch: task/T-047-bills-ui-runs-preview-register-detail-pr
depends_on: [T-044, T-029]
review: self
claimable_by: agent
size: L
paths: [apps/web/src/app/(operator)/bills/page.tsx, apps/web/src/app/(operator)/bills/runs/**, apps/web/src/app/(operator)/bills/register/**, apps/web/src/app/(operator)/bills/[id]/**, apps/web/src/components/bills/**, packages/i18n/messages/*/bills.json]
---

# T-047 — Bills UI: runs, preview, register, detail, printable bill

**Phase** 2 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-044, T-029

## Goal

Owners understand and control the monthly bill run without jargon.

## Scope

- Month calendar with run status per month; 'Preview this month' (Staff/Owner) with plain summary + problem list; 'Run now' / 'Retry problems' (Owner).
- Missed bill runs card after reactivation (manual only).
- Bill register (filters: month, area, status) and bill detail (lines per VC, adjustments, payments allocated, balance).
- Printable A5 bill (print CSS or PDF) in operator language.

## Acceptance criteria

- [x] Staff cannot see Run/Retry buttons; server enforces too.

## Tests required

- Playwright: preview → run → open bill.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/bills/page.tsx`
- `apps/web/src/app/(operator)/bills/runs/**`
- `apps/web/src/app/(operator)/bills/register/**`
- `apps/web/src/app/(operator)/bills/[id]/**`
- `apps/web/src/components/bills/**`
- `packages/i18n/messages/*/bills.json`

## References

PLAN §12.1, J-03, FR-009, FR-011 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `apps/web/src/app/(operator)/bills/page.tsx` | `/bills`: year calendar (12 month cards: run status pill, bill count, bill total; open months link to `/bills/runs?month=`; "Before you joined" / "Not yet" for the rest), "This month" card, **Missed bill runs** card, header action "Preview this month". `?year=` navigation. |
| `apps/web/src/app/(operator)/bills/runs/page.tsx` + `actions.ts` | `/bills/runs?month=YYYY-MM-01[&preview=1]`: month navigation (tenant's first month … current month), view-only notice, run summary (new bills, total, already had a bill, nothing to bill, problems, finished at), the run's problem list with names, **Preview** on request (`?preview=1`: "N customers will get a bill.", total, already billed, nothing to bill, problems + list), Owner-only `RunActions` ("Make bills now", "Try problems again"; ConfirmSheet states the preview numbers when open), auto-refresh every 5 s while the run is pending/running, "See bills of {month}", other missed months. Server Actions `startRunAction({ period })`, `retryRunAction({ runId })` → `RunActionResult`. |
| `apps/web/src/app/(operator)/bills/register/page.tsx` | `/bills/register?month=&area=&paid=&page=`: GET filter form (month, area, "Paid?"), totals over all matching bills (count, billed, paid, still due), `DataTable` (customer, bill no., bill amount, paid, status pill + still due), 50 per page. |
| `apps/web/src/app/(operator)/bills/[id]/page.tsx` | Bill detail: customer (link to `/customers/[id]`), month, made on, pay state, amounts (old due / credit before, this month, total to pay, paid on this bill, still due on this bill), lines **per VC** (rent + bill-change lines), other charges (bill changes without a VC, with the Owner's reason), payments and credit put on this bill (method pill, receipt no., date, "Cancelled" for undone payments), customer's account now. 404 for another tenant's / made-up id. |
| `apps/web/src/app/(operator)/bills/[id]/print/route.ts` | `GET /bills/[id]/print[?auto=1]`: **printable A5 bill** as a self-contained HTML page (`@page { size: A5 }`) in the **operator's** `settings.default_language`, with a Print button (`?auto=1` opens the print dialog on load). Route handler so the shell isn't printed; same gate (`getTenantContext` + `getBill`). |
| `apps/web/src/components/bills/` | `format.ts` (pure: `pickMonth`, `pickYear`, `monthNeighbours`, URL builders, `RUN_STATE_PILL`, `PAY_STATE_PILL`, `problemReasonKey`, `lineKey`, IST date formatting), `run-result.ts` (`runErrorKey`), `parts.tsx` (RunStatePill, MonthNav, PausedNotice, MissedRunsCard, RunSummary, PreviewSummary, ProblemList, MonthCalendar), `bill-detail.tsx`, `run-actions.tsx` (client), `auto-refresh.tsx` (client), `print-html.ts` (`billPrintHtml`, CSS from `tokens.json` like T-050), `test-fixtures.ts` + 5 test files. |
| `packages/core/src/billing/views.ts`, `view-types.ts`, `views.isolation.ts`, `views.test.ts` | New read services (below), exported through `billing/index.ts` (already `export *`-ed by core). |
| `packages/i18n/messages/{en,hi}/bills.json` | Namespace `bills` (web only). **All Hindi is machine-drafted and listed in `_review`** (except `method.upi`). Glossary: new "Bills words (web Bills pages)" table. |
| `packages/design-tokens/icons.json` | New icon `retry` (`refresh-cw`, the glossary's "Try again" icon) + generated `icons.generated.ts` and Android `ic_cb_retry.xml`. |
| `apps/web/e2e/bills.spec.ts` | Playwright (below). |

**Core read services** (`billing.preview`: Owner + Staff; READ ONLY; allowed in read-only mode; another tenant's ids → NOT_FOUND)

| Service | Input → output |
|---|---|
| `billingMonths` (`billing.months`) | `{ from, to }` (periods, ≤ 24 months) → `BillingMonthsView { currentPeriod, firstPeriod, tenantMode, months: { period, run: BillingRunView \| null, billCount, billTotalPaise }[] }` (regular, not-void bills). |
| `billingRunProblems` (`billing.run_problems`) | `{ runId }` → `{ run, failedCount, problems: { customer: { id, code, name, areaName }, reason, details, attempts, lastTriedAt }[] }` (failed items, by customer code, max 500). |
| `billingCustomerLabels` (`billing.customer_labels`) | `{ customerIds }` (1–500) → `{ id, code, name, areaName }[]`; NOT_FOUND if any id isn't the tenant's. Used to name the preview's problems (T-044's preview is ids only). |
| `listBills` (`billing.list_bills`) | `{ period, areaId?, payState?, page? }` → `BillRegisterView { areas, rows: BillRow[], page, pageSize: 50, totals }`; unknown area → NOT_FOUND. |
| `getBill` (`billing.get_bill`) | `{ invoiceId }` → `BillDetailView { bill, customer (+ phone, address), operator { name, phone (office_phone ?? phone), address, language, footer }, connections, otherLines, payments, balance }`. |

Also `billPayState(status, charges, paid)`, `BILL_PAY_STATES` (`unpaid | part_paid | paid | no_charge | void`): paid = Σ the bill's allocations (net of undone payments), outstanding = charges − paid (T-041 `invoiceOutstanding`).

**For later tasks**
- **T-049 (customer statement / `/customers/[id]/bills`):** `listBills` is per month; a per-customer list could add `customerId` to `ListBillsInput`; reuse `BillDetail` / `billPrintHtml` and link bills to `/bills/[id]`.
- **T-083 (Home):** `billingMonths({ from: current, to: current })` gives the latest run + bill total; `missedRuns` for the alert; link to `/bills/runs`.
- **T-080/T-081 (reports):** the register's totals are the same Σ as the ledger allocations; `/reports/bills` can reuse `listBills`.
- **T-045 (bill changes):** lines render `adjustment.source` through `bills.line.<source>` and show the Owner's `reason`; a new source needs a `line.<source>` word.

**Decisions**
1. **Read services live in `packages/core/src/billing/`** (T-044's folder; T-044 is done) because T-044 has no calendar/register/detail reads and its preview/problems are ids only. Additions are separate files; T-044's files are untouched except `index.ts` (export lines).
2. **Preview on request** (`?preview=1`, a plain link): it computes the whole run read-only, so it isn't run on every page view. The run itself stays in the background job (T-044); the page polls with `router.refresh()` every 5 s while pending/running ("This page updates by itself").
3. **Run / Retry are Owner-only twice:** hidden unless `can(role, "billing.run")`, and `startBillingRun` / `retryFailedItems` refuse others (FORBIDDEN → "Only the owner can make bills."). Hidden too in read-only mode (paused notice instead; server says TENANT_READ_ONLY) and while the run is in progress. "Make bills now" stays available after a finished run (T-044: billed customers are skipped, new customers get their bill); the confirm sheet says "Nobody gets a second bill".
4. **Missed runs (D-25):** the card links to "Check {month}" (the month page with the preview open); the Owner then presses "Make bills now" there. Nothing is made automatically.
5. **Problem reasons in three plain sentences:** account totals (`balance_mismatch`, `credit_mismatch`), connection dates (T-040 validation reasons), anything else. Machine codes are never shown.
6. **Printable bill = HTML + print CSS (A5), not PDF:** browser shaping handles Hindi with no extra font bundle, the Owner prints on any printer, and the route stays a few KB. It is a route handler (no shell around it), in the operator's language (receipt language, `default_language`) regardless of the reader's UI language. It shows the bill as made (old due/credit, this month, total to pay) plus "To pay on {print date}" from the customer's balance, because per-bill "paid" is confusing on paper (allocation goes oldest bill first). It never says "tax invoice" (B-019). The paper size (`A5`, `148mm` preview width) is the only non-token constant.
7. **Pay state of a ₹0 bill** is "Nothing to pay" (`no_charge`), not "Paid".
8. Register month options run from the tenant's first month to the current month; the Bills calendar is a year view (Jan–Dec) with year navigation.

**Open questions (product owner)**
- Should the printed bill show "Paid on this bill" as well, or is "To pay on {date}" (the account balance) the right number for customers? (decision 6)
- Should Staff be allowed to press "Make bills now" for the *current* month? Today Owner only (D-16).
- Hindi wording for paid states ("नहीं भरा / कुछ भरा / पूरा भरा") and "Missed" ("छूट गया"): H-03.

**Deviations / files outside the owned paths**
- `packages/core/src/billing/{views,view-types,views.isolation,views.test}.ts` + `billing/index.ts` export lines (decision 1).
- `packages/design-tokens/icons.json` (+ generated `packages/ui/src/icons/icons.generated.ts`, `apps/android/.../ic_cb_retry.xml`): new `retry` icon.
- `packages/i18n/glossary.md` (new table), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/bills.spec.ts`.
- No calendar primitive existed in `@cb/ui` (T-007/T-008); the month grid is in `components/bills/parts.tsx`.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp`)
- `@cb/core` `billing/views.test.ts` (DB): a real November run (services + job worker) with a drifted-balance customer, a cash payment and an undone UPI payment: calendar (3 months, run counts, bill totals, `firstPeriod`, >24 months / backwards → VALIDATION), run problems with names, labels (dedupe, unknown → NOT_FOUND), register (order, pay states, totals, area filter, pay-state filter, page 2, unknown area → NOT_FOUND), bill detail (lines grouped per VC incl. a plan-change line, manual bill change in other lines, cash payment with receipt no., undone UPI payment, balance, operator language), Staff allowed, lineman FORBIDDEN. Isolation: 6 new cases pass, coverage test passes. Full core: 47 files / 645 tests.
- `apps/web` vitest: 5 new files / 31 tests (format + error mapping; RunSummary/Preview/ProblemList/MonthCalendar/MonthNav/PausedNotice/MissedRunsCard in EN+HI; BillDetail EN+HI incl. void/credit; RunActions confirm text with/without preview, start/retry calls, forbidden toast, renders nothing when not allowed, Hindi; printable HTML A5, Hindi, escaping, auto-print, credit/nothing due). Full web: 28 files / 241 tests.
- Playwright `e2e/bills.spec.ts` (3 tests): **Staff** see the preview ("2 customers will get a bill.", ₹750, 1 problem named) but no Make bills / Try again buttons, and **posting the Owner's captured Server Action request as Staff returns `forbidden` and creates no run**; **Owner** preview → Make bills now (sheet "2 customers get a bill, total ₹750.") → real job worker → page refreshes itself to "made, but some customers have a problem" → register (2 bills, ₹750) → open Asha's bill (2 VCs, ₹500 due) → printable A5 bill in Hindi; made-up bill id → 404; Staff after the run see problems, no Retry; `/bills`, `/bills/runs`, `/bills/register` have no sideways scroll at 360 px. Whole suite: **60 passed** (scratch DB `cb_e2e_t047`, `E2E_PORT=3247`, pre-installed Chromium; dropped afterwards).
- Screenshots (1280 EN, 360 EN/HI of calendar, runs + preview, register, detail; the A5 print page) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10, DB suites ran), `TURBO_FORCE=1 pnpm build` (10/10), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `pnpm i18n:check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T19:32:52.461Z claimed by agent-t047
- 2026-10-13T20:07:12.707Z completed on task/T-047-bills-ui-runs-preview-register-detail-pr

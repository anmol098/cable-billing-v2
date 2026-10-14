---
id: T-049
title: Customer statement, bills tab and ledger history
phase: 2
area: web
status: done
owner: agent-t049
claimed_at: 2026-10-13T20:30:55.113Z
branch: task/T-049-customer-statement-bills-tab-and-ledger
depends_on: [T-044, T-046, T-033]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/customers/[id]/bills/**, apps/web/src/app/(operator)/customers/[id]/history/**, packages/core/src/statements/**, packages/i18n/messages/*/statements.json]
---

# T-049 — Customer statement, bills tab and ledger history

**Phase** 2 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-044, T-046, T-033

## Goal

'What was charged, paid, adjusted and remains due?' answered on one screen.

## Scope

- Bills tab, History tab (ledger lines with running balance), downloadable statement PDF for a date range.
- Totals reconcile to customer_balances.

## Acceptance criteria

- [x] Statement closing balance equals customer balance for 'as of now'.

## Tests required

- Service tests on seeded scenarios; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/customers/[id]/bills/**`
- `apps/web/src/app/(operator)/customers/[id]/history/**`
- `packages/core/src/statements/**`
- `packages/i18n/messages/*/statements.json`

## References

B-009, FR-011, BRD §12 (Customer account statement) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/statements/statement.ts` | `customerStatement` (`statements.customer`): the statement for an IST date range. |
| `packages/core/src/statements/bills.ts` | `customerBills` (`statements.customer_bills`): every bill of one customer with paid / still due. |
| `packages/core/src/statements/rules.ts` | Pure: `resolveStatementRange` (IST bounds), `runningBalance`, `statementTotals`, `STATEMENT_MAX_LINES` (1000). |
| `packages/core/src/statements/types.ts`, `index.ts` | View types; exported through one line `export * from "./statements";` in `packages/core/src/index.ts`. |
| `packages/core/src/statements/statements.isolation.ts` | 3 isolation cases (statement with and without a range, bills). |
| `apps/web/src/app/(operator)/customers/[id]/bills/**` | Bills tab: "Still due on bills" (biggest), bill count, credit not used yet, "₹X extra goes on the next bill" (pending debit bill changes), billed / paid, "See account history", DataTable month / bill no. / amount / paid / status + still due (T-047's `PAY_STATE_PILL` and `bills.pay_state.*` words); rows open T-047's `/bills/[id]`. |
| `apps/web/src/app/(operator)/customers/[id]/history/page.tsx` | History tab ("Account history"): time choice (This month / Last 3 months (default) / Last 12 months / Everything, or From/To dates in a GET form; wrong dates fall back to 3 months with a notice); summary card (balance at the end biggest; balance before, bills and extra charges, paid, payments cancelled, discounts, balance on {to}; "credit goes on the next bill"; a red "does not match, call support" notice if Σ ledger ≠ `customer_balances` or closing ≠ balance as of now); every line oldest first: icon + colour + word, date · bill no. / receipt no. / "Money taken on {date}" (offline payment posted later) / "By {collector}" / "Why: {reason}", "Cancelled later" pill, "Open bill" link, ± amount, balance after (Due / Credit words, never a minus). |
| `apps/web/src/app/(operator)/customers/[id]/history/print/route.ts` | `GET …/history/print?range=…` or `?from=&to=` (`&auto=1` opens the print dialog): the **printable A4 statement** (print or "Save as PDF") in the operator's language, same days as the tab. |
| `apps/web/src/app/(operator)/customers/[id]/history/_components/` | `range.ts` (`pickStatementRange`, `presetRange`, `historyHref`, `statementPrintHref`, `rangeText`), `lines.ts` (`describeLine`, `signedRupees`), `statement-view.tsx`, `print-html.ts` (`statementPrintHtml`, CSS from `tokens.json` like T-047 / T-050), fixtures and tests. |
| `packages/i18n/messages/{en,hi}/statements.json` | Namespace `statements` (web only); all Hindi machine-drafted and listed in `_review`. Glossary: new "Account history words" table (Account history, Balance, Balance before, Extra charge, Discount = छूट, Payment cancelled / Cancelled later, Old dues from your old records, Money taken on, the time-choice words). |
| `apps/web/e2e/statements.spec.ts` | Playwright (below). `apps/web/e2e/shell.spec.ts`: the built customer tabs (bills, history) now have the customer's name as their page title, like the Summary (T-033 did the same). |

**Service API** (both `dashboard.view`: Owner + Staff; read only, REPEATABLE READ so the lines, the sums and `customer_balances` come from one snapshot; another tenant's or an unknown customer → NOT_FOUND; lineman → FORBIDDEN)

- `customerStatement.call(rt, ctx, { customerId, from?, to? })` (IST `YYYY-MM-DD`, both ends included) → `CustomerStatementView { customer, operator { name, phone, address, language }, range { from | null, to, today, asOfNow }, openingBalancePaise, lines: StatementLine[], hiddenLines, totals { billedPaise, paidPaise, undonePaise, discountPaise }, closingBalancePaise, now { balancePaise, creditPaise, oldestDuePeriod, ledgerPaise }, generatedAt }`. A `StatementLine` is one `ledger_entries` row: `{ id, seq, type, at, date (IST of at), amountPaise (signed), balanceAfterPaise, bill?, payment? (method, source, amount, receipt no., businessDate, collectorName, reversed), reversal? (reason, at), adjustment? (direction, source, period, reason) }`. A `to` after today is clamped to today (`asOfNow`); `from > to` or `from` after today → VALIDATION.
- `customerBills.call(rt, ctx, { customerId })` → `CustomerBillsView { customerId, rows: CustomerBillRow[] (newest month first; paid = Σ allocations net of undone payments, outstanding = charges − paid, `payState` via T-047 `billPayState`), totals (bills not cancelled), pendingChargesPaise (debit bill changes not on a bill yet), balancePaise, creditPaise }`.

**Decisions**
1. **The statement is the ledger.** Lines are `ledger_entries` in posting order (`seq`, PLAN §7.2); a line belongs to the IST day of its `at`; opening = Σ entries before 00:00 IST of `from`; closing = opening + Σ lines = Σ entries up to the end of `to`; as of now (no upper bound) that is Σ of all entries = `customer_balances.balance_paise`. Tests assert every line's balance equals the ledger's own running sum and that consecutive months chain (closing of October = opening of November).
2. **Dates are posting dates.** An offline payment taken at 22:30 IST on 31 Oct and posted at 00:15 IST on 1 Nov is a 1 Nov line (that is when the balance changed); the line says "Money taken on 31 Oct 2026".
3. **Debit bill changes are not statement lines until a bill picks them up** (T-041 Q-A default: they reach the ledger through the next bill's charges). The Bills tab shows them as "₹X extra goes on the next bill"; on the statement they are inside that bill's amount.
4. **Printable statement = HTML + print CSS (A4), "Save as PDF" from the print dialog**, not `@react-pdf/renderer` (PLAN §4): same reasons as T-047's printed bill (browser shaping handles Hindi with no font bundle, any printer, no new dependency). Operator's language; it says "This is not a receipt."
5. **Capability `dashboard.view`** (Owner + Staff web reads) rather than `customers.view`, which includes linemen: the statement is a web screen.
6. **Default range "Last 3 months"**, with "Balance before {date}" carrying the older history; "Everything" is one tap away. At most 1000 lines are shown; older lines of the range fold into the opening balance (said on screen), so the balances stay exact.
7. Words: "Account history" (not ledger / statement), "Extra charge" / "Discount" (not adjustment), "Payment cancelled" / "Cancelled later" (not reversal); balances say Due / Credit (never a minus sign); ± only on line amounts.

**Deviations / files outside the owned paths**
- `packages/core/src/index.ts` (one export line), `packages/i18n/glossary.md` (new table), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/statements.spec.ts`, `apps/web/e2e/shell.spec.ts` (title of the built customer tabs).
- **Builds on T-047 (PR #57)**: core imports `billPayState` from `billing/views`; the web reuses `components/bills/format.ts` (`PAY_STATE_PILL`, `monthText`, `rupees`, `billHref`, `Translate`), `escapeHtml` from `components/bills/print-html.ts`, and the `bills` namespace words (`pay_state.*`, `line.<source>`, `method.*`). This branch must be rebased onto `feature/mvp` once #57 is merged.
- PLAN §12.1 says "History (ledger + audit)": this task shows the ledger; the customer's phone-number changes / audit events are not on the tab (follow-up if wanted).

**Open questions (product owner)**
- Hindi in `statements.json` `_review` (H-03), especially "हिसाब" for Balance / Account history and "छूट" for Discount.
- The default range (3 months), and whether the printed statement should also list the open bills.
- Should an offline payment's statement date be the day it was taken rather than the day the office got it (decision 2)?

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)
- `@cb/core` `statements/statement.test.ts` (DB, real services): October / November / December billing runs through the job worker, counter and lineman payments (one posted at 00:15 IST, taken the day before), an overpayment, an Owner undo, a discount (credit bill change), an extra charge, migrated old dues (`opening_balance`). Checks: as-of-now closing = `customer_balances` = Σ ledger; every line's balance = the ledger running sum; exact lines and totals; Oct / Nov / Dec ranges chain; single-day ranges for 31 Oct and 1 Nov (IST); future `to` clamped; T-041 `checkLedger` = [] for both customers; Bills tab pay states and Σ outstanding − credit = balance (also with dues and credit side by side after the undo); pending debit change; Staff ok, lineman FORBIDDEN, unknown id NOT_FOUND, bad dates / backwards / future `from` VALIDATION. `rules.test.ts`: IST bounds, running balance, hidden lines, totals. Isolation: 3 new cases pass; the coverage test passes.
- `apps/web` vitest: `statement.test.tsx` (range parsing and URLs, line words, summary and lines in EN and HI, mismatch notice, unused credit, hidden lines, empty range, picker, printable HTML incl. escaping) and `bills-view.test.tsx` (EN, HI, empty).
- Playwright `e2e/statements.spec.ts` (2 tests): open a customer → Bills tab (₹300 still due, part paid) → History tab (bill, cash, UPI "Cancelled later", "Payment cancelled · Why: Wrong customer", closing ₹300 = the balance) → Everything → printable statement (A4, Hindi) → bad-dates notice → other tenant's / made-up / non-uuid ids 404 (tabs and print); Staff at 360 px in English and Hindi with no sideways scroll. Full suite on a fresh scratch DB (`cb_e2e_t049`, `E2E_PORT=3249`, `--workers=2`): 65 passed, 1 failed + 2 not run in T-033's `customers.spec.ts` (`users_login_unique` in its `beforeAll` when a worker ran it a second time; not related to this task); re-running customers + statements + shell specs: 13 passed.
- Screenshots (History at 1280 px EN and 360 px HI) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (10/10; core 780 passed), `TURBO_FORCE=1 pnpm build` (10/10), `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `pnpm i18n:check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T20:30:55.114Z claimed by agent-t049
- 2026-10-14T04:02:27.082Z completed on task/T-049-customer-statement-bills-tab-and-ledger

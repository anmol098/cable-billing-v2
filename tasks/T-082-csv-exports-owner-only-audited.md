---
id: T-082
title: CSV exports (Owner only, audited)
phase: 4
area: web
status: done
owner: agent-t082
claimed_at: 2026-10-14T13:27:14.299Z
branch: task/T-082-csv-exports-owner-only-audited
depends_on: [T-080, T-081]
review: self
claimable_by: agent
size: S
paths: [packages/core/src/exports/**, apps/web/src/app/(operator)/reports/_export/**, apps/web/src/app/api/exports/**]
---

# T-082 — CSV exports (Owner only, audited)

**Phase** 4 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-080, T-081

## Goal

Owners can take their data out safely.

## Scope

- Streamed CSV (UTF-8 BOM for Excel, Hindi-safe) for customers, bills, payments and every report.
- Owner-only, audited, rate-limited.

## Acceptance criteria

- [x] Staff receive 403-equivalent; export audit event recorded.

## Tests required

- Integration tests incl. isolation.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/exports/**`
- `apps/web/src/app/(operator)/reports/_export/**`
- `apps/web/src/app/api/exports/**`

## References

FR-029, RULE-22 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/exports/` (one export line in `packages/core/src/index.ts`) | `kinds.ts` (`EXPORT_KINDS`: customers, bills, payments, dues, collections, handover, connections, billing_runs; `ExportInput` = `{ kind, filters }`, where the filters are **the on-screen service's own Zod input**; `ExportRowTypes`), `service.ts` (`startExport`, service `exports.download`), `open.ts` (`openExport`, the page walker), `csv.ts` (cells, BOM, IST times, file name), isolation cases (9), DB tests and pure tests. |
| `apps/web/src/app/api/exports/[kind]/route.ts` | `GET /api/exports/<kind>?<the page's query>` (`billing-runs` for `billing_runs`): a streamed CSV attachment. |
| `apps/web/src/app/(operator)/reports/_export/` | `params.ts` (URL → filters with **each page's own pickers and defaults**, `exportHref`), `columns.ts` (headings and cells per kind, in the reader's language), `stream.ts` (BOM + heading row + one chunk per page, plus a truncation line), `export-cards.tsx` (the download page's cards), `download-link.tsx` (`DownloadListLink`), tests and fixtures. |
| `apps/web/src/app/(operator)/reports/export/page.tsx` | Replaces the T-029 placeholder: "Download data", one card per file (icon, title, one line of help, the days or months that kind needs, Download). Owner only (404 for anyone else). Shows `?problem=` refusals in words. |
| Report pages (`/reports/dues`, `bills`, `payments`, `collections`, `handover`, `connections`, `billing-runs`) | One line each: `<DownloadListLink kind=… params={params} role={ctx.role} />` under the as-of note. Owner only: "Download this list" links to the file with the page's filters (every page of rows). |
| `packages/i18n/messages/{en,hi}/exports.json` | New namespace (headings, card words, problems). **All Hindi machine-drafted and in `_review`.** Values (pay states, methods, statuses, reasons) reuse the `bills`, `payments`, `customers`, `connections`, `linemen` and `reports` words. Glossary: new "Download words" table. |
| `apps/web/e2e/exports.spec.ts` | Playwright (below). |

**API for later tasks** (`@cb/core`)

- `openExport(runtime, ctx, { kind, filters }, { rateLimiter?, rateLimit?, limits? })` → `Result<AnyExportHandle, ServiceError<CoreErrorCode | "RATE_LIMITED">>`. Order: Owner check (`can(role, "exports.csv")`, else FORBIDDEN) → Zod (VALIDATION) → rate limit (`EXPORT_RATE_LIMIT` = 30 per 15 min per person; RATE_LIMITED with `details.retryAfterSeconds`; a limiter that is down lets it through, logged) → **first page** (the service's own checks: another tenant's id NOT_FOUND, a day range over 31 days or a future as-of day VALIDATION) → `exports.download` (Owner gate again, filter ids again, **one audit event**) → handle. `handle.pages()` yields the rest page by page (read once); `handle.asOf` = the report's as-of (else the start); `handle.truncated` after the last page.
- `startExport` (`exports.download`, capability `exports.csv`: Owner only, audited, allowed in read-only mode): checks every filter id (area, person, customer, plan) is the tenant's, then records `{ action: "exports.download", entityType: "export", after: { report: <kind>, ...filters in snake_case } }`. Paging is dropped and the customer search text is never stored (`searched: true` instead; it may be a phone number).
- CSV helpers: `csvLine`, `csvCell`, `neutraliseCsvText`, `rupeesCell`, `countCell`, `istDateTime`, `exportFileStem`, `CSV_BOM`, `CSV_CONTENT_TYPE`.
- Audit viewer: `exports.download` is in `AUDIT_ACTIONS` (detail `kind` = the exported list) with en/hi sentences ("Ramesh (Owner) downloaded the customer list as a file"); `export` is a new `AUDIT_ENTITY_TYPES` entry ("Download"); field words for the filter keys.

**Decisions**

1. **No second query.** Rows come from the services the pages use: `customers.search` and `payments.list` (100 per call, down to their deepest offset) and the six T-080 / T-081 report services. To keep long exports to tens of calls, the report services take an optional **`pageSize` (1…500, default 50)**: a one-line input change in each (`REPORT_MAX_PAGE_SIZE` in `reports/dues/as-of.ts`). Each page is its own short READ ONLY transaction, so nothing is held open while the file goes to the browser.
2. **Streamed and bounded.** The route returns a `ReadableStream` that reads a page only when the client pulls (works with Vercel's streaming; `maxDuration` 300). At most `EXPORT_MAX_ROWS` = 50,000 rows (≈ 7 MB); the customer list and payment register stop at 10,100 rows (their services' deepest offset). Past a limit the file ends with one line in words: "This file stops here: it has the first N rows only. Choose fewer days or months."
3. **The audit event is written after the first page is read** (so a refused export writes nothing) and before any row is handed out. One event per export (it says what and with which filters; never the rows, never a row count, because the count is only known after streaming).
4. **CSV format.** UTF-8 with BOM (Excel shows Hindi), CRLF, RFC 4180 quoting. **Formula injection**: a text cell starting with `=`, `+`, `-`, `@`, tab, CR or LF, or `=`/`+`/`-`/`@` after leading spaces, gets a leading `'` (also phone numbers stored as `+91…`). Numbers we make (rupees, counts) are written bare after a strict pattern check, so `-50` stays a number. **Money** = rupees from integer paise by string maths (`paiseToRupeeDigits`: `450`, `12.50`, no grouping, `-` for negatives; not rounded, so totals reconcile). **Dates** `YYYY-MM-DD`, months `YYYY-MM`, times **IST** `YYYY-MM-DD HH:mm`. **Cash and UPI are always two columns**, also in the payment register (B-014). Codes are always words (pay state, method, status, outcome, the bill-run "why" via T-081's `whyText`).
5. **Same filters as the page.** The route reads the page's own query parameters with the page's pickers and defaults, so "Download this list" = every page of what the page lists. One difference on purpose: an area / person / plan that isn't this business's is NOT_FOUND (the page silently shows everything instead; a file should be what was asked for).
6. **Owner only, three times**: the route (`can`, 403 "Only the owner can download data."), `openExport`, and the `exports.download` service. The page 404s for Staff like the other Owner-only pages (T-029). A download started from another site (`Sec-Fetch-Site: cross-site`) is refused (403): it is a GET, so that header is the CSRF check.
7. **Refusals in words.** Bad filters / not found / too many downloads / failure → 303 back to `/reports/export?problem=…` (and `wait=` minutes), shown as an alert. FORBIDDEN stays a 403.
8. File name `<kind>-YYYY-MM-DD-HHmm.csv` from the export's as-of time (IST): it says when the numbers are from (T-080's advice), so no metadata line above the heading row.
9. Allowed in read-only mode (D-13 "viewing": the data stays the business's to take).

**Known limits / open questions (product owner)**

- Pages are separate snapshots: a payment that reaches the office during a long export can move a later page by a row. The as-of time is the first page's.
- Long VC numbers or phones may be shown by Excel as numbers (e.g. lost leading zeros) when the CSV is opened directly; the file has them exactly. An `.xlsx` export with text columns (T-084's writer) would avoid that; follow-up if operators hit it.
- The customer export has the list's columns (code, name, phone, area, status, due, advance), not the address / alternate phone / connections (those are not in `customers.search`; connections are in the Connections export). Should there be a full "everything about each customer" file?
- The customer list page (`/customers`, T-033) has no "Download this list" link; customers are on the Download data page.
- Hindi (H-03): every string in `exports.json`, and the audit sentence.

**Deviations / files outside the owned paths**

- `apps/web/src/app/(operator)/reports/export/page.tsx` (T-029's placeholder for this task, replaced as T-029 says).
- The six report services (`reports/dues/queries.ts`, `registers/bills.ts`, `operations/{collections,handover,connections,billing-runs}.ts`, done tasks T-080/T-081): optional `pageSize` input (decision 1); `REPORT_MAX_PAGE_SIZE` in `reports/dues/as-of.ts` + its index. Default behaviour unchanged.
- The seven report pages (T-080/T-081): one import and one `<DownloadListLink>` line each.
- `packages/core/src/audit-query/actions.ts` (T-035's registry, as T-035 asks every task to do): `exports.download` and the `export` entity type; `packages/i18n/messages/{en,hi}/audit.json`: sentence, filter label, entity word, field words.
- `packages/core/src/index.ts` (one line), `packages/i18n/glossary.md` (new table), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/exports.spec.ts`.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core` `exports/exports.test.ts` (22, real database, T-080's report world + T-081's operations world as two tenants): for 12 filter sets over all 8 kinds the export (walked in pages of 2) **equals the on-screen service's rows in order** (walked at 50), and so do the default page sizes; no row id of one tenant in the other's exports; as-of (end of 31 Oct = 18:30 UTC); row cap (exactly 3 of 6, `truncated`; exact cap not truncated; report cap); pages read once; Staff and lineman FORBIDDEN from `openExport` **and** from the service, nothing audited; one audit event per export with actor, role, request id, `report` and snake_case filters, search text never stored; another tenant's area / person / customer / plan NOT_FOUND for 8 inputs, nothing audited; 5 bad inputs (13 months, 33 days, future as-of, unknown kind, bad method) VALIDATION, nothing audited; rate limit 2 → `ok, ok, RATE_LIMITED` (+ retry seconds), only 2 audited, another person unaffected, a broken limiter lets it through; read-only tenant can export. `exports/csv.test.ts` (6, pure): formula cases incl. leading spaces/tab/CR/LF, quoting, numbers, rupees (paise, negative, big, bigint, fraction refused), BOM bytes, IST times and file name. Isolation: 9 new cases pass; coverage and audit-action tests pass.
- `@cb/web`: `_export/export.test.tsx` (11: URL → filters for every kind incl. defaults and bad input, link building, every heading and value has en + hi words (strict translator), cells (rupees, IST, words, cash/UPI apart), streamed CSV (BOM, headings, neutralised formula, Hindi, truncation line), download page forms in en/hi, report link), `api/exports/[kind]/route.test.ts` (5: Staff/lineman 403 without opening, unknown kind 404, cross-site 403, filters + limiter passed, refusals → 303 with reason, CSV headers, BOM bytes, file name).
- Playwright `e2e/exports.spec.ts` (4, real billing run + job worker + payments): Owner downloads customers (exact file: BOM, Hindi name, `'=1+2 Rao`, due ₹100 / advance ₹600) and payments (Cash and UPI columns side by side, ₹1,000 cash / ₹200 UPI) from Download data; both in the audit table and in words on `/settings/audit`; "Download this list" on `/reports/dues?show=advance` (href keeps the filter, file has the credit row); Staff: page 404, file 403 with the sentence, no link on the report, nothing audited; Hindi at 360 px without sideways scroll, Hindi headings.
- Root, after rebasing on `feature/mvp` 5452f5d (T-086, T-072, T-087a, T-091, handoff): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `TURBO_FORCE=1 pnpm test --concurrency=1` (10/10: core 96 files / 1251 passed + 3 opt-in benches skipped, web 66 / 563, db 269, …), `TURBO_FORCE=1 pnpm build` (10/10), `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `pnpm i18n:check`, `node scripts/tasks.mjs check --local`.
- Whole e2e suite (fresh scratch DB `cb_e2e_t082`, `E2E_PORT=3282`, pre-installed Chromium, `--workers=2`): **110 passed** (also 106/106 before the rebase).

## Board log

- 2026-10-14T13:27:14.299Z claimed by agent-t082
- 2026-10-14T19:21:50.769Z completed on task/T-082-csv-exports-owner-only-audited

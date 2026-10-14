---
id: T-084
title: Excel/CSV import wizard for customers and connections
phase: 4
area: web
status: done
owner: agent-t084
claimed_at: 2026-10-14T06:30:54.236Z
branch: task/T-084-excel-csv-import-wizard-for-customers-an
depends_on: [T-034]
review: self
claimable_by: agent
size: L
paths: [packages/core/src/imports/**, apps/web/src/app/(operator)/customers/import/**, packages/i18n/messages/*/import.json]
---

# T-084 — Excel/CSV import wizard for customers and connections

**Phase** 4 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-034

## Goal

New operators move from notebooks/spreadsheets in minutes.

## Scope

- Downloadable template (xlsx + csv, Hindi headers optional).
- Upload → parse → row validation via the same services (no bypass) → preview with per-row errors → import valid rows in batches → downloadable error file.
- Idempotent re-upload (match on customer code).

## Acceptance criteria

- [x] 5,000-row file imports < 2 min; invalid rows never partially import.

## Tests required

- Parser + validation tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/imports/**`
- `apps/web/src/app/(operator)/customers/import/**`
- `packages/i18n/messages/*/import.json`

## References

FR-030, PLAN §12.2, D-15 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/imports/xlsx/` | Own small .xlsx reader/writer on `fflate`: `xml.ts` (strict scanner: no DOCTYPE, so no entity expansion; 5 entities + char refs), `zip.ts` (central directory, inflates only the parts asked for, **in 16 KB steps with a byte limit per part**: zip bombs and lying headers stop at the limit), `read.ts` (`readXlsx`: first visible sheet, shared/inline/rich strings, cached formula results (never evaluated), numbers, booleans, date-formatted cells → `YYYY-MM-DD`, 1900/1904 systems), `write.ts` (`writeXlsx`: every cell an inline **text** cell in Text-formatted (`@`) columns, bold frozen header, deterministic bytes), `cells.ts`. |
| `packages/core/src/imports/csv.ts` | `decodeCsvBytes` (UTF-8 ± BOM, UTF-16 LE/BE ± BOM, else strict UTF-8, else Windows-1252 + a `not_utf8` warning), `parseCsv` (RFC 4180, `,`/`;`/tab detected from the header line, CR/LF/CRLF, line breaks in quotes, blank lines skipped), `writeCsv` (UTF-8 BOM, CRLF, quoting) with `escapeCsvCell` (leading `'` before `= + - @ TAB CR`) and `unescapeCsvCell` (undone on upload). |
| `packages/core/src/imports/columns.ts` | `IMPORT_FIELDS` (code, name, phone, altPhone, address, area, vcNumber, plan, rent, startDate), `fieldForHeader` / `headerKey` (case, spaces, punctuation, `*`, `(₹)` ignored; English + Hindi + common operator words: "Mobile", "STB no", "Package" …; "Line"/"Problem" = ignored columns of our problem file). |
| `packages/core/src/imports/file.ts` | `readImportFile(bytes)` → `ImportTable { format, encoding, warnings, headerLine, fields, unusedColumns, lines: ImportLine[] }` or `ImportFileProblem` (`too_big`, `empty`, `unreadable`, `old_excel`, `no_header`, `missing_columns`, `duplicate_column`, `too_many_lines`). The header row is found in the first 10 non-empty rows (a title above it is fine). Numbers come back as people typed them (`9876543210`, no exponent); a number cell in the start-day column is an Excel date. |
| `packages/core/src/imports/rules.ts` | Pure: `parseImportDate` (day first: `15/10/2026`, `15-10-26`, `15.10.2026`, `15 Oct 2026`, `Oct 15, 2026`, ISO), `parseImportRent` (whole rupees: `450`, `₹1,200`, `Rs. 450`, `450/-`, `450.00`; paise refused), grouping (`groupLines`), file-only checks (`checkGroups`), `customerInputOf` / `connectionDraftOf` (the **services' own Zod inputs** `CreateCustomerInput` / `ConnectionFields`), `LineProblem { field, code, params }`. |
| `packages/core/src/imports/plan.ts` | `planImport(tx, operatorId, lines, today)`: one lookup per kind for the whole call (existing codes, areas, plans, VC holders), → per customer `ready` (with the exact service inputs) / `exists` / `problem`. |
| `packages/core/src/imports/services.ts` | `checkCustomerImport` (`imports.customers.check`) and `applyCustomerImport` (`imports.customers.apply`), both `customers.manage` (Owner, Staff); `importSteps`; `problemFromServiceError`. |
| `packages/core/src/imports/template.ts` | `buildImportTemplate(kind, words)` (header row only + a "How to fill" sheet in .xlsx), `buildProblemFile(kind, words, rows)` (Line, Problem, then the template columns), `IMPORT_CONTENT_TYPES`. |
| `packages/core/src/imports/imports.isolation.ts` | 2 isolation cases (`no_leak`): both tenants have the same code, area, plan and VC; tenant A only ever sees its own ids, B's rows never change. |
| `apps/web/src/app/(operator)/customers/import/` | `page.tsx` (replaces the T-029 placeholder), `import-wizard.tsx` (Stepper: Get the form → Upload the file → Check and add, then the result), `_parts/lines-table.tsx` (filter Problems / Ready / Already in the app / All, 5-column DataTable, cards on phones, 50 lines at a time), `actions.ts` (`importStepAction`), routes `template/route.ts` (GET `?format=xlsx|csv&lang=en|hi`), `check/route.ts` (POST multipart), `problems/route.ts` (POST JSON → file), `_lib/` (`words.ts` problem texts, `run.ts` step runner, `server.ts`, `types.ts`). |
| `packages/i18n/messages/{en,hi}/import.json` | Namespace `import` (all Hindi in `_review`). Glossary: new "Import words" table. |
| `apps/web/e2e/import.spec.ts` | Playwright (T-088's folder, as earlier tasks did). |

**Service API**

- `checkCustomerImport.call(rt, ctx, { lines: ImportLine[] (1…5,000) })` → `ImportPreview { today, lines: ImportLineResult[], counts, steps }`. Writes nothing (`audit.skip("no_change")`); refused in read-only mode like the import.
- `applyCustomerImport.call(rt, ctx, { lines (1…250) })` → `{ today, lines, counts }`. Checks the lines again, then saves each ready customer with `createCustomerInTx` + `addConnectionInTx` in its **own savepoint**. Send whole customers per call (`preview.steps` does this); an `INTERNAL` error fails the whole step (rolled back), refusals are per customer.
- `ImportLineResult { line, status: ready | created | exists | problem, group, problems, customer: {id, code, name} | null, hasConnection }`.
- Audit: the same per-customer events as "Add customer" (`customers.create`, `connections.add`, same request id) plus one `imports.customers.apply` event per step with counts only (no names or numbers). Hooks (T-045) run as for any added connection.

**The file** (help sheet and step 1 say it in plain words): one line per set-top box; a customer with two boxes is two lines with the same code (the name etc. on the first line; later lines may repeat them or leave them empty, but may not differ); a customer without a box is one line without VC columns; at most 10 boxes per customer. Plan by name (any case/spacing, active plans only) **or** rent in whole rupees; both → they must agree. Empty start day = today (IST). Area by name among the tenant's areas.

**Uploading the same file again** (idempotency, matched on the normalised customer code): a code that already exists is **skipped — that customer and its connections are not changed** ("Already in the app: not changed"). Why not update: since the first upload the office or a lineman may have changed the customer (a corrected phone has history, FR-004; a connection may have been stopped or its VC moved); an old spreadsheet would silently undo that, and changing connections from a file would rewrite their history (PLAN §8.3). So re-uploading adds only what is missing (fixed problem lines, a stopped import), never a duplicate. Two imports of the same file at once also add each customer once (tested).

**Decisions**

1. **xlsx library: `fflate` 0.8.3 + ~500 lines of our own OOXML code.** fflate (MIT, zero dependencies, maintained, already in the lockfile through `pdfkit`/`png-js` (receipt PDFs), so no new package enters the tree) does the ZIP part; our reader/writer covers exactly what the template needs. Not chosen: SheetJS `xlsx` on npm (0.18.5, stale; CVE-2023-30533 prototype pollution and CVE-2024-22363 ReDoS are fixed only in builds outside npm), `exceljs` (21 MB, old `unzipper`/`archiver` dependency tree), `read-excel-file` + `write-excel-file` (4 runtime dependencies on the reader, fast-moving). Owning the small reader lets the import enforce its own limits (per-part inflate cap, no DTD, no formulas evaluated). Checked against real files: openpyxl and LibreOffice fixtures (synthetic data) are read; our output opens in openpyxl and LibreOffice (cells stay strings, `=1+1` is not evaluated).
2. **Customer code is required** on every line: it is what makes a re-upload safe. (A code-less line would get an auto code and be added again on every upload.)
3. **Areas are not created by the import**: an unknown area is a problem ("Add it in Settings → Areas, or leave it empty"); a hidden one too. Creating areas is Owner-only (`business_profile.manage`) while Staff may import, and a typo would otherwise become a new area.
4. **Preview** = the same field checks (services' Zod inputs) + lookups, no writes; **import** checks every line again (the data may have changed) and the services refuse what the database knows (a VC taken meanwhile, a billed month).
5. **No job queue.** The page sends steps of ≤ 250 lines, 2 at a time (`IMPORT_LIMITS.parallelSteps`; steps hold different customers and VCs, so they don't wait on each other). Each step is a few seconds, far inside Vercel's limits, the user sees progress, and a step that fails (or a closed tab) is finished by uploading the same file again. Leaving the page during an import asks first.
6. **Routes for the file and the problem file** (not Server Actions): Next.js' Server Action body limit is 1 MB, a 5,000-line file can be bigger. They check the session (`customers.manage`) and the browser `Origin` (same host).
7. **Problem file**: Line + Problem (in words, the page's language) + the original cells; the import ignores Line/Problem, so people fix the cells and upload that file. .xlsx: text cells only; CSV: formula cells get a leading `'`, removed again on upload.
8. **Limits**: 4 MB file (Vercel request limit 4.5 MB), 5,000 lines, 60 columns, 1,000 characters per cell, 64 MB per uncompressed .xlsx part, 10 boxes per customer. Old `.xls` is refused with "Save As .xlsx".
9. No PII in logs: services log counts; routes log error codes only; the file is never stored.

**Measured timing** (5,000-line acceptance test, `CB_IMPORT_BENCH=1 … vitest run src/imports/imports.perf.test.ts`; local PostgreSQL 17, 4 shared CPUs, load average ~17 from other agents): an .xlsx with 5,000 lines = 4,250 customers (750 with two boxes), 5,000 connections, plans/rents/areas, 30 % Hindi names → **read 0.3 s, preview 0.6 s, import 39.7 s in 20 steps (2 in parallel), total 40.6 s** (one step at a time: 67.0 s). The normal test run (and CI) runs the same test with 500 lines (7.2 s) so CI isn't loaded with a minute of database work; the 2-minute assertion applies to both. Production note: Neon adds network latency per query (~1–2 ms from Vercel in the same region); each customer is ~20 statements, so expect roughly 1.5–2× the local time — still under 2 minutes for 5,000 lines with 2 parallel steps, but worth measuring once H-01 is done.

**Open questions (product owner)**

- **Old dues (opening balances)** are not imported: they are financial records (adjustments / opening bills, T-045/T-091 territory). Should the import take an "Old due ₹" column later?
- Should a re-upload be able to **update** existing customers (FR-030 also says "bulk updates")? Today it skips them on purpose (above); a separate "update from file" with its own preview would be a follow-up task.
- Should the Owner's import create missing areas (with a confirmation in the preview)?
- Imported connections go through the T-045 hook like any added connection: a start day inside an already-billed month follows D-18. Is that right for onboarding (usually no bills exist yet)?
- Hindi in `import.json` `_review` (H-03), esp. "फ़ॉर्म", "अपलोड करें", "दिक्कत वाली लाइनें", "पहले से ऐप में".

**Deviations / files outside the owned paths**

- `packages/core/src/index.ts` (one export line), `packages/core/package.json` (+`fflate` 0.8.3, already in the lockfile), `packages/i18n/glossary.md` (new section), generated `apps/web/messages/*.json`, new `apps/web/e2e/import.spec.ts`.
- Plan names are matched directly against the `plans` table (T-022/T-031): an active plan wins over hidden (retired) ones with the same name, as T-031's unique index allows; a name that only a hidden plan has is refused with "Show it again in Settings → Plans".
- The core tests reuse `connections/test-support.ts` (T-034) read-only.
- `apps/web/e2e/plans.spec.ts` (T-031, done): its seed id was made at `describe` level, so when the full suite split the file into two groups in one worker the second seed collided on `users_login_unique` ("a read-only Owner sees why plans can't be changed" failed in every full run here). Smallest fix, as `_support/unique.ts` says: `run = newSeedId()` inside `beforeAll`.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core`: new `xlsx/xlsx.test.ts` (18: XML scanner refusals, numbers/dates, openpyxl + LibreOffice fixtures with Hindi headers, hidden sheet, formula without result, inline/rich strings, row/column limits, zip bomb, broken files, writer round trip), `file.test.ts` (18: Hindi headers with/without nukta, UTF-8/UTF-16/Windows-1252, separators, quotes/line breaks/blank lines, leading zeros, Excel serial dates, title row, problem-file round trip with CSV un-escaping, both templates in both languages, every whole-file problem incl. exactly 5,000 vs 5,001 lines), `rules.test.ts` (31), `imports.test.ts` (11, DB: preview names every problem and writes nothing; import through the services with assignments, events and audit; **re-upload changes nothing** (fingerprint) and keeps an edited phone; **a refused second box leaves no customer, no VC asset, no assignment**; a line with a problem never imports partly while the rest of the step is saved; two concurrent imports add each customer once; another tenant's areas/plans/codes/VCs are never matched; roles + read-only; input limits; steps), `imports.perf.test.ts` (above), isolation (2 cases) + coverage. Whole package (after the rebase): 71 files, 1045 passed, 1 skipped (the opt-in search benchmark).
- `@cb/web`: `import.test.tsx` (12: fields equal core's, every template column name in en + hi is recognised by the reader, **every problem code has words in en + hi**, step runner (2 in parallel, stops after a failure), result merging, file names, wizard: download links, file problems in words, preview → add in steps → result, failed step, Hindi). Whole package (after the rebase): 47 files / 432 tests.
- Playwright (`next start`, scratch DB `cb_e2e_t084` migrated, `E2E_PORT=3284`, pre-installed Chromium): **83 passed** (whole suite, after rebasing on T-031/T-085), 2 new in `import.spec.ts`: template downloads (Excel is a workbook the reader accepts; Hindi CSV headers), wrong file stays on step 2 with the reason, upload → preview (counts, problems in words, filters) → add → result → customers really saved with both connections → problem CSV (3 lines, reasons, `'=HYPERLINK…` escaped) → same file again adds nobody; Staff at 360 px without sideways scroll. Screenshots (desktop + 360 px, en + hi) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-14T06:30:54.236Z claimed by agent-t084
- 2026-10-14T07:31:09.324Z completed on task/T-084-excel-csv-import-wizard-for-customers-an

---
id: T-033
title: Customers: services, list, search, add, profile summary
phase: 1
area: web
status: done
owner: agent-t033
claimed_at: 2026-10-13T15:52:41.844Z
branch: task/T-033-customers-services-list-search-add-profi
depends_on: [T-029, T-022, T-025]
review: self
claimable_by: agent
size: L
paths: [packages/core/src/customers/**, apps/web/src/app/(operator)/customers/page.tsx, apps/web/src/app/(operator)/customers/new/**, apps/web/src/app/(operator)/customers/[id]/page.tsx, apps/web/src/app/(operator)/customers/[id]/summary/**, apps/web/src/app/(operator)/customers/_components/**, packages/i18n/messages/*/customers.json]
---

# T-033 — Customers: services, list, search, add, profile summary

**Phase** 1 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-029, T-022, T-025

## Goal

Office staff can find, add and edit customers easily.

## Scope

- Services: create/edit/deactivate, code normalisation + optional auto-code from counter, phone change audit (`customer_contact_changes`, source web), search by code/name (trigram)/phone/VC number with ranking.
- List page: search box, area/status filters, DataTable (code, name, area, due, status).
- Add-customer Stepper step 1 (Customer) and step 3 (Check & save); step 2 slot left for T-034.
- Profile shell with tabs (Summary implemented; Connections/Bills/Payments/History tabs are placeholders for T-034/T-048/T-049) and a 'Take payment' button placeholder.

## Acceptance criteria

- [x] Duplicate code in same tenant shows a friendly inline error.
- [x] Search returns results < 300 ms on 10k customers (seed).

## Tests required

- Service + isolation tests; Playwright add + search.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/customers/**`
- `apps/web/src/app/(operator)/customers/page.tsx`
- `apps/web/src/app/(operator)/customers/new/**`
- `apps/web/src/app/(operator)/customers/[id]/page.tsx`
- `apps/web/src/app/(operator)/customers/[id]/summary/**`
- `apps/web/src/app/(operator)/customers/_components/**`
- `packages/i18n/messages/*/customers.json`

## References

FR-003, FR-004, RULE-02, PLAN §12.1, PLAN §12.2 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/customers/customers.ts` | Write services: `createCustomer` (`customers.create`), `updateCustomer` (`customers.update`), `setCustomerStatus` (`customers.set_status`), all `customers.manage` (Owner, Staff, audited); `updateCustomerPhone` (`customers.update_phone`, capability `customers.phone.update`: Owner, Staff, Lineman). Also `createCustomerInTx(tx, actor, input, now, audit)`, `isDuplicateCustomerCode(error)`, `toCustomerView`, the Zod inputs `CreateCustomerInput`, `UpdateCustomerInput`, `SetCustomerStatusInput`, `UpdateCustomerPhoneInput`. |
| `packages/core/src/customers/queries.ts` | Read services (`customers.view`: Owner, Staff, Lineman; READ ONLY transaction): `searchCustomers` (`customers.search`), `getCustomer` (`customers.get`), `customerFormOptions` (`customers.form_options`). `customerSearchSql(operatorId, command)` (the ranked SQL, used by the benchmark), `CUSTOMER_PAGE_SIZE` 50, `MAX_CUSTOMER_PAGE_SIZE` 100, `MAX_CUSTOMER_OFFSET` 10,000. |
| `packages/core/src/customers/rules.ts` | Pure: `normalizePhone`, `searchTerms`, `escapeLike`, `SEARCH_TIERS`, `SEARCH_MATCH_KINDS`, `NAME_SIMILARITY_THRESHOLD` (0.45), `MIN_PHONE_PREFIX` 3, `MIN_PHONE_CONTAINS` 4, `CUSTOMER_FIELD_LIMITS`. |
| `packages/core/src/customers/types.ts` | `CustomerView`, `CreateCustomerResult`, `UpdateCustomerResult`, `CustomerListRow`, `CustomerSearchResult`, `CustomerProfile`, `CustomerConnectionSummary`, `CustomerLastPayment`, `CustomerAreaOption`, `CustomerFormOptions`. |
| `packages/core/src/customers/customers.isolation.ts` | 13 isolation cases (every service; `not_found` for every id input, `no_leak` for list/search by code, phone, VC, typo name, and form options). |
| `apps/web/src/app/(operator)/customers/page.tsx` | List: search box (debounced, also a plain GET form), area (incl. "No area") and status filters, DataTable code / name (+ matched VC) / area / due / status, cards on phones, Previous/Next pages, "Add customer" action (`customers.manage`). |
| `apps/web/src/app/(operator)/customers/new/**` | Add customer: Stepper 1 Customer (6 fields) → 2 Connections (VC) slot → 3 Check & save; `createCustomerAction` → profile `?saved=new`. |
| `apps/web/src/app/(operator)/customers/[id]/page.tsx` + `[id]/summary/**` | Profile Summary: due/credit (big), "Unpaid since", open connections, last payment, details (+ Call link), "Change details" (`?edit=1`, `updateCustomerAction`), Close / Make active again (ConfirmSheet, `setCustomerStatusAction`), saved toasts. |
| `apps/web/src/app/(operator)/customers/_components/**` | `CustomerProfileShell` (profile frame: back link, name as h1, code/area/status, primary action, tab bar; 404 for unknown/other-tenant ids), `CustomerTabs` + `tab-list.ts` (`CUSTOMER_TABS`, `customerTabHref`), `CustomerFields`, `form-state.ts` (client-safe) / `form-errors.ts` (`customerFormStateFor`, server), `server.ts` (`callAsUser`, cached `loadCustomerProfile`, `loadFormOptions`), `ActivePill`/`MutedPill`, `RowLink` (no prefetch), `FormMessage`, `takePaymentHref`. |
| `packages/i18n/messages/{en,hi}/customers.json` | Namespace `customers` (108 keys; all Hindi in `_review` except the untranslated `list.matched_vc`). Glossary: new "Customer words (web)" table. |

**Service API for later tasks**

- `createCustomer.call(rt, ctx, { customerCode?, name, phone?, altPhone?, address?, areaId?, kyc? })` → `{ customer, autoCode }`. Empty/missing code → next number from the `customer_code` counter. Duplicate (normalised) code → `CONFLICT` with `details: { field: "customerCode", reason: "duplicate_code", customerId }`; the race on the unique index gives `details.constraint = "customers_operator_code_unique"`; `isDuplicateCustomerCode(err)` covers both. Field problems → `VALIDATION` `details.fields[{path, code}]` (phone: `custom`; archived area: `areaId`/`archived`). Another tenant's area → `NOT_FOUND`.
- `updateCustomer.call(rt, ctx, { customerId, customerCode?, name?, phone?, altPhone?, address?, areaId?, kyc? })` → `{ customer, changed: string[] }`. Patch: missing = keep, `null` = clear. No change → no audit, `changed: []`.
- `setCustomerStatus.call(rt, ctx, { customerId, status: "active" | "inactive" })`. Deactivating with a connection that is not `disconnected` → `CONFLICT` `details: { reason: "open_connections", openConnections }`.
- `updateCustomerPhone.call(rt, ctx, { customerId, field?: "phone" | "alt_phone", phone: string | null })` — **T-061/T-066** (`PATCH /customers/{id}/phone`): works for the lineman on `mobile`; history `source` is `android` for mobile contexts, `web` otherwise.
- Every phone/alt-phone change (update or update_phone) writes one `customer_contact_changes` row (old, new, actor, time, source) in the same transaction (FR-004); creating a customer writes none (its audit event has the first numbers). Every write bumps `updated_at` (roster sync cursor) and records one audit event with only the changed fields.
- `searchCustomers.call(rt, ctx, { q?, areaId? | "none", status?: "all" | "active" | "inactive", limit?, offset? })` → `{ rows: CustomerListRow[], hasMore }`. Row: id, code, name, phone, area id/name, status, `balancePaise` (signed: > 0 due, < 0 credit; 0 when no `customer_balances` row), `creditPaise`, `match` (`all|code|phone|vc|name`), `matchedVcNumber`. **T-048** (counter payment customer picker) and **T-080** (due list could reuse the row shape) can call it directly. An area id of another tenant → `NOT_FOUND`.
- `getCustomer.call(rt, ctx, { customerId })` → `CustomerProfile`: view fields + `areaName`, `balancePaise`, `creditPaise`, `oldestDuePeriod`, `connections` (not disconnected, newest first: assignment/asset ids, VC number, status, plan id/name, rental, dates), `pastConnections` count, `lastPayment` (`{ id, amountPaise, method, businessDate, reversed }`).
- `customerFormOptions.call(rt, ctx, {})` → `{ areas: { id, name, archived }[], nextAutoCode }`.
- **T-034**: compose "customer + connections" in one transaction with `createCustomerInTx(tx, ctx, input, now, audit)` inside your own service; pass your step-2 fields to `<AddCustomerForm connectionsStep={…} />` (it renders inside the same `<form>`, so the Server Action receives them) and extend/replace `createCustomerAction`. Your tab page: wrap the content in `<CustomerProfileShell customerId={id} tab="connections">{(profile) => …}</CustomerProfileShell>` (children may be a function of the loaded profile; `action={null}` hides "Take payment", or pass your own primary action). After disconnecting the last connection, `setCustomerStatus` can close the customer.
- **T-048 / T-049**: same shell with `tab="payments"` / `tab="bills"` / `tab="history"`. "Take payment" links to `/payments/new?customer=<id>` (`takePaymentHref`); T-048's page should read that parameter. T-049's History tab can read `customer_contact_changes` and the `customers.*` audit events.

**Search ranking (PLAN §12.1)** — tiers, best first: exact code → exact phone/alt phone or exact VC number of an open connection → code prefix → phone / open VC prefix → name starts with → a word of the name starts with → phone or name contains → VC of a disconnected (past) connection → similar name (pg_trgm word similarity ≥ 0.45, from 4 characters). Ties: word similarity, natural code order (all-digit codes by number, others byte order `COLLATE "C"`), id. Each branch is a separate `UNION ALL` select using the T-022 indexes; `LIKE` wildcards in the text are escaped. Phones typed with `+91`/`91` are matched (and stored) as 10 digits; a leading `0` is kept (STD codes).

**Measured search timings** (`src/customers/search.bench.test.ts`, `CB_SEARCH_BENCH=1`; local PostgreSQL 17, 4 shared CPUs; one tenant with **10,000 customers** (≈30 % Devanagari names, a VC each, balances, 12 areas) plus 20,000 at two other tenants; ANALYZEd; median of 7 service calls incl. the transaction, and EXPLAIN ANALYZE execution time):

| Query | rows | median (service) | EXPLAIN ANALYZE |
|---|---|---|---|
| list, first page | 50 | 24.8 ms | 20.8 ms |
| list, offset 5000 | 50 | 22.7 ms | 33.9 ms |
| list, area + active | 50 | 8.8 ms | 5.3 ms |
| exact code 4521 | 4 | 24.6 ms | 30.7 ms |
| code prefix 45 | 50 | 14.4 ms | 9.7 ms |
| one letter "r" | 50 | 30.4 ms | 29.4 ms |
| phone prefix (5 digits) | 1 | 24.5 ms | 22.1 ms |
| full phone | 1 | 32.1 ms | 34.2 ms |
| last 4 phone digits | 9 | 27.8 ms | 19.4 ms |
| VC prefix (6 digits) | 50 | 30.3 ms | 26.0 ms |
| full VC number | 1 | 31.8 ms | 23.4 ms |
| name "ramesh" | 50 | 32.8 ms | 29.6 ms |
| typo "ramsh" | 50 | 26.1 ms | 20.2 ms |
| "sunita devi" | 50 | 33.2 ms | 26.0 ms |
| Hindi "रमेश" | 50 | 31.5 ms | 35.8 ms |
| name + area | 0 | 30.3 ms | 15.5 ms |

All well under the 300 ms target (worst single call 48 ms). The T-036 `legacy` scenario has ≈950 customers per operator, so the generated 10k tenant is the stricter case.

**Decisions**

1. Deactivation is refused while a connection is not disconnected (answers T-022 Q-C): billing follows connections, so a "closed" customer with a running connection would keep getting bills.
2. Customer status words: Active / **Closed** (बंद) with a grey "x" pill (not red: nothing is wrong); the glossary has the new words.
3. Auto code: `{seq}` from the counter; when it hits a code typed by hand, the counter jumps once past the highest all-digit code (e.g. typed 3, 4, 50 → next auto 51). Customer codes need not be gap-free.
4. Phone clean-up: spaces/dashes/dots/brackets dropped; `+91`/`91` + 10-digit mobile → 10 digits; leading `0` kept. Initial numbers on create write no `customer_contact_changes` row.
5. Fuzzy name threshold set per search transaction (`set_config('pg_trgm.word_similarity_threshold', '0.45', true)`); pg_trgm's 0.6 missed one-letter slips.
6. Profile URL: the Summary is `/customers/[id]` (T-029); the tab routes stay separate pages. The profile title (h1) is the customer's name. Made-up / other-tenant ids → 404.
7. List rows use `Link prefetch={false}` (a page of 50 rows would otherwise prefetch 50 profiles).
8. `kyc` (FR-003 metadata) is accepted by the services (≤ 10 short text values, redacted in audit) but has no form field yet.

**Deviations / files outside the owned paths**

- `apps/web/e2e/customers.spec.ts` (new, T-088's e2e folder, as T-026/T-029 did) and `apps/web/e2e/shell.spec.ts` (T-029, done): it opened `/customers/[id]` with a made-up id and expected 200; it now seeds a real customer for the customer routes and expects the customer's name as that page's title.
- Shared files: `packages/core/src/index.ts` (one export line), `packages/i18n/glossary.md`, generated `apps/web/messages/*.json`.
- No `customers/[id]/layout.tsx`: the T-034/T-048/T-049 tab placeholders don't show the tab bar until those tasks wrap their pages in `CustomerProfileShell`.

**Open questions**

- Should closing a customer also be possible with stopped (suspended) connections? Today any non-disconnected connection blocks it.
- Hindi strings in `customers.json` `_review` (H-03), esp. "Closed" = बंद (same word as a stopped connection) and "सारांश" for Summary.
- Devanagari fuzzy matching depends on the database locale (T-022 Q-B); substring search works regardless.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on the latest `feature/mvp`)

- `pnpm --filter @cb/core test`: 42 files / 608 tests passed, 1 skipped (the opt-in benchmark). New: `rules.test.ts` (phones, LIKE escaping, search terms), `customers.test.ts` (create/typed code/audit; duplicate code friendly error + nothing written; same code at another tenant; the unique-index race; auto codes skipping typed numbers; 6 parallel auto codes distinct; field validation incl. archived area; lineman FORBIDDEN, read-only TENANT_READ_ONLY; update with phone history (source web) and audit before/after; no-change writes nothing; code change rules; area move; lineman phone correction (source android); deactivate refused with open connections, deactivate/reactivate audited; profile with area, balance, connections, last payment; unknown id NOT_FOUND), `search.test.ts` (10 ranking/filter/paging cases incl. VC current vs past holder, typos, Hindi, wildcards, other tenant), isolation (13 cases) and coverage.
- `pnpm --filter web test`: 20 files / 176 tests (new `customers.test.tsx`: error mapping, limits match core, URLs, fields + Hindi, stepper flow, failed save back to step 1 with the inline error and link, tabs).
- `pnpm test:e2e` (scratch DB `cb_e2e_t033`, `E2E_PORT=3233`, pre-installed Chromium): **37 passed**, 6 new in `customers.spec.ts` (add in 3 steps with auto code; duplicate code inline error + "Open that customer"; search by name/phone/VC/code + status filter + open profile + tabs + Take payment link; change details + close refused with a connection + close; other tenant / made-up / non-uuid ids 404; 360px no sideways scroll + cards).
- Screenshots (desktop + 360px list, profile, add) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint` (Biome clean), `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff after committing the regenerated messages), `tokens:build --check`, `icons:build --check`, `i18n:build --check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T15:52:41.844Z claimed by agent-t033
- 2026-10-13T18:58:10.903Z completed on task/T-033-customers-services-list-search-add-profi

---
id: T-051
title: Mobile API contract v1 (Zod → OpenAPI)
phase: 2
area: api
status: done
owner: agent-t051
claimed_at: 2026-10-13T10:41:16.125Z
branch: task/T-051-mobile-api-contract-v1-zod-openapi
depends_on: [T-024]
review: required
claimable_by: agent
size: M
paths: [packages/contracts/**]
---

# T-051 — Mobile API contract v1 (Zod → OpenAPI)

**Phase** 2 · **Area** api · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-024

## Goal

Freeze the Android ↔ server contract early so both sides build in parallel.

## Scope

- Zod schemas for every endpoint in PLAN §10.2 (requests, responses, error envelope with stable codes, pagination cursor, per-item batch results).
- Generate `openapi.json` (committed) with `--check` mode; JSON fixtures for each response in `fixtures/` used by Android decode tests.
- Versioning rules doc (additive changes only within v1).

## Acceptance criteria

- [x] Every field documented; money as integer paise; times as ISO-8601 UTC; ids as UUID strings.

## Tests required

- Schema round-trip tests over fixtures.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/contracts/**`

## Notes

- This task has no DB dependency on purpose. Start it as soon as T-024 is done.

## References

PLAN §10.2, PLAN §10.3, PLAN §10.4, E-05 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/contracts/**`; read `packages/contracts/README.md` first)

- `src/*.ts`: Zod 4 schemas for all 12 endpoints of PLAN §10.2, one module per area (`auth`, `app-config`,
  `sync`, `customers`, `payments`, `collections`, `receipts`) plus `primitives` (wire types), `errors`
  (codes + envelope), `envelope` (`server_time` helper). Everything is exported from `@cb/contracts`
  (value and type share a name: `LoginRequest` is both the schema and `z.infer` of it).
- `src/endpoints.ts`: `ENDPOINTS` (keyed by operationId: method, path, `params`/`query`/`body`/`response`
  schemas, auth, version gate, error codes), `ENDPOINT_LIST`, `errorCodesOf(endpoint)`, `MOBILE_API_BASE_PATH`
  (`/api/mobile/v1`), `CONTRACT_VERSION` (`1.0.0`), `APP_VERSION_HEADER` (`x-app-version-code`), `TAGS`.
- `src/openapi.ts` (not exported from the package entry; it needs the `zod-openapi` dev dependency):
  `buildOpenApiDocument({ examples, errorExamples })`, `openApiJson(doc)`. `src/fixtures.ts` (Node-only, not
  exported): `loadFixtures()`, `describeFixture()`, `fixtureExamples()`, `FIXTURES_DIR`.
- `scripts/openapi-build.ts` → `openapi.json` (committed, OpenAPI 3.1, fixtures embedded as examples).
  Scripts: `openapi:build [--check]` and `generate` (so `pnpm generate` and CI's guarded step run it).
  `@cb/contracts` also exports `./openapi.json`.
- `fixtures/`: 42 files. `<operationId>.request.json` for every body, `<operationId>.response.json` for every
  endpoint, variants (`getAppConfig.response.read-only`, `syncCustomers.response.empty`,
  `getCollectionDay.response.returned`) and `error.<CODE>.json` for each of the 20 error codes. The payment
  batch fixture shows all five outcomes; the receipt-action fixture shows recorded/duplicate/retry_later.
- `README.md`: wire conventions, endpoint → builder/consumer table, implementer notes, **versioning rules
  (additive only within v1)** and the change procedure.

**Contract summary (for T-028, T-060, T-061, T-063, T-064, T-066, T-069, T-070)**

- Conventions: snake_case; money `*_paise` integer (inferred type is `@cb/domain` `Paise` via a type-only cast,
  no transform, so parsed values are branded and servers build responses with `paise()`/`toPaise()`); instants ISO-8601 with `Z`
  only (offsets refused); `business_date`/`{date}` = `BusinessDate`, `period` = `Period` (the 1st); ids
  `z.uuid()`. `server_time` on every success and error body. Header `x-app-version-code` (Android
  versionCode) on every request; bearer auth on all but login/refresh/logout.
- Errors: `ErrorResponse { server_time, error: ApiError { code, message, request_id, fields?,
  min_app_version_code?, retry_after_seconds? } }`. `ERROR_CODES` = `BASE_ERROR_CODES` + `MOBILE_ERROR_CODES`
  (`APP_TOO_OLD` 426, `INVALID_CREDENTIALS` 401, `ACCOUNT_DISABLED` 403, `ROLE_NOT_ALLOWED` 403,
  `REFRESH_TOKEN_INVALID` 401, `DEVICE_REVOKED` 401, `RATE_LIMITED` 429, `CURSOR_INVALID` 400,
  `CUSTOMER_NOT_FOUND` 404, `PAYMENT_NOT_FOUND` 404, `HANDOVER_ALREADY_ACCEPTED` 409, `INTERNAL` 500);
  `ERROR_CODE_INFO[code] = { status, meaning }`, `httpStatusForError(code)`, `isErrorCode`. Per-item batch
  errors use `ItemError { code, message, fields? }`.
- T-028: `login` (`LoginRequest { login, password, device: DeviceInfo { install_id, model, os, app_version,
  app_version_code } }` → `LoginResponse { tokens: TokenPair, user: UserInfo, operator: OperatorInfo, device:
  RegisteredDevice { id, device_code } }`), `refreshTokens` (`{ refresh_token, install_id }` → `{ tokens }`),
  `logout` (`{ refresh_token }`, no bearer needed, never APP_TOO_OLD), `getAppConfig` (`min_app_version_code`,
  `operator` incl. `office_phone` and `receipt_footer`, `tenant_mode`, `features` map; never APP_TOO_OLD).
- T-060 / T-064: `syncCustomers` (`cursor?`, `limit?` 1–500 coerced from the query string →
  `{ customers: RosterCustomer[], removed_customer_ids, next_cursor (always), has_more }`; protocol in
  `src/sync.ts`), `getCustomer` (`{ customer: RosterCustomer, open_bills: OpenBill[], recent_payments }`),
  `updateCustomerPhone` (`{ phone }` 10-digit Indian mobile → `{ changed, customer }`). `RosterCustomer` has
  `balance_paise` (signed ledger balance; due = max(balance, 0)), `credit_paise`, `open_bills` summary,
  `connections[] { vc_number, status }`, `area`, `active`, `updated_at`.
- T-061 / T-066: `postPaymentBatch`: `PaymentBatchItem { id (idempotency key), customer_id, amount_paise,
  method, upi_reference?, notes?, recorded_at, provisional_ref, collector_id, device_id }`, 1–50 per batch →
  `results[]` in request order: `{ id, outcome, payment: PostedPayment | null, review_reason | null, error:
  ItemError | null }` (a refinement enforces which is set). `PostedPayment` carries `receipt_number`,
  `provisional_ref`, `posted_at`, `business_date`, `allocations[] { invoice_id, invoice_number, kind, period,
  amount_paise, outstanding_after_paise }`, `credit_added_paise`, `balance_after_paise`, `credit_after_paise`.
  Servers validate with `PaymentBatchEnvelope` then each item, so one bad item doesn't fail the batch.
- T-061 / T-070: `getCollectionDay` / `submitHandover` → `{ session: CollectionDay { business_date,
  cash_total_paise, upi_total_paise, payment_count, status: open|submitted|accepted|returned, handover |
  null, payments[] } }`. `HandoverRequest { submission_id, cash_handed_over_paise, discrepancy_reason?
  (short|extra|pending_sync|other), note?, unsynced_payment_count, unsynced_cash_paise }`; the server computes
  expected cash and the discrepancy.
- T-061 / T-069: `createReceiptLink` (`{ link: { url (https), expires_at, receipt_number } }`,
  PAYMENT_NOT_FOUND until the payment synced), `postReceiptActions` (`{ id, payment_id, action, at }` 1–100,
  actions `printed|print_failed|whatsapp_opened|sms_opened|pdf_shared` → recorded|duplicate|rejected|
  retry_later; `ReceiptActionsEnvelope` for per-item validation).
- Android (T-063+): generate DTOs from `packages/contracts/openapi.json` and decode `packages/contracts/fixtures/*.json`
  in tests (`ignoreUnknownKeys = true`; `error.code` as String or an enum with an unknown fallback).

**Decisions (please check in review)**

1. **Library: `zod-openapi` 6.0.2** (PLAN §4 names it; peer `zod ^4`, no dependencies, published 2026-08-31),
   added to the pnpm catalog. Validation in tests: `ajv` 8.20.0 + `ajv-formats` 3.0.1 (dev only).
2. **Flat batch results, no `oneOf`.** `{ outcome, payment|null, review_reason|null, error|null }` with a Zod
   refinement instead of a discriminated union, because Kotlin generators handle `oneOf`/discriminators poorly.
3. **Fifth payment outcome `retry_later`** (and the same for receipt actions) beyond PLAN/T-061's
   `posted|duplicate|posted_needs_review|rejected`: a transient per-item server failure must not fail or block
   the whole batch, and it must not be `rejected` (which the app never retries). Maps to PLAN's "network/5xx →
   stays SAVED_ON_PHONE".
4. **Per-item `collector_id` and `device_id`** in the payment item (PRD §13.3 "collector identity, device
   identity"). Never trusted for access; a mismatch with the token gives `posted_needs_review`
   (`collector_mismatch`/`device_mismatch`, PLAN §9.2's "different user signs in").
5. **Post-payment snapshots** (`balance_after_paise`, `credit_after_paise`, `outstanding_after_paise`) so the
   receipt can print "balance after payment" and "Oct bill paid, Nov ₹50 left" (PLAN §11.8) and a replay is
   identical. T-046 must store or derive them.
6. **Force-update gate uses the integer Android `versionCode`** (`min_app_version_code`, header
   `x-app-version-code`) rather than a version-name string (PLAN says `min_app_version`); comparing names is
   error-prone. `/app/config` and `/auth/logout` never answer APP_TOO_OLD.
7. **`additionalProperties: false` is stripped** from the generated document (Zod adds it to output objects):
   the server may add response fields within v1 and ignores unknown request fields. Zod still strips unknown keys
   when parsing, so a response can't leak extra columns.
8. **Read-only tenants (D-13):** payments, handovers, receipt links and receipt actions are allowed; only the
   phone update may answer `TENANT_READ_ONLY` (PLAN §9.4's allowlist doesn't list phone edits).
9. Error `code` is the **one open enum** in v1 (new codes allowed, mapped by HTTP status); all other response
   enums are closed (see README rules).
10. Other details: refresh is bound to `install_id`; logout takes the refresh token (works with an expired
    access token); handover is idempotent on `submission_id` and resubmittable until accepted; roster
    tombstones are a separate `removed_customer_ids` list and `next_cursor` is always present; `features` is a
    `string → boolean` map; phone update accepts only `^[6-9]\d{9}$`.

**Open questions for the reviewer**

- **`/payments:batch` path** (kept from PLAN §10.2): T-061 owns `apps/web/src/app/api/mobile/v1/payments/**`,
  but the route folder for this path is `…/v1/payments:batch/route.ts`, outside that glob (needs a path
  widening for T-061, or a rewrite). Retrofit also needs `"./payments:batch"`. Alternative: rename to
  `/payments/batch` now, before anything consumes it. `/receipts/actions:batch` has neither problem.
- Should receipt links/actions also be blocked in read-only mode? (Chose: no, they are part of collecting.)
- PLAN §11.8 says the receipt shows the collector: today it is `UserInfo.name` from login (the app's own user).
- Kotlin codegen (T-063): OpenAPI 3.1 nullability is `anyOf [ $ref, { type: null } ]`; check the chosen
  generator handles it, or hand-write DTOs and keep the fixture decode tests as the guard.

**Deviations**

- Shared files: `pnpm-workspace.yaml` (catalog `zod-openapi: ^6.0.2`), `pnpm-lock.yaml`. No root script added:
  CI calls `pnpm --filter @cb/contracts openapi:build --check` and `pnpm generate` reaches the package's
  `generate` script.
- `packages/contracts/package.json`: `zod` and `@cb/domain` are runtime `dependencies` (server routes import the
  schemas); `zod-openapi`, `ajv`, `ajv-formats`, `tsx` are dev dependencies.

**Follow-ups (no task files created)**

- T-061: widen its owned path for `payments:batch` (or the rename above).
- Optional: a compatibility test that diffs `openapi.json` against a frozen v1 baseline to enforce the
  additive-only rules mechanically (today they are documented, and reviewers check them).

**Tests / checks** (`packages/contracts`: 4 files, 175 tests)

- `fixtures.test.ts` (**round trip**): coverage (main request/response fixture per endpoint, one error fixture per
  code, every payment outcome, results in request order); each of the 42 fixtures parses with its Zod schema to
  an equal value, survives a JSON round trip, and validates with ajv (draft 2020-12 + formats) against the
  committed `openapi.json`; ajv and Zod both reject a fractional amount, a `+05:30` time, a non-UUID id and a
  missing field, and both accept an unknown extra response field.
- `openapi.test.ts`: committed file is current; one operation per endpoint with summary/description/tag;
  **every property of every schema has a description** (walks the whole document; the walker is proven to flag a
  bare property), every component, parameter, body and response is described; `*_paise` are integers and no
  `number` type exists; `*_at`/`server_time`/`at` are `date-time` with a Z-only pattern; dates/periods are `date`;
  `id`/`*_id`/`*_ids` are `uuid` (except `request_id`); path params; `server_time` required in every response
  body; version header required everywhere; error codes documented under their status; no enum value matches
  `sent|deliver`; no `additionalProperties: false`.
- `schemas.test.ts`: primitive limits, brands (`expectTypeOf` → `Paise`, `BusinessDate`, `Period`), payment item
  rules (UPI ref only with UPI, provisional ref format, 1–50), per-item envelope, result refinements, receipt
  action honesty, sync `limit` coercion, handover amounts, error code set/statuses.

**Verification** (Node v24.21.0, pnpm 12.11.2): `pnpm install --frozen-lockfile`, `pnpm lint` (Biome, 263
files), `pnpm typecheck` 9/9, `pnpm test` 9/9, `pnpm build` 9/9, `pnpm generate` (no diff),
`pnpm --filter @cb/contracts openapi:build --check`, `tokens:build --check`, `icons:build --check`, `i18n:check`,
`i18n:build --check`, `node scripts/tasks.mjs check --local`: all pass. No Android code changed (Android CI still
runs on this PR because of the `packages/contracts/**` path filter).

## Board log

- 2026-10-13T10:41:16.126Z claimed by agent-t051
- 2026-10-13T11:00:04.748Z completed on task/T-051-mobile-api-contract-v1-zod-openapi

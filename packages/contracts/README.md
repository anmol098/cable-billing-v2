# @cb/contracts

The **mobile API contract v1**: what the lineman Android app and the server (`/api/mobile/v1`)
send each other (PLAN §10, E-05). The Zod schemas in `src/` are the source; everything else is
generated from them or checked against them.

| File | What it is |
|---|---|
| `src/*.ts` | Zod schemas, one module per area (`auth`, `app-config`, `sync`, `customers`, `payments`, `collections`, `receipts`), plus `primitives`, `errors`, `envelope` |
| `src/endpoints.ts` | `ENDPOINTS`: every endpoint (method, path, params, body, response, error codes) |
| `openapi.json` | **Generated** OpenAPI 3.1 document (committed, never edit by hand). Android generates its DTOs from it |
| `fixtures/*.json` | Example bodies for every request and response and one per error code. Checked by the tests, embedded in `openapi.json` as examples, decoded by Android tests |

## Commands

```bash
pnpm --filter @cb/contracts openapi:build            # regenerate openapi.json
pnpm --filter @cb/contracts openapi:build --check    # exit 1 if openapi.json is stale (CI: "Generated files")
pnpm --filter @cb/contracts test                     # fixtures round-trip, docs coverage, wire conventions
pnpm generate                                        # every generator in the repo, this one included
```

## Wire conventions

- JSON field names are `snake_case`.
- **Money** is an integer number of **paise** in fields named `*_paise` (₹450 = `45000`). Never a
  float, never rupees. The UI shows whole rupees (D-17). Kotlin: `Long`.
- **Instants** are ISO-8601 strings in UTC with a `Z` (`2026-10-13T05:30:00.000Z`); an offset like
  `+05:30` is refused. Fields end in `_at`, plus `server_time`.
- **Business dates** are `YYYY-MM-DD` in India time (`business_date`, the `{date}` path
  parameter). **Periods** (billing months) are the 1st of the month: `2026-10-01`.
- **Ids** are UUID strings (UUIDv7 in practice). The phone makes payment, receipt-action and
  handover-submission ids itself; they are the idempotency keys.
- Every response, success or error, has `server_time`.
- Every request sends the header `x-app-version-code: <Android versionCode>`; authenticated
  endpoints also send `Authorization: Bearer <access_token>`.
- Errors: HTTP 4xx/5xx with `{ server_time, error: { code, message, request_id, … } }`. The app
  shows the i18n text for `error.code`, never `message` (developer English for logs).
- Optional request fields may be omitted or `null`. Response fields are always present; "no value"
  is `null`.
- Honest states only (BR-12, RULE-19): receipt actions are `printed`, `print_failed`,
  `whatsapp_opened`, `sms_opened`, `pdf_shared`. Nothing in the contract says "sent" or "delivered".

## Endpoints

| Method and path | Operation | Built by | Used by |
|---|---|---|---|
| `POST /auth/login` | `login` | T-028 | T-063 |
| `POST /auth/refresh` | `refreshTokens` | T-028 | T-063 |
| `POST /auth/logout` | `logout` | T-028 | T-071 |
| `GET /app/config` | `getAppConfig` | T-028 | T-063 (force update) |
| `GET /sync/customers?cursor=&limit=` | `syncCustomers` | T-060 | T-064 |
| `GET /customers/{id}` | `getCustomer` | T-060 | T-065 |
| `PATCH /customers/{id}/phone` | `updateCustomerPhone` | T-060 | T-069 |
| `POST /payments:batch` | `postPaymentBatch` | T-061 | T-066 |
| `GET /collections/{date}` | `getCollectionDay` | T-061 | T-070 |
| `POST /collections/{date}/handover` | `submitHandover` | T-061 | T-070 |
| `POST /receipts/{paymentId}/link` | `createReceiptLink` | T-061 | T-069 |
| `POST /receipts/actions:batch` | `postReceiptActions` | T-061 | T-069 |

Notes for the implementers:

- **Server routes** validate with the same entries: `ENDPOINTS.login.body.parse(json)`, and
  `ENDPOINTS.login.response.parse(result)` before sending (it strips anything not in the
  contract, so a DB row can't leak extra columns). Error bodies use `ErrorResponse` with
  `httpStatusForError(code)`.
- **Batches** (`payments:batch`, `receipts/actions:batch`): validate the envelope with
  `PaymentBatchEnvelope` / `ReceiptActionsEnvelope`, then each item on its own, so one malformed
  item comes back `rejected` (VALIDATION) instead of failing the whole batch. Results go in
  request order, one per item.
- **Payment outcomes** (PLAN §10.4): `posted` / `duplicate` → "Sent to office";
  `posted_needs_review` → sent + review flag (`review_reason`); `rejected` → "Call office", never
  retried; `retry_later` → stays "Saved on phone" and is retried. `balance_after_paise`,
  `credit_after_paise` and `outstanding_after_paise` are the values right after posting, so a
  replay returns identical results (T-046 must keep or derive them).
- **Retrofit**: write the payment batch URL as `"./payments:batch"`; a bare `"payments:batch"`
  parses as a URL with the scheme `payments`. (`receipts/actions:batch` is fine.) In Next.js the
  route folder is literally `payments:batch`.
- **Kotlin decoding**: use `ignoreUnknownKeys = true` (new response fields appear within v1), and
  decode `error.code` as a `String` (or an enum with an unknown fallback): it is the one open enum.
- **Roster sync** protocol is in `src/sync.ts`; the CURSOR_INVALID recovery is a full resync.
- **Read-only tenants** (D-13): payments, handovers and receipts keep working; only the phone-number
  update can answer `TENANT_READ_ONLY`.

## Versioning rules: additive only within v1

The Android app in the field may be weeks behind the server, and its queued payments must always
sync (BR-11). So once v1 ships, the server must keep accepting what any supported app sends and
must not send anything an old app can't read.

**Allowed in v1** (bump the minor of `CONTRACT_VERSION` in `src/endpoints.ts`):

- A new endpoint.
- A new **optional** request field or query parameter.
- A new response field (old apps ignore it).
- A new value in a **request** enum (old apps never send it).
- A new **error code**: the only open response enum. Apps map an unknown code by its HTTP status.
- A new feature flag in `GET /app/config` `features` (unknown flags are ignored, missing = off).
- Relaxing a request limit (longer maximum, wider range).
- Better descriptions or examples (bump the patch).

**Not allowed in v1** (these need `/api/mobile/v2`, served next to v1 until
`min_app_version_code` has moved every phone past v1):

- Removing or renaming an endpoint, field, enum value or error code.
- Changing a field's type, unit, format, meaning, or making a response field nullable.
- Adding a **required** request field, or making an optional one required.
- Tightening a request limit (an old app's queued payment would start failing).
- Adding a value to a **response** enum (`outcome`, `status`, `kind`, `method`, `tenant_mode`, …):
  old apps couldn't map it.
- Changing an error code's HTTP status, the idempotency rules, or ordering guarantees (batch
  results in request order; roster in `(updated_at, id)` order).

**How to change the contract**

1. Edit the Zod schema in `src/`, with a `.describe()` on every new field (the tests fail on an
   undocumented property). Keep request and response objects separate; the generator refuses a
   schema shared by both directions.
2. Add or update the fixtures in `fixtures/` (every request and response, every error code).
3. `pnpm --filter @cb/contracts openapi:build`, then `pnpm --filter @cb/contracts test`.
4. Bump `CONTRACT_VERSION`, commit the schemas, fixtures and `openapi.json` together, and say in the
   PR which rule above allows the change. Android regenerates its DTOs from `openapi.json`.

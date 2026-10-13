---
id: T-050
title: Receipt preview links and public receipt page
phase: 2
area: web
status: done
owner: agent-t050
claimed_at: 2026-10-13T13:50:31.974Z
branch: task/T-050-receipt-preview-links-and-public-receipt
depends_on: [T-046, T-005]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/receipts/links/**, apps/web/src/app/r/[token]/**, packages/i18n/messages/*/receipt.json]
---

# T-050 — Receipt preview links and public receipt page

**Phase** 2 · **Area** web · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-046, T-005

## Goal

A safe, minimal web receipt customers can open from WhatsApp/SMS.

## Scope

- Create/reuse link (32-byte token, SHA-256 stored, 90-day expiry), revoke, access logging, rate limit per IP/token.
- Public page: operator name/phone, receipt no., date, amount, method, first name + masked phone, allocation summary, 'Cancelled' stamp if reversed; noindex; bilingual; works on low-end phones (no JS required).
- A5 PDF download of the same receipt.

## Acceptance criteria

- [x] Expired/revoked/unknown tokens show the same generic page (no existence leak).
- [x] Receipt of tenant A never reachable with tenant B context (it's token-only, but test it).

## Tests required

- Integration tests for expiry, revocation, rate limit.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/receipts/links/**`
- `apps/web/src/app/r/[token]/**`
- `packages/i18n/messages/*/receipt.json`

## References

FR-019, FR-020, FR-021, RULE-19, RULE-22, D-14, PLAN §9.4 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/receipts/links/` (exported from `@cb/core` by one appended line `export * from "./receipts/links";`) | `createReceiptLink`, `revokeReceiptLinks` (services), `openReceiptLink` (public lookup), `loadPublicReceipt` + `PublicReceipt` (the public view), `purgeExpiredReceiptLinksJob` (weekly purge), token helpers, `customerFirstName` / `maskPhone`. |
| `apps/web/src/app/r/[token]/route.ts` | `GET /r/<token>`: the receipt page (route handler, plain HTML, no JS). |
| `apps/web/src/app/r/[token]/pdf/route.ts` | `GET /r/<token>/pdf`: the same receipt as an A5 PDF download. |
| `apps/web/src/app/r/[token]/_lib/` | `handler.ts` (limits + lookup + generic responses + headers), `content.ts` (receipt → lines, shared by page and PDF), `html.ts`, `pdf.ts`, `style.ts` (inline CSS from tokens), `i18n.ts`, `fonts/` (Noto Sans Devanagari Regular + SemiBold + OFL). |
| `apps/web/src/app/api/cron/receipt-links-cleanup/route.ts` | T-043's stub replaced (T-043 note: T-050 edits it): enqueues the purge job (dedupe key). |
| `packages/i18n/messages/{en,hi}/receipt.json` | Page/PDF words (Hindi in `_review`, wording copied from `mobile_printer.receipt.*` where the same). |

**API for T-061 / T-069 / T-049 / T-048**

```ts
// Create (POST /api/mobile/v1/receipts/{paymentId}/link, T-061; web "Share" buttons, T-048/T-049)
const r = await createReceiptLink.call(runtime, ctx, { paymentId });
// ok → { linkId, receiptId, receiptNumber, token, expiresAt }
// contract ReceiptLink = { url: receiptLinkUrl(baseUrls().receipt, r.value.token),
//                         expires_at: r.value.expiresAt.toISOString(), receipt_number: r.value.receiptNumber }
// NOT_FOUND (payment not in tenant / not synced yet) → PAYMENT_NOT_FOUND on mobile.
// CONFLICT details.reason "too_many_links" (20 live links on one receipt) → retry_later-style message.
// Revoke (Owner/Staff web UI, T-049; any receipts.share role):
await revokeReceiptLinks.call(runtime, ctx, { paymentId }); // ok → { receiptId, revoked: n }
```

- **URL shape:** `<RECEIPT_BASE_URL or APP_BASE_URL>/r/<43-char base64url token>`; PDF `…/r/<token>/pdf`.
  Optional `?lang=hi|en` (T-069 may append the receipt language; default = operator `default_language`).
  Contract-compatible with T-051 (`url` https in production; no request body).
- Both services: capability `receipts.share` (Owner, Staff, Lineman; allowed in read-only mode, D-13).
  `create` audits `receipts.create_link` (entity `receipt_link`, `after: { receipt_id, expires_at }`, never
  the token); `revoke` audits the revoked link ids (or `skip("no_change")`). Isolation cases in
  `links.isolation.ts` (coverage test passes).
- Public side: `openReceiptLink({ db, limiter, logger, now?, limits? }, { token, clientIp, format })` →
  `{ kind: "ok", receipt } | { kind: "unavailable" } | { kind: "rate_limited", retryAfterSeconds }`.
- Job `receipts.purge_expired_links` (platform): deletes links expired > 30 days ago (`RECEIPT_LINK_PURGE_AFTER_DAYS`)
  per tenant in `withTenant` (tenant DELETE policy; no platform DELETE policy added), 1000 per transaction,
  one system audit event per tenant, `continueLater` near the time budget. The weekly cron enqueues it.

**Privacy and security decisions (reviewer please check)**

1. **Token:** 32 bytes from `crypto.randomBytes`, base64url (43 chars); only `sha256(token)` hex is stored.
   The raw token is returned once to the creator and is never logged, audited or stored (tested: not in the
   row, audit rows or logs).
2. **No link reuse (deviation from "reuse an unexpired link").** With only the hash stored, an existing
   link's URL can't be rebuilt, so every `create` makes a new link; older links keep working until expiry or
   revocation. A receipt may have at most 20 live links (CONFLICT `too_many_links`). Reuse would need either
   storing the token encrypted or HMAC-derived tokens from a server key (a new secret); both weaken "hash only
   at rest", so I did neither. **Product-owner decision if reuse matters.**
3. **Lookup order:** rate limits first (both counters hit on every request) → token shape check → one
   indexed `withPlatform` SELECT by hash (read only) → only for a live link, `withTenant(link.operator_id)`
   (operator id from the DB row, never from the request) counts the view with an `UPDATE … WHERE
   revoked_at IS NULL AND expires_at > now` (a revoke that commits after the lookup wins) and reads that one
   receipt.
4. **No existence oracle:** malformed, unknown, expired and revoked tokens get the identical `unavailable`
   result → the identical bilingual generic page with **404** (byte-identical bodies, tested in e2e for page
   and PDF). The generic page doesn't depend on the operator (both languages). Unknown/expired/revoked cost
   the same one SELECT; a malformed token skips the DB (its shape is public knowledge).
5. **Status codes:** receipt 200; dead link 404; rate limited 429 + `Retry-After` (same generic page for every
   token, so it leaks nothing); server not configured / DB error 503.
6. **Headers on every `/r/*` response:** `X-Robots-Tag: noindex, nofollow, noarchive`,
   `Cache-Control: private, no-store, max-age=0`, `Referrer-Policy: no-referrer` (+ `<meta name="robots">`
   and `<meta name="referrer">` in the HTML). `next.config.ts` got a `/r/:path*` header rule because the
   app-wide `Referrer-Policy` from `next.config` overrides route-handler headers.
7. **Rate limits** (`RECEIPT_LINK_RATE_LIMITS`): 120 views / 10 min per IP (generous: carrier-grade NAT),
   30 / 10 min per token. Keys are `rateLimitKey(...)` SHA-256 hashes (T-026), so neither IP nor token is
   kept in clear even in the limiter. Upstash when `UPSTASH_REDIS_REST_*` are set (production requires them),
   else T-026's in-memory limiter (per instance; a warning is logged on Vercel). A limiter outage fails open
   with an error log (receipts must not go down with Redis), same policy as T-026's auth hooks.
8. **Access logging without PII:** one JSON line per request: `receipt_link.opened` (operator_id,
   receipt_id, link_id, format, access_count, cancelled), `receipt_link.unavailable` (reason
   malformed/unknown/expired/revoked; ids only when a row was found), `receipt_link.rate_limited`
   (scope ip/token). Never the token, its hash, the IP or the user agent (the strict test logger enforces
   it; a test also greps the records). Durable per-link counters: `access_count`, `last_access_at`.
9. **Data shown** (PLAN §9.4): operator name + phone (`office_phone`, else `operators.phone`), receipt no.
   (+ temporary `P-…` no. if any), date/time (IST), customer **first name** (titles like Shri/Smt/श्री
   skipped, max 24 chars) + phone masked to `XXXXXX` + last 4 digits (none if < 8 digits), amount
   (`formatINR`, Indian grouping), method, bills paid (`Oct 2026 bill: ₹50 left`), balance after (due /
   credit / nothing due), the operator footer. **Not shown:** surname, customer code, address, full phone,
   UPI reference, notes, lineman. Order follows T-068 `ReceiptContent` minus those fields.
10. **Cancelled:** a `payment_reversals` row → "Cancelled / रद्द" stamp, struck-through amount, note
    "The office cancelled this payment", and no bills/balance (they described a payment that no longer counts).
11. **Page tech:** route handlers, not React pages: full control of status and headers, and a ~6 KB HTML
    document with inline token CSS and **zero JavaScript** (works with JS off; e2e checks no `<script>`).
    No web fonts on the page (system Devanagari fonts on phones); all values HTML-escaped (tested).
12. **PDF:** PDFKit 0.20.2 (maintained, pure JS, Node runtime; Next keeps it external), Noto Sans Devanagari
    TTFs **bundled in the repo** (`_lib/fonts`, copied from the Android design system, OFL included) and read
    from disk via `new URL(…, import.meta.url)`, never fetched. Devanagari shaping checked visually
    (conjuncts, matras, reph, ₹). A5 portrait; sizes/colours from tokens; about 12 KB (subset fonts).
13. Honest states: nothing on the page says "sent" or "delivered".

**Deviations / shared files**

- No link reuse (decision 2).
- `apps/web/next.config.ts`: one `headers()` entry for `/r/:path*` (decision 6).
- `apps/web/package.json`: `pdfkit` ^0.20.2, `@types/pdfkit` (dev), `@cb/domain`, `@cb/design-tokens`
  (workspace); `pnpm-lock.yaml`.
- `packages/design-tokens/package.json`: export `./tokens.json` (the page/PDF read token values).
  `packages/ui/package.json`: export `./icons-data` (the generated Lucide map, so the page can inline the same
  icons without importing React components). Both done tasks; additive subpath exports only.
- `apps/web/src/app/api/cron/receipt-links-cleanup/route.ts` (T-043 stub, as its notes asked).
- `apps/web/e2e/receipt-link.spec.ts` (new file; DB tests skip without `DATABASE_URL`, like T-026's).
- Generated `apps/web/messages/{en,hi}.json`.
- Deleted the placeholder `apps/web/src/app/r/[token]/.gitkeep`.

**Follow-ups / open questions**

- Link reuse (decision 2) if the product owner wants one URL per receipt.
- WhatsApp's link-preview crawler fetches the URL when the lineman pastes it: it counts as a view and uses
  the per-token budget (30/10 min, ample). The page title is only "Receipt R-…" (no personal data in previews).
- The mobile endpoint itself (`POST /receipts/{paymentId}/link`) is T-061's; the web "Share link"/"Switch off
  link" buttons are T-048/T-049's.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core`: `links.test.ts` 15 DB tests + `units.test.ts` 22 + isolation cases (2): create (hash only,
  90 days, audit, token in no row/audit/log, new token per call, every role, read-only tenant, NOT_FOUND,
  VALIDATION, 20-link cap), open (exact view incl. first name/masked phone and nothing else, access count +
  last access, logs without token/hash/IP, operator-phone fallback, Hindi default), **expiry** (works 1 ms
  before, not at the instant or later; nothing counted), **revocation** (all live links, by Staff, revoked_by,
  one-way: DB refuses un-revoking, new link works after), **no existence leak** (malformed ×2, unknown,
  expired, revoked → identical result, nothing counted), **cross-tenant** (each token only its own tenant;
  tenant B's transaction can't load A's receipt by either operator id or see A's link row; B can't create/
  revoke for A's payment), cancelled receipt, **rate limits** (per token before lookup and identical for an
  unknown token, window reset with an injected clock, per IP across tokens, fail-open on limiter outage),
  purge job (two tenants, 30-day boundary, receipts kept, audit per tenant, idempotent).
- Mutation checks (reverted): dropping the revocation checks → 2 tests fail; skipping the rate limits → 3 fail.
- `apps/web` unit tests (12): content in en/hi (order, IST clock incl. midnight/noon, Indian grouping, bill
  lines), escaping, no scripts, noindex, generic pages identical and bilingual, CSS only token colours and no
  px/shadow/gradient, real A5 PDF with the Devanagari font embedded, file name.
- Playwright (`next start`, migrated scratch DB, `E2E_PORT=3250`): full suite 21 passed. Receipt spec: unknown
  link → 404 generic page without JS and private headers (503 when no DB is configured); page with
  **JavaScript disabled** shows operator, ₹500, Cash, "Ramesh", `XXXXXX3210`, not surname/phone/code, no
  `<script>`; language switch link → Hindi; fits 360 px with no sideways scroll; **PDF download** from the page
  (`receipt-R-….pdf`, `%PDF-`, Noto embedded); PDF headers; revoked link page and PDF byte-identical to an
  unknown link (404); reversed payment shows the Cancelled stamp.
- Root: `pnpm install`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9), `pnpm build` (9/9; web build
  with no `DATABASE_URL`/`BETTER_AUTH_SECRET`), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T13:50:31.974Z claimed by agent-t050
- 2026-10-13T14:21:20.413Z completed on task/T-050-receipt-preview-links-and-public-receipt

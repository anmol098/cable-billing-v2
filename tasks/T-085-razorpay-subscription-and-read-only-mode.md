---
id: T-085
title: Razorpay subscription and read-only mode
phase: 4
area: core
status: done
owner: agent-t085
claimed_at: 2026-10-14T04:25:41.531Z
branch: task/T-085-razorpay-subscription-and-read-only-mode
depends_on: [T-025, T-043, T-029]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/subscriptions/**, apps/web/src/app/api/webhooks/razorpay/**, apps/web/src/app/api/cron/subscription-states/**, apps/web/src/app/(operator)/settings/subscription/**, packages/i18n/messages/*/subscription.json]
---

# T-085 — Razorpay subscription and read-only mode

**Phase** 4 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-025, T-043, T-029

## Goal

Operators pay ₹400 + GST/month online; access follows subscription state.

## Scope

- Config-driven plan (₹400 + 18% GST = ₹472; RAZORPAY_PLAN_ID).
- Subscription checkout (UPI Autopay/card), webhook endpoint with HMAC verification + idempotent `subscription_events`, state machine trialing→active→grace(15d)→read_only, cancelled.
- Daily cron: date-based transitions, Razorpay reconciliation, reminder emails (T-7, T-1, grace start).
- Banners in shell; `assertWritable` integration; missed-run list hook for T-044.

## Acceptance criteria

- [x] In read_only: web mutations blocked except allowlist; Android payment sync still works (PRD/D-13).
- [x] Duplicate webhook delivery has no effect.

## Tests required

- State machine unit tests; webhook signature + idempotency integration tests (Razorpay test mode fixtures).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/subscriptions/**`
- `apps/web/src/app/api/webhooks/razorpay/**`
- `apps/web/src/app/api/cron/subscription-states/**`
- `apps/web/src/app/(operator)/settings/subscription/**`
- `packages/i18n/messages/*/subscription.json`

## Notes

- Needs H-01 (Razorpay keys) and H-10 (GSTIN) before production; build and test with fixtures first.

## References

PLAN §13, FR-025, D-12, D-13, D-20, D-22, D-25 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/core/src/subscriptions/**`, exported from `@cb/core` through one line
`export * from "./subscriptions";`)

| Module | What |
|---|---|
| `plan.ts` | The config-driven plan: `MONTHLY_PLAN` (`code: "monthly_400_gst18"`, ₹400 + 18% GST = **₹472**, monthly, `totalCount` 120), `CURRENT_PLAN`, `SUBSCRIPTION_PLANS`, `planFor(code)`, `gstOn` (exact paise or throws), `GRACE_DAYS` (15), `REMINDER_DAYS_BEFORE` ([7, 1]), `SUBSCRIPTION_FACTS` (price, GST, total, trial and grace days: T-087's `facts.ts` now reads these). Money is integer paise everywhere. |
| `state.ts` | The pure state machine `nextSubscriptionState(state, change, now)` → `{ state, transitions, reactivated, ignored? }`; changes `clock`, `razorpay` (a snapshot of the subscription: id, status, `current_end`, time), `checkout_created`, `manual_extend` (for T-086). `graceEndsAt(lapse)`, `istMidnightOnOrAfter`, `lastDayBefore`, `daysUntil`, `dueNotice(state, now)` (T-7 / T-1 / grace start / grace T-7 / T-1), `reactivatedNotice`, `AUTOPAY_ON_STATUSES`. |
| `store.ts` | `applySubscriptionChange(tx, { operatorId, change, now, actor, source, requestId?, planCode?, recordAudit? })`: locks the row (`FOR UPDATE`), runs the machine, writes the row + one `subscription.state_changed` audit event only when something changed (idempotent), and returns `missedRunPeriods` when the tenant left read-only mode. `readSubscription`, `missedRunPeriods(tx, operatorId)` (skipped `billing_runs`, D-25). |
| `razorpay/` | `createRazorpayClient({ keyId, keySecret, baseUrl?, fetch?, timeoutMs? })` (REST, Basic auth, no SDK: create / fetch / cancel subscription, fetch plan; `RazorpayApiError(status, code)` never carries Razorpay's descriptions); `createFakeRazorpayClient()` (in-memory, records calls, `update(id, …)`, `failNext`); `verifyWebhookSignature(rawBody, sig, secret)` and `verifyCheckoutSignature({ paymentId, subscriptionId, signature }, keySecret)` (HMAC-SHA256 hex, `timingSafeEqual`), `razorpayHmac`; loose Zod schemas of the documented JSON (`RazorpayWebhookBody`, `RazorpaySubscriptionEntity`, `RazorpayPlanEntity`). |
| `webhook.ts` | `handleRazorpayWebhook({ db, log, now, secret }, { rawBody, signature, eventId })` → `{ httpStatus, outcome: applied \| no_change \| duplicate \| unmatched \| invalid_signature \| bad_request, operatorId?, reactivated?, state?, missedRunPeriods? }`. |
| `services.ts` | Services (capability `subscription.manage`: Owner only, allowed in read-only mode): `subscriptions.overview` (`SubscriptionView`: status, mode, dates, `accessLastDay` (IST), `autopay` on / not_finished / failing / off, plan amounts, `missedRunPeriods`, `canPay`; audit skipped `no_change`) and `subscriptions.record_checkout` (audited `subscriptions.checkout_started`). Isolation cases in `subscriptions.isolation.ts`. |
| `checkout.ts` | `startSubscriptionCheckout(runtime, ctx, { razorpay, keyId, planId })` → `open_checkout { keyId, subscriptionId, firstChargeAt, totalPaise }` or `autopay_on { view }`; `confirmSubscriptionCheckout(runtime, ctx, { razorpay, keySecret }, { paymentId, subscriptionId, signature })` → `SubscriptionView`. Errors: core codes + `PLAN_MISMATCH`, `PAYMENT_PROVIDER_ERROR` (`details.razorpayCode/httpStatus`), `BAD_SIGNATURE`. |
| `reconcile.ts` | `reconcileWithRazorpay({ db, razorpay, operatorId, now, actor, source })` (API read outside any transaction, then the same machine); `needsReconcile(state, now)`. |
| `daily.ts` | `runSubscriptionStates({ db, now, log, razorpay \| null, notifier \| null, concurrency?, budgetMs?, elapsed? })` → report; throws `SubscriptionStatesError` (with the report) after the pass if any tenant failed for a non-Razorpay reason. |
| `notices.ts` | `sendSubscriptionNotice(...)`, `noticeRecipients` (active owners with an email), `noticeAlreadySent` (audit `subscription.notice_sent`, `after.key`), types `SubscriptionNotifier { transport, render }`, `RenderSubscriptionNotice`. Transport = T-043's `EmailTransport` (Resend `Idempotency-Key = subscription-notice/<tenant>/<key>/<user>`). |

apps/web: `api/webhooks/razorpay/route.ts` (+ `_lib/handler.ts`), `api/cron/subscription-states/route.ts`
(T-043 stub replaced), `(operator)/settings/subscription/{page,subscription-view,pay-button,actions}.tsx`
(T-029 placeholder replaced), `lib/subscription/{server,notice-email}.ts` (env → Razorpay client, email
transport and the words), the shell banner (`bannerFor` gains `trial_ending`, `loadShellData` reads
`trial_ends_at` + autopay), i18n namespace `subscription` (en + hi, all Hindi in `_review`), glossary
section "Subscription words".

**State machine (PLAN §13)**

| From | When | To | Access |
|---|---|---|---|
| (sign-up, T-027) | — | `trialing`, `trial_ends_at` = 00:00 IST of sign-up day + 31 | full |
| `trialing` | clock ≥ `trial_ends_at` | `grace`, `grace_ends_at` = 15 whole IST days later (00:00 IST) | full + Owner banner "Pay by {last day}" |
| any | Razorpay says `active` with `current_end` in the future (webhook `activated`/`charged`, API read, checkout confirm) | `active`, `current_period_end` = the later of stored / reported; grace and cancellation cleared | full |
| `active` | clock ≥ `current_period_end`, no newer charge | `grace` (`grace_ends_at` from the period end), or `cancelled` if autopay was cancelled | full / read-only |
| `active` with paid time left | Razorpay `cancelled` | stays `active`, `cancelled_at` set (paid time honoured) | full |
| `grace`, `read_only` | Razorpay `cancelled` | `cancelled` | read-only |
| `trialing` | Razorpay `cancelled` / `authenticated` | unchanged (trial is free) | full |
| `active` | Razorpay `pending` / `halted` | `grace` only once the paid end has passed (same as the clock) | — |
| `grace` | clock ≥ `grace_ends_at` | `read_only` | view + collections (D-13) |
| any | admin extends until a future date (T-086: `applySubscriptionChange` with `manual_extend`) | `active` | full |

A Razorpay report about a subscription that isn't the tenant's current one is ignored; an older report never
overwrites a newer `razorpay_status` (`razorpay_status_at`); a long outage chains (trialing → grace →
read_only in one run). Leaving read-only mode (`reactivated`) lists the skipped bill months (D-25 hook for
T-044's `missedRuns`): webhook → "working again" email after the response (Next `after`), cron → same email,
page → "Missed bill runs" card linking to `/bills/runs`; they are never billed automatically.

**Webhook** (`POST /api/webhooks/razorpay`): raw body → HMAC-SHA256 with `RAZORPAY_WEBHOOK_SECRET`,
constant-time (401, nothing parsed or stored) → `x-razorpay-event-id` (400 if missing) → tenant by stored
`razorpay_subscription_id` (and `notes.operator_id` must agree) → in **one** `withTenant` transaction:
`INSERT … ON CONFLICT (razorpay_event_id) DO NOTHING` (nothing inserted = `duplicate`, no effect), apply,
`processed_at`. A thrown error rolls the insert back, so Razorpay's retry re-processes (500 + Sentry).
Unmatched / subscription-less / unreadable signed events are stored (platform, `operator_id` NULL,
`processing_error` `unmatched_subscription` / `no_subscription` / `unreadable_payload` /
`operator_mismatch`) and answered 200. 503 while the secret is unset, 413 over 256 KB. The header
`x-razorpay-event-id` is not signed, so a captured body replayed under a new id is stored but changes
nothing (the machine is idempotent and ignores older reports; tested).

**Checkout** (Settings → App subscription → "Pay ₹472 a month"): server action `startCheckoutAction` →
`startSubscriptionCheckout` (reuse an unfinished `created` subscription; `authenticated`/`active` → "autopay
already on"; `pending`/`halted`/`paused` → cancel the old one first, so two mandates can never both charge;
the Razorpay plan must be exactly ₹472 INR every 1 month or `PLAN_MISMATCH`; first charge `start_at` = end
of the trial / paid month when ≥ 15 min ahead, so nobody pays twice for the same days) → browser loads
`checkout.razorpay.com/v1/checkout.js` only on click → handler → `confirmCheckoutAction` → signature over
`payment_id|subscription_id` with the key secret + must be the tenant's current subscription → reads the
subscription from Razorpay's API and applies it. The browser's word alone never changes the state. Success
is a toast ("Thank you. Paid till 13 Dec 2026." / "Autopay is on. The first payment is on …"); closing
Checkout says "Payment was not finished"; Razorpay down / not set up are said in words. Without keys the
page says "Online payment is not set up yet. Please call support." (no button). Owner only (404 otherwise).

**Daily cron** (`subscription-states`, 06:00 IST): per active operator, nearest deadline first, 4 in
parallel, 240 s budget: reconcile with Razorpay when `needsReconcile` (a subscription exists, Razorpay
hasn't said it's finished, and the tenant isn't safely mid-month: active tenants only within 36 h of the
paid end), then the clock, then at most one reminder (each key once; a failed send is retried next run;
no owner email → logged). Razorpay errors are counted (`reconcile_errors`) and the dates still apply.

**Env vars:** no new production variable. All four Razorpay variables already existed (T-011) and
production still requires live keys. New **`RAZORPAY_API_BASE_URL`** (local/CI e2e only: http + localhost
only, refused on any Vercel deployment, like `EMAIL_OUTBOX_DIR`): schema, `.env.example`,
`apps/web/turbo.json`, runbook table, env test. Playwright sets fake test-mode keys and starts
`e2e/support/razorpay-mock.mjs` as a second web server.

**Read-only integration (`assertWritable`, T-025):** unchanged allowlist (`payments.record`,
`receipts.share`, `handover.submit`, `subscription.manage`). New `subscriptions/read-only.test.ts` calls
**every discovered write service** with its own isolation case's valid input in `read_only`, `cancelled`
and `active` tenants, for every allowed role, against a hand-written allowlist (adding a capability to the
allowlist makes it fail: checked). `apps/web/.../subscription-states/read-only.test.ts` runs the real flow:
cron moves the trial to grace then read_only → T-061's `/payments:batch` handler still posts → profile edit
and `billing.start_run` → TENANT_READ_ONLY → Owner checkout works → signed `subscription.charged` →
active → edits and sync work again.

**Human steps for H-01 (Razorpay)** — `docs/runbooks/environments.md` §4.7 (updated):
1. Razorpay account; ask support to enable Subscriptions + UPI Autopay; start live KYC early.
2. Test mode: API keys → `RAZORPAY_KEY_ID` (`rzp_test_…`) / `RAZORPAY_KEY_SECRET` (staging, previews).
3. Subscriptions → Plans → monthly, every **1** month, **₹472** (₹400 + 18% GST, D-22) → `RAZORPAY_PLAN_ID`.
   Checkout refuses any other amount/period.
4. Webhooks → URL `<APP_BASE_URL>/api/webhooks/razorpay`, secret `openssl rand -hex 32` →
   `RAZORPAY_WEBHOOK_SECRET`, events `subscription.authenticated`, `.activated`, `.charged`, `.pending`,
   `.halted`, `.cancelled`, `.completed`, `payment.failed`.
5. Live mode: repeat with live keys, a live plan and a live webhook (own secret) for Production only.
6. Check on staging: pay with `success@razorpay` → webhook deliveries 200 → page "Paid till …".
H-10 (GSTIN) is still needed for tax invoices of our fee (not built here; see open questions).

**Decisions (reviewer please check)**
1. **One `subscriptions` migration** (`0012_subscription_razorpay_status`): `razorpay_status` (text +
   CHECK of Razorpay's 9 statuses) and `razorpay_status_at`, edited into T-021's `schema/subscriptions.ts`
   (done task, small): needed to say "Autopay is on" honestly, to skip reminders when autopay is set, and to
   order out-of-order webhooks. No change to policies or the append-only trigger.
2. **Cancelling autopay with paid time left keeps access until the paid end, then `cancelled` (no grace)**;
   a new checkout clears the cancellation. Razorpay `cancelled` during grace/read-only → `cancelled`.
3. **Grace is measured from the lapse**, not from when the cron noticed: `grace_ends_at` = 00:00 IST, 15
   whole days after the lapse day (rest of the lapse day free on top), like T-027's trial rule.
4. **Reminders:** trial T-7 / T-1 (not when autopay is already authorised), grace start, and **also grace
   T-7 / T-1 before view-only** (my reading of "T-7, T-1, grace start" for both deadlines). Windowed (a
   missed cron day still sends), at most one per run, each once, recorded in the tenant's audit log
   (`subscription.notice_sent`), no new table.
5. **Checkout confirmation reads Razorpay's API** instead of trusting the browser; webhooks remain the main
   driver and do the same thing a moment later.
6. The Owner's **subscription page shows stored state** (the cron moves it at 06:00 IST, so for ≤ 6 h after
   midnight a lapsed tenant still has full access): same source as `assertWritable` and the banner.
7. **Staff never see the trial/grace warnings** (T-029 rule kept); the new trial banner is Owner-only.
8. Overview uses the write capability `subscription.manage` with `audit.skip("no_change")` (there is no
   read capability for the Owner-only page); the Owner-only boundary is in the service.
9. Owner **cancel from our UI is not built** (out of the listed scope): an Owner can cancel the mandate in
   their UPI app / bank, which Razorpay reports as `subscription.cancelled`.

**Deviations / files outside the owned paths (all small)**
- `packages/db/src/schema/subscriptions.ts` + migration `0012_*` + journal/snapshot (decision 1).
- `packages/core/src/index.ts` (one export line); `apps/web/src/components/shell/{subscription-banner.tsx,
  shell-data.ts}` (T-029 said to extend there; existing grace dates unchanged except a grace end at exactly
  00:00 IST now reads as the previous day, the true last day); `apps/web/src/lib/subscription/**` (new; env
  wiring shared by the webhook, cron and page); `apps/web/src/lib/security-headers.ts` (+test):
  `checkout.razorpay.com` in `script-src`, `api.razorpay.com` in `frame-src` (CSP is report-only);
  `apps/web/src/env.ts` (+test), `.env.example`, `turbo.json`, runbook §3/§4.7/§6;
  `apps/web/src/app/(marketing)/_lib/facts.ts` (reads `SUBSCRIPTION_FACTS`, T-087 asked for it);
  `apps/web/playwright.config.ts` (fake Razorpay env + the mock as a second `webServer`),
  `apps/web/e2e/{subscription.spec.ts,support/razorpay-mock.mjs}`; removed `api/webhooks/.gitkeep`;
  `packages/i18n/glossary.md`; generated `apps/web/messages/*.json`.

**Open questions (product owner)**
- Decisions 2, 4 and 6 above.
- Tax invoices for our fee (GSTIN, H-10): Razorpay can send its own invoices for subscriptions; do we need
  our own GST tax invoice document? Not built.
- `total_count` 120 months per mandate (Razorpay requires a count; UPI Autopay mandates may have a lower
  limit on the bank side — check during H-01). When it completes, the tenant simply goes to grace and pays again.
- Do Staff need to see "trial ends soon"? (Today Owner only, like grace.)
- Admin "extend / record offline payment" (T-086): call `applySubscriptionChange` with
  `{ kind: "manual_extend", until }` in the tenant's transaction, `actor: { kind: "system" }` or the admin,
  and write a platform audit event.

**Known pre-existing e2e hazard (not changed):** the specs seed logins in `beforeAll` from a describe-level
random suffix; Playwright re-runs `beforeAll` when a worker returns to a file after another file's tests, which
can seed the same login twice (`users_login_unique`). Seen once locally in `customers.spec.ts` (T-033's
file) in one of two full runs; `subscription.spec.ts` makes its suffix inside `beforeAll` to avoid it.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)
- `@cb/core` (58 files, 825 passed + 1 pre-existing skip): `state.test.ts` (27: every transition, exact-instant
  edges, late cron, chained outage, out-of-order/older/foreign reports, cancellation rules, manual extend,
  reminder windows and keys, plan numbers), `webhook.test.ts` (11, real DB: 7 bad-signature shapes + empty
  secret → 401 and a byte-identical database; applied then 3 duplicates; **8 concurrent deliveries → 1
  stored, 1 applied, 1 audit event**; replay under a new event id; full lifecycle from the Razorpay
  test-mode fixtures in `fixtures/*.json` incl. out-of-order; reactivation with missed months; unmatched /
  no-subscription / unreadable / not-JSON / no event id; operator_mismatch; isolation; append-only; no PII
  in logs), `checkout.test.ts` (11, fake Razorpay: Staff FORBIDDEN with no Razorpay call; trial →
  `start_at` = trial end, recorded + audited, reused on a second press; read-only pays at once; autopay
  already on; halted → old cancelled first, failed cancel → nothing new; plan mismatch; provider outage;
  confirm: forged signature, other subscription, not yet charged, charged → active with missed months),
  `daily.test.ts` (7: date transitions + idempotency, cancelled vs grace, reminders day by day in Hindi
  exactly once each, retry of a failed send, no recipients, reconciliation reactivates + email, who gets
  asked, Razorpay outage, suspended operators, budget), `read-only.test.ts` (every write service × role ×
  read_only/cancelled/active), isolation + coverage suites.
- Mutation checks (reverted): `customers.manage` added to the allowlist → read-only matrix fails (8
  problems listed); `ON CONFLICT DO NOTHING` removed from the webhook insert → the duplicate and the
  concurrency tests fail.
- `@cb/web` (39 files, 339 tests): webhook route (401/400/503/413, applied/duplicate, the "working again"
  email after the response, 500 on a DB failure), the read-only flow with T-061's handler, the page in
  every state (EN + HI), the Pay button with a fake Checkout (open → handler → confirm; closed; errors;
  autopay on; "not confirmed yet"), the trial banner, the emails (EN + HI, honest wording), env and CSP tests.
- Playwright (`next start`, migrated scratch DB, pre-installed Chromium, local Razorpay mock): **71 passed**,
  5 new in `subscription.spec.ts` (read-only Owner pays → forged handler refused → paid → active, banner
  gone; 360 px from the banner without sideways scroll; closing Checkout; webhook 401 / applied /
  duplicate; Staff 404).
- Root: `pnpm install`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10), `pnpm build` (10/10, no
  env), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-14T04:25:41.533Z claimed by agent-t085
- 2026-10-14T05:11:28.202Z completed on task/T-085-razorpay-subscription-and-read-only-mode

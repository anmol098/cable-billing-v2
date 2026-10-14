---
id: T-086
title: Platform admin console
phase: 4
area: web
status: done
owner: agent-t086
claimed_at: 2026-10-14T08:08:26.671Z
branch: task/T-086-platform-admin-console
depends_on: [T-026, T-043, T-085]
review: required
claimable_by: agent
size: L
paths: [apps/web/src/app/admin/**, packages/core/src/admin/**, packages/i18n/messages/*/admin.json]
---

# T-086 — Platform admin console

**Phase** 4 · **Area** web · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-026, T-043, T-085

## Goal

We can run the SaaS without touching the database by hand.

## Scope

- Tenants list/detail (status, trial/subscription, counts, last activity), create tenant (uses provisionTenant), extend/record offline payment (audited).
- Job monitor (billing runs across tenants, failures, retry), Razorpay event log, platform audit log, metrics from PRD §16.
- Support access: time-boxed (2h), reason required, visible in tenant audit log; no routine access to tenant financial data.

## Acceptance criteria

- [x] All admin routes require platform_admin + 2FA.

## Tests required

- Integration tests for support-access expiry and audit.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/admin/**`
- `packages/core/src/admin/**`
- `packages/i18n/messages/*/admin.json`

## References

PLAN §12.4, PLAN §9.4, PRD §3 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/db/src/schema/platform-admin.ts` (+ migrations `0016_platform_admin`, `0017_platform_admin_grants`) | Tables `support_access_grants` and `subscription_offline_payments`; six column-limited `app_platform` read policies (`PLATFORM_READ_COLUMNS`, `platformReadGrantsSql()`); `SUPPORT_ACCESS_MAX_MINUTES` (120), `OFFLINE_PAYMENT_METHODS`, `OFFLINE_PAYMENT_MAX_MONTHS` (12). |
| `packages/core/src/admin/context.ts` | `resolveAdminContext(runtime, { userId, twoFactorEnabled, requestId, client? })` → branded, frozen, registry-checked `AdminContext` (like `TenantContext`). Refusals: UNAUTHENTICATED `unknown_user`, ACCOUNT_DISABLED `user_disabled`, FORBIDDEN `not_a_platform_admin` / `two_factor_required`. |
| `packages/core/src/admin/service.ts` | `defineAdminService({ name: "admin.x", input, run })`: refuses unissued contexts (throws), validates, maps errors, logs ids/codes only, and **fails a successful call that wrote no platform audit event** (reads included). `audit.platform(tx, e)` / `audit.tenant(tx, operatorId, e)` (actor = the admin, role `platform_admin`, IP, UA, request id). |
| `packages/core/src/admin/tenants.ts` | `listTenants` ({ q?, status?, page }) and `tenantDetail` ({ operatorId }): status, trial/paid/grace dates, active customers, linemen, last sign-in activity, owners' contact, counts, last 6 bill runs (counts), last books check (counts), failed jobs, offline payments, support grants, admin timeline. |
| `packages/core/src/admin/create-tenant.ts` | `createTenantByAdmin`: T-027 `provisionTenant` with `actor: platform_admin`, no password (the web sends T-026's invite-worded reset link), idempotent on the form's `operatorId`. |
| `packages/core/src/admin/subscription.ts` | `extendSubscription` ({ operatorId, lastDay (IST, inclusive), reason }) and `recordOfflinePayment` ({ operatorId, paymentId, amountPaise, method, reference?, receivedOn, months, note? }): both through T-085's `applySubscriptionChange({ kind: "manual_extend", until })` in the tenant's transaction; `addMonthsToDate`. |
| `packages/core/src/admin/support.ts` | `grantSupportAccess` ({ operatorId, reason, minutes ≤ 120 }), `endSupportAccess` ({ operatorId, grantId }), `supportView` ({ operatorId }). |
| `packages/core/src/admin/monitor.ts` | `listJobs` (status filter, keyset cursor), `retryJob` ({ jobId }), `listBillingRuns` ({ period?, status? }, failed items counted by reason), `listRazorpayEvents` (all / problems), `listPlatformAudit` (hides the console's own `*_viewed` events by default). |
| `packages/core/src/admin/metrics.ts` | `platformMetrics` ({ period? }): PRD §16 (table in the file header). |
| `apps/web/src/app/admin/**` | `/admin` (metrics), `/admin/tenants` (+ `?q=&status=&page=`), `/admin/tenants/new`, `/admin/tenants/[id]` (extend, offline payment, open/end support access), `/admin/tenants/[id]/support`, `/admin/jobs` (try again, bill runs of the month), `/admin/razorpay`, `/admin/audit`. `_lib/context.ts` `getAdminContext()` is the gate; Server Actions redirect back with `?done=` / `?error=` (no client JS needed) except the create form (`useActionState`). |
| `packages/i18n/messages/{en,hi}/admin.json` | All words; every Hindi string in `_review` (H-03). Glossary: "Admin console words". |

**Security model (reviewer please check)**

1. **Gate on every route, server-side.** Every admin `layout.tsx`, `page.tsx` and exported Server Action calls `getAdminContext()` first (a test scans the folder and fails if one doesn't): T-026 `requirePlatformAdmin()` (no session → /login, tenant user → /home, TOTP not enrolled → /login/2fa/setup; admin sessions ≤ 8 h) and then `resolveAdminContext` re-reads the user row (platform_admin, no tenant, active, `two_factor_enabled`, and the session says TOTP is on). Every admin service refuses a context not issued there. The proxy stays an optimistic cookie check.
2. **Default: no tenant data.** The console's own reads run on the platform path (`withPlatform` / `app_platform`). For tenant tables it needs aggregates from, the database itself limits the platform role to non-financial columns: a `USING (true)` SELECT policy **plus** a column grant (the migration revokes the table-wide SELECT the default privileges gave `app_platform`): `customers` (operator_id, status), `billing_runs` (status, counts, times; not `total_charges_paise`, `actor_id`), `billing_run_items` (operator_id, run_id, outcome, reason), `invariant_checks` (all but `samples`), `receipt_actions` (operator_id, action, at), `collection_sessions` (operator_id, status, business_date, discrepancy_reason). `SELECT *`, names, phones, amounts and notes fail with 42501 on that path whatever the code does; `platform-admin.test.ts` compares the catalog with `PLATFORM_READ_COLUMNS` exactly. Payments, invoices, ledger, balances and allocations have no platform access at all. Razorpay payloads and job payloads are never selected.
3. **Every cross-tenant read is on record.** Each admin service call (reads included) writes a platform audit event in the same `withPlatform` transaction as the read (`admin.tenants_listed`, `admin.tenant_viewed`, `admin.metrics_viewed`, `admin.jobs_viewed`, `admin.billing_runs_viewed`, `admin.razorpay_events_viewed`, `admin.audit_viewed`), enforced by `defineAdminService`.
4. **Support access** is the only way to a tenant's own records, and only a small read-only view (team and sign-in state, plans, areas, bill runs and failed items as customer code + reason, failed jobs, last books check; no payments, invoices, balances, customer names or phones). Opening it needs a reason (10–500 chars); the grant is written in the **tenant's** transaction with a `support.access_granted` tenant audit event (reason, minutes, expiry), so the Owner sees it in their audit log (T-035); `expires_at ≤ granted_at + 2 h` is a CHECK; the row is append-only except ending early (`ended_at`/`ended_by`), so the expiry can never move. **Expiry is enforced server-side on every request**: `supportView` looks up this admin's live grant (not ended, `expires_at > now`, runtime clock) inside the same tenant transaction it reads in, and writes `support.data_viewed` to the tenant log; otherwise FORBIDDEN `support_access_required`. Grants are per admin and per tenant; asking again while live returns the same grant.
5. **Money.** Offline fee payments are integer paise in an append-only table (UI takes whole rupees through `parseRupeesInput`), idempotent on a form-made id, written with the subscription change in one tenant transaction, audited in the tenant log (`subscription.offline_payment_recorded` + T-085's `subscription.state_changed` with the admin as actor) and the platform log (`admin.offline_payment_recorded`, with the reference). Extend: `subscription.state_changed` (source `admin_extend`) + `admin.subscription_extended` (with the reason).
6. **Isolation.** A tenant user can't get an AdminContext (tested for owner/staff/lineman, even with TOTP on); forged or `TenantContext` objects passed to admin services throw; Playwright checks every admin route for anonymous, owner and not-yet-enrolled admin.

**Decisions**

- Column grants instead of SECURITY DEFINER aggregate functions (none exist in the repo, and the audit test forbids them unless allow-listed) or a per-tenant `withTenant` fan-out (which would give the console full tenant access in code). The six policies are attached with Drizzle's `pgPolicy(...).link(table)` in `platform-admin.ts`, so the reviewed list lives in one file instead of six other modules.
- Grants and offline payments are tenant tables (they have `operator_id`, so the harness requires the tenant policy); the platform may only SELECT them. All writes happen in the tenant's transaction, then the platform audit event is written in a second transaction (Postgres can't switch role mid-transaction here); if that second write fails the call returns INTERNAL but the tenant record and the grant row (platform-readable) remain.
- Self-service support access: the admin opens it (with reason, time box, Owner-visible log); no Owner approval step (PLAN §9.4 doesn't ask for one). See open questions.
- Job "try again" enqueues a **new** job with the failed one's type, tenant, payload, dedupe key and try limit; the failed row is untouched (history). Refused when a live copy exists. Billing runs are retried this way (T-044's handler resumes from its cursor); failed bill **items** stay the Owner's call (T-044 `retryFailedItems`, Owner capability).
- Offline payment extends whole months from the later of: the current paid end, the trial end (when trialing), or the next IST midnight (rest of today free).
- "Last activity" = latest web session refresh of the tenant's users or lineman token refresh (sign-in activity; no tenant data read). Sessions deleted on sign-out don't count.
- PRD §16: payment sync success rate, duplicate prevention count and migration exception count have no data source yet and are shown as "Not measured yet" (follow-up **T-086a**, created in this PR).

**Deviations / files outside the owned paths**

- `packages/db/src/schema/platform-admin.ts` (+ test), migrations 0016/0017 + snapshots/journal, one export line in `packages/db/src/schema/index.ts`, `packages/db/README.md` (platform-access table + column-grant section).
- Done tasks' tests, smallest change: `customers.test.ts` (T-022) and `invariants.test.ts` (T-052) asserted the platform role sees zero rows; it now may read the granted columns, so they assert `SELECT *` is refused (42501) and (invariants) that status is readable but `samples` isn't. `invariants.ts` header comment updated.
- `packages/core/src/index.ts` (one export line), `packages/i18n/glossary.md`, generated `apps/web/messages/*.json`, `apps/web/e2e/admin.spec.ts`, removed `apps/web/src/app/admin/.gitkeep`, new follow-up `tasks/T-086a-*.md`.
- PLAN §12.4 "migration batch reports" not built: T-092 hasn't run (no data); left for T-092/T-086a.
- T-035 (audit viewer, done): its `actions.test.ts` requires words for every audit action written. Added registry entries in `packages/core/src/audit-query/actions.ts` and `sentence.*` / `action.*` in `packages/i18n/messages/{en,hi}/audit.json` (Hindi in `_review`) for the tenant-visible `support.access_granted`, `support.data_viewed`, `support.access_ended`, `subscription.offline_payment_recorded` (amount + months) and the platform-only `admin.*` events (never in a tenant's log). Platform admins show as "Cable Billing support" there.

**Open questions (product owner)**

- Should support access need the Owner's approval (a request the Owner accepts), or is "admin opens it, Owner sees it in the log" enough (current)? Should the Owner be able to end it from Settings?
- Should the support view show more (e.g. a customer's account for "this bill looks wrong")? Today it deliberately shows no customer names, money or payments.
- Correcting a mistyped offline payment: no reversal flow yet (append-only; a correction would be a negative record or a note). Also whether these payments need our GST tax invoice (H-10).
- Admin can't yet switch an operator off/on (PRD §3 "disable operator tenants"): needs an `operators` UPDATE path for the platform; not in this task's scope list.
- Known gap (T-026 area): a password-only session created **before** an admin enrolled TOTP in another browser becomes valid once enrolment completes elsewhere (Better Auth doesn't record per session whether TOTP was checked). Narrow (needs the password before enrolment); fix would be revoking all other sessions on enrolment.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 58bb696, after T-035)

- `@cb/db`: `platform-admin.test.ts` (8): tenant scoping and platform read-only for both tables; 2-hour CHECK, reason length, ended fields; append-only (ending early only; delete/truncate refused for every role); offline payment CHECKs and append-only; catalog grants == `PLATFORM_READ_COLUMNS` exactly (no table-wide SELECT, app_rw unaffected); platform can count customers but `SELECT *`, `name`, `phone` → 42501; migrations contain the exact SQL.
- `@cb/core`: `admin/support.test.ts` (10, injected clock): no grant → refused and nothing written; **grant → use at +119 min → refused at exactly +120, +121 min and +1 day**; the tenant's own log (read with `withTenant`, RLS) has `support.access_granted` + `support.data_viewed` by the admin with the reason, tenant B's has nothing, platform log has both; one admin + one tenant only; re-open returns the same grant, expiry unchanged; end early → refused, second end → CONFLICT; validation (reason, > 120 min); unknown tenant NOT_FOUND; AdminContext gate (owner/staff/lineman, owner with TOTP, admin without TOTP in row or session, disabled, unknown; forged and TenantContext objects throw). `admin/admin.test.ts` (7): every read service writes its platform audit event, outputs contain **none** of a seeded customer name/phone, `total_charges_paise`, invariant sample amount or Razorpay payload email; counts and rates right; extend (trial → active, state_changed by platform_admin with source); offline payment (paid-until from next IST midnight / trial end, idempotent, one row, tenant + platform audit, validation); job retry (new queued copy, original failed, already_queued / not_failed / NOT_FOUND); create tenant (idempotent, `tenant.provisioned` by the admin, trialing). Mutation check: removing the `expires_at > now` condition fails 3 support tests.
- `@cb/web`: `admin-gate.test.ts` (static scan of 9 routes + all actions; `getAdminContext` with T-026's real `requirePlatformAdmin` over faked sessions), `create-form.test.tsx` (labels, error words, values kept, Hindi).
- Playwright (`next start`, freshly migrated scratch DB, pre-installed Chromium, `E2E_PORT=3286`): `admin.spec.ts` 4/4 (anonymous / owner / not-enrolled admin on every route; enrol with a real TOTP; full flow incl. support access shown in the tenant's audit rows, job retry, Razorpay and admin logs, add operator, Hindi). Full suite after the final rebase (on T-035): **99 passed**, 0 flaky (an earlier run had one unrelated flaky `plans.spec.ts` test that passed on retry).
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10), `pnpm build` (10/10), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `pnpm --filter @cb/db db:check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-14T08:08:26.672Z claimed by agent-t086
- 2026-10-14T11:55:19.294Z completed on task/T-086-platform-admin-console

---
id: T-027
title: Self sign-up and tenant provisioning
phase: 1
area: web
status: done
owner: agent-t027
claimed_at: 2026-10-13T14:30:29.073Z
branch: task/T-027-self-sign-up-and-tenant-provisioning
depends_on: [T-026, T-007]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(auth)/signup/**, apps/web/src/app/(auth)/verify/**, packages/core/src/tenants/**, packages/i18n/messages/*/signup.json]
---

# T-027 — Self sign-up and tenant provisioning

**Phase** 1 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-026, T-007

## Goal

An operator can create their own account and start a 30-day trial.

## Scope

- Sign-up form: business name, owner name, mobile, email, password; Turnstile; rate limit.
- Email verification; on verify, transaction creates operator + owner user + `subscriptions` (trialing, trial_ends_at = +30 days) + counters + default settings.
- `provisionTenant()` service is reusable by the admin console and migration (no email step there).

## Acceptance criteria

- [x] Unverified accounts cannot sign in.
- [x] Provisioning is idempotent on retry.

## Tests required

- Integration test of provisioning; Playwright sign-up → verify (email captured via test transport) → home.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(auth)/signup/**`
- `apps/web/src/app/(auth)/verify/**`
- `packages/core/src/tenants/**`
- `packages/i18n/messages/*/signup.json`

## References

D-15, D-20, PLAN §12.3 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/tenants/provision.ts` | `provisionTenant(runtime, input)`: the reusable tenant creator (self sign-up, admin console, migration). |
| `packages/core/src/tenants/signup.ts` | `createSignupService({ runtime, baseURL, rateLimiter, botCheck, sendEmail, newToken? })` → `{ start, pending, complete }`; `validateSignupFields`, `signupIdentifier`, `SIGNUP_RATE_LIMITS`, `SIGNUP_LINK_TTL_SECONDS` (24 h), `SIGNUP_FIELD_LIMITS`. |
| `packages/core/src/tenants/bot-check.ts` | `BotCheck` interface, `createTurnstileVerifier({ secret, fetch?, timeoutMs?, endpoint? })` (siteverify form post, no SDK), `disabledBotCheck()` (local/CI/tests), `TURNSTILE_RESPONSE_FIELD`. |
| `packages/core/src/tenants/rules.ts` | `TRIAL_DAYS` (30), `trialEndsAt(now, days?)`, `trialLastDay(now, days?)`, `normalizeIndianMobile`, `ownerLoginCandidates`. Pure. |
| `apps/web/src/app/(auth)/signup/**` | `/signup` page, `signUpAction`, `SignupForm` (5 fields + Show/Hide, field notes in words, "check your email" screen), `TurnstileWidget` (explicit render, fresh token after every answer; only when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set). |
| `apps/web/src/app/(auth)/verify/[token]/**` | `/verify/<token>` page (noindex, `referrer: no-referrer`), `verifySignupAction`, `VerifyForm`. |
| `apps/web/src/lib/auth/signup-email.ts` | `renderSignupEmail` (en/hi plain text: the confirm link, or "you already have an account"). |
| `packages/i18n/messages/{en,hi}/signup.json` | All words; every Hindi string is in `_review` (H-03). Glossary: new "Sign-up words (web)" table. |

**`provisionTenant` API (T-086 admin console, T-092 migration)**

```ts
provisionTenant(runtime: Pick<ServiceRuntime, "db" | "logger" | "now">, {
  operatorId,                      // UUID: the new tenant id AND the idempotency key
  business: { name, phone?, address?, settings?, legacySource?, legacyId? },
  owner: { name, email: string | null, emailVerified?, phone: string | null, login?, language: "hi" | "en",
           passwordHash: string | null /* hashPassword() output, argon2id only */, legacySource?, legacyId? },
  trialDays?,                      // default 30 (D-20)
  actor: { kind: "self_signup" } | { kind: "platform_admin", userId } | { kind: "system", job: "legacy_migration" },
  request?: { requestId?, ip?, userAgent? },
}) → Result<{ status: "created" | "already_provisioned", operatorId, ownerUserId, ownerLogin, trialEndsAt },
            VALIDATION (details.fields) | CONFLICT (details.reason: email_taken | login_taken | operator_id_in_use)>
```

- One `withTenant(operatorId)` transaction (T-021 decision 3): `operators` (active; settings = defaults + `office_phone` = the owner's mobile), owner `users` (+ `accounts` credential row when `passwordHash` is given), `subscriptions` (`trialing`, `trial_ends_at`), `counters` (invoice, receipt, customer_code at 1), and one `tenant.provisioned` audit event in the new tenant's log (`after`: source, owner_user_id, subscription_status, trial_ends_at; no names, phones or emails). Database outages and bugs throw; nothing is half-written.
- **Idempotency (why the operator id, not a natural key):** the caller generates `operatorId` once (`uuidv7()`) and keeps it with the request: sign-up keeps it in the pending sign-up, the admin console should put it in the form (hidden field), the migration should store it in its legacy-id mapping. `INSERT … ON CONFLICT (id) DO NOTHING` on `operators` makes a retry, or a concurrent second call (it waits on the first one's row lock), return `already_provisioned` with the same owner, writing nothing. Business names aren't unique (FR-002) and one person can run two businesses, so neither the name nor the mobile can be the key; the email is unique but migrated owners may have none. If the id belongs to a tenant whose owner differs (email, or the mobile when there is no email), the result is CONFLICT `operator_id_in_use` and nothing about that tenant is revealed.
- **Owner login:** `owner.login` if given (taken → `login_taken`), else the 10-digit mobile, then `<mobile>-2` … `-10` if another account already uses it as its user name (each try in a savepoint). The owner can always sign in with the email too.
- **Admin console / migration:** pass `actor` accordingly; no email step. `emailVerified` defaults to false; sign-in does not require it (only self sign-up waits for the email). `passwordHash: null` creates no credential row: the owner sets a password with the reset link (Better Auth creates the credential account on reset).

**Trial end rule (IST/UTC):** the trial covers the rest of the IST sign-up day plus 30 whole IST days: `trial_ends_at` = **00:00 IST on (IST sign-up date + 31)**, stored as UTC (18:30 UTC the day before). Signing up any time on 13 Oct 2026 IST → free through 12 Nov → `2026-11-12T18:30:00Z`. Never shorter than 30 × 24 h, always a whole IST day ("free till 12 Nov"), and T-085's daily job gets the same answer whatever time it runs. Clock: `runtime.now()` (injected).

**Sign-up flow (security decisions, reviewer please check)**

1. **No `users` row before the email is confirmed.** `start` stores a *pending sign-up* in Better Auth's `verifications` table (platform-only RLS): `identifier = "signup:" + sha256(token)` (the token itself is never stored), `value` = JSON with the pre-generated operator id, the form fields and the **argon2id hash** (never the password), 24 h expiry. Expired pending sign-ups are deleted on every `start`. Hence "unverified accounts cannot sign in": there is nothing to sign in to (tested in core and e2e).
2. **No account enumeration:** an email that already has an account gets a "you already have an account" email (sign-in and reset links) instead of a link; the page says "check your email" either way, and both paths hash the password first (same timing class). Logs record only the email `kind`.
3. **The confirm page asks for the password again.** Opening `/verify/<token>` changes nothing (mail scanners open links); "Start" checks the password against the pending hash, then provisions with the pending sign-up's operator id (idempotent: two tabs → one tenant), deletes the pending sign-up, and signs the owner in through T-026's `signIn` (session gate, cookie, audit) → `/home`. Asking for the password means someone who typed another person's email can't get that person to activate an account the typist controls, and lets us sign in without any session-minting backdoor.
4. **Turnstile:** server-side `siteverify` with the client IP; **fails closed** (Cloudflare down → "we could not check that you are a person, try again"). Off when `TURNSTILE_SECRET_KEY` is unset (local, CI; logged `signup.bot_check_off` off-local); production requires the keys (T-011 rules).
5. **Rate limits** (T-026's limiter, fails open like sign-in): start 20/h per IP and 3/h per email; confirm 30/15 min per IP and 10/15 min per link (stops password guessing on a stolen link; even the right password then waits).
6. Field rules: business and owner name 1–120 chars (spaces collapsed), Indian mobile (10 digits starting 6–9; `+91`, `91`, `0`, spaces and dashes accepted), email ≤ 254, password 8–128 (T-026's limits). Errors name the field and the problem, never the value.

**Deviations / shared files (all small)**

- `apps/web/src/lib/auth/server.ts` (T-026, done): one rate limiter shared by auth and sign-up, `getSignupService()`, `botCheckFor` (Turnstile when the secret is set), and the capture transport also writes each email as a JSON file into `EMAIL_OUTBOX_DIR` (local only). New `apps/web/src/lib/auth/signup-email.ts` (+ test) next to T-026's `reset-email.ts`.
- **New env var `EMAIL_OUTBOX_DIR`** (T-011's env module, done): local/CI e2e only, refused by `deploymentEnvProblems` on every Vercel deployment (tested); added to `.env.example` (commented out), `apps/web/turbo.json` and the runbook table. `apps/web/playwright.config.ts` sets it to `<tmpdir>/cb-e2e-outbox-<port>` for the server and the tests, so **CI needs no workflow change**. This is how the e2e reads the emailed link ("email captured via test transport").
- `apps/web/src/lib/security-headers.ts` (+ test): `https://challenges.cloudflare.com` in `script-src` and a new `frame-src` (Turnstile's script and challenge iframe; the CSP is still report-only).
- `packages/core/src/index.ts`: `export * from "./tenants";`. `packages/i18n/glossary.md`: sign-up words. Generated `apps/web/messages/*.json`.
- Reuses T-026's `(auth)/login/_components` (AuthShell, TextField, PasswordField, SubmitButton, Message, `field`) without changing them.
- `provisionTenant` is a plain function, not a `defineService` (there is no TenantContext before the tenant exists), so the isolation harness doesn't apply; its isolation behaviour has its own tests (another tenant's id → CONFLICT, nothing changed or revealed; new tenants invisible to other tenants).

**Open questions (product owner)**

- Confirming asks for the password again (decision 3). Alternative: one click signs in, which is easier for low-literacy owners but needs a server-side session-minting path and lets anyone with the link in. Usability round H-04 should look at this step.
- The operator's `default_language` stays `hi` (T-021 default) even when the owner signed up in English; the owner's own `users.language` follows the form. Should the operator default follow the owner?
- `office_phone` defaults to the owner's mobile (shown to linemen as "Call office"). OK, or leave it empty until Settings (T-030)?
- No link to `/signup` from `/login` yet (T-026's page and namespace); T-087's marketing pages and/or a small follow-up can add "New here? Create account".
- Turnstile fails closed (no sign-ups during a Cloudflare outage) while the rate limiter fails open: confirm.
- Two businesses may share an owner mobile (allowed; the second owner gets `<mobile>-2` as user name).

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 3a39262, incl. T-050)

- `pnpm --filter @cb/core test`: 489 tests pass (450 before the rebase onto T-050). New: `tenants/units.test.ts` (13: trial rule incl. IST midnight edges, leap year, ≥ 30 × 24 h over two days of start times; mobile normalisation; login candidates; field validation; link identifier hashing; Turnstile request shape, refusal and outage), `tenants/provision.test.ts` (11, real DB: every row and the audit event; the owner signs in by mobile and by email and gets a TenantContext; **retry → `already_provisioned`, database fingerprint unchanged**; **6 concurrent calls → exactly one tenant**; taken email → nothing written, same id retried OK; `<mobile>-2` fallback; validation; **another tenant's id → CONFLICT without change or leak**; new tenant invisible to others; admin and migration actors, no password, trial length, migration retry without email), `tenants/signup.test.ts` (12, real DB: the pending sign-up stores no password or token; **no sign-in before confirming (email and mobile)**; wrong password changes nothing; confirm → tenant + sign-in + link used up; **4 concurrent confirms → one tenant**; existing email → "already registered" email and no pending row; two pending sign-ups → ACCOUNT_EXISTS; 24 h expiry + cleanup; made-up links; Turnstile no/outage; rate limits per email, per IP and per link; email failure; no PII in logs).
- Mutation checks (reverted): removing `ON CONFLICT DO NOTHING` → 5 tests fail (retry, concurrency, foreign id, migration retry, double confirm); skipping the password check on confirm → 2 tests fail.
- `pnpm --filter web test`: 106 tests pass (new: sign-up form fields, Hindi, field errors in words, the sent screen, state mapping; verify form; sign-up emails en/hi; `EMAIL_OUTBOX_DIR` refused on Vercel; Turnstile CSP).
- `pnpm --filter web test:e2e` (`E2E_PORT=3227`, a freshly migrated scratch database, pre-installed Chromium): 23 passed (incl. T-050's), 2 new: **sign-up → field error in words → "check your email" → sign-in refused before confirming → link read from the outbox → wrong password → right password → `/home` with an HttpOnly session cookie → `/login` redirects home → link used up → DB: owner active, email confirmed, mobile as login, `trialing` for 30–31 days**; and the page in Hindi with a sign-in link.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9, with `DATABASE_URL`), `pnpm build` (9/9), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T14:30:29.075Z claimed by agent-t027
- 2026-10-13T14:54:18.381Z completed on task/T-027-self-sign-up-and-tenant-provisioning

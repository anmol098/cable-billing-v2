---
id: T-026
title: Web authentication core (Better Auth)
phase: 1
area: core
status: done
owner: agent-t026
claimed_at: 2026-10-13T12:52:58.900Z
branch: task/T-026-web-authentication-core-better-auth
depends_on: [T-005, T-021, T-025]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/auth/**, apps/web/src/app/(auth)/login/**, apps/web/src/app/(auth)/reset/**, apps/web/src/app/api/auth/**, apps/web/src/middleware.ts, packages/i18n/messages/*/auth.json]
---

# T-026 — Web authentication core (Better Auth)

**Phase** 1 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-005, T-021, T-025

## Goal

Secure login for owners, staff and platform admins.

## Scope

- Better Auth with Drizzle adapter, username plugin (login = email or username), argon2id hashing.
- Login page (big fields, show-password toggle, bilingual), logout, password reset via email (Resend) for owner/staff; owner-initiated reset for linemen happens in T-032.
- Session cookie (httpOnly, secure, 30-day sliding), revocation; middleware protecting `(operator)` and `admin` groups and routing by role.
- Platform admin: TOTP 2FA enrolment + required on login; 8-hour session.
- Rate limits (Upstash; in-memory fallback in dev) on login and reset.
- Helper `getTenantContext()` for Server Components/Actions.

## Out of scope

- Self sign-up (T-027).
- Mobile tokens (T-028).

## Acceptance criteria

- [x] Wrong password ×N triggers rate limit.
- [x] Lineman credentials cannot sign in to the web.

## Tests required

- Integration tests for login, reset token single-use, role routing; Playwright login smoke.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/auth/**`
- `apps/web/src/app/(auth)/login/**`
- `apps/web/src/app/(auth)/reset/**`
- `apps/web/src/app/api/auth/**`
- `apps/web/src/middleware.ts`
- `packages/i18n/messages/*/auth.json`

## References

PLAN §9.2, FR-028, E-04, E-07 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/auth/auth.ts` | `createAuthService(options)` → `AuthService`: Better Auth 1.7.7 configured for us, plus the methods the web calls (below). |
| `packages/core/src/auth/adapter.ts` | `platformAuthAdapter(db)`: Better Auth's Drizzle adapter (T-021 `authSchema`) where **every call runs in its own `db.withPlatform` transaction** and `adapter.transaction(cb)` runs `cb` in one `withPlatform` transaction (createDb has no raw handle). Better Auth's own schema check stays attached. |
| `packages/core/src/auth/password.ts` | `hashPassword` / `verifyPassword` (argon2id, `@node-rs/argon2` 2.2.2, m=19456 KiB t=2 p=1), `PASSWORD_MIN_LENGTH` 8 / `PASSWORD_MAX_LENGTH` 128. Non-argon2 (legacy) hashes never verify (FR-028) and cost the same time. Why `@node-rs/argon2`: maintained N-API binding of the Rust `argon2` crate, prebuilt binaries as optional platform packages (no install script, no node-gyp), runs on libuv's thread pool, and is in Next.js's default `serverExternalPackages` (loaded from node_modules on Vercel's Node runtime). |
| `packages/core/src/auth/rate-limit.ts` | `RateLimiter` (`hit(key, rule)`), `createMemoryRateLimiter`, `createUpstashRateLimiter` (REST `EVAL` of an atomic INCR+PEXPIRE script, no SDK), `AUTH_RATE_LIMITS`, `rateLimitKey` (hashes the identifying part). |
| `packages/core/src/auth/email.ts` | `EmailTransport`, `createResendTransport` (REST, no SDK), `createCaptureTransport` (tests, local dev). |
| `packages/core/src/auth/policy.ts` | `webSignInBlock`, `WEB_SIGN_IN_ROLES`, `SESSION_POLICY`, `ROLE_HOME` (`owner`/`staff` → `/home`, `platform_admin` → `/admin`), `postSignInPath`, `safeNextPath`, `LOGIN_PATH`, `TWO_FACTOR_*_PATH`. |
| `packages/core/src/auth/audit-events.ts`, `request-info.ts` | `recordAuthEvent` (writeAuditEvent; tenant log for owners/staff, platform event for admins), `clientIp`, `clientInfo`, `requestIdFromHeaders` (`x-vercel-id` only). |
| `apps/web/src/lib/auth/server.ts` | Lazy singletons `getServerRuntime()` (T-025 `ServiceRuntime`; also starts `startRuntimeRoleCheck` → Sentry, as T-025/T-020a asked) and `getAuthService()`. Upstash when `UPSTASH_*` is set (else memory, logged off-local); Resend when `RESEND_API_KEY`+`EMAIL_FROM` are set (else captured; `next dev` prints the email). `nextCookies()` is the last plugin; reset emails are sent after the response (Next's `after`). |
| `apps/web/src/lib/auth/session.ts` | `getTenantContext()`, `requirePlatformAdmin()`, `getWebSession()`, `loginRedirectPath()` (all `react` `cache`d per request). |
| `apps/web/src/lib/auth/actions.ts` | `signOutAction`, `signOutEverywhereAction` (Server Actions → `/login?notice=signed_out`). |
| `apps/web/src/proxy.ts` + `src/lib/auth/paths.ts` | Optimistic cookie check for `/admin`, `/home`, `/customers`, `/payments`, `/linemen`, `/bills`, `/reports`, `/settings` → `/login?next=…`; passes the path on in `x-cb-pathname`. |
| `apps/web/src/app/(auth)/login/**` | `/login`, `/login/2fa` (TOTP step), `/login/2fa/setup` (admin enrolment), Server Actions, shared `_components` (AuthShell, TextField, PasswordField with Show/Hide, SubmitButton, Message). |
| `apps/web/src/app/(auth)/reset/**` | `/reset` (ask for a link), `/reset/[token]` (new password twice; `referrer: no-referrer`, `noindex`). |
| `packages/i18n/messages/{en,hi}/auth.json` | All words (Hindi drafts in `_review`); the glossary gained a "Sign-in words (web)" table. |

**AuthService API** (all take the request `Headers`; results are `Result<T, AuthFailure>` with codes `INVALID_CREDENTIALS | RATE_LIMITED (retryAfterSeconds) | ROLE_NOT_ALLOWED | ACCOUNT_DISABLED | INVALID_CODE | TWO_FACTOR_EXPIRED | INVALID_TOKEN | INVALID_PASSWORD | UNAUTHENTICATED`; outages throw):
`signIn({ login, password })` (a login with `@` is an email, else a user name) → `signed_in { userId, role, twoFactorEnrolmentRequired }` or `two_factor_required` · `verifyTwoFactor({ code })` · `startTwoFactorEnrolment({ password })` → `{ totpUri, secret, backupCodes }` · `confirmTwoFactorEnrolment({ code })` · `getSession(headers)` → `WebSession | null` (`sessionId, userId, role, operatorId, language, twoFactorEnabled, twoFactorEnrolmentRequired, createdAt, expiresAt`; sessions that no longer pass the policy are deleted) · `signOut` · `signOutEverywhere` → `{ sessions }` · `requestPasswordReset({ email })` · `resetPassword({ token, newPassword })` · `tenantContext(runtime, headers)` → T-025 `resolveTenantContext(…, { channel: "web", requestId: x-vercel-id, client: { ip, userAgent } })` · `auth` (the Better Auth instance; never mount `auth.handler`).

**How later tasks use it**

- **T-029 (shell):** `(operator)/layout.tsx` must `await getTenantContext()` (the real gate; the proxy is optimistic). Every operator Server Action calls `getTenantContext()` too and passes `getServerRuntime()` + the context to `service.call`. Account menu: `<form action={signOutAction}>` / `signOutEverywhereAction`. A new top-level operator section must be added to `PROTECTED_PREFIXES` **and** to the literal `config.matcher` in `src/proxy.ts` (a test checks they match).
- **T-086 (admin):** `admin/layout.tsx` must call `requirePlatformAdmin()` (redirects to `/login`, or to TOTP enrolment until 2FA is on).
- **T-027 (sign-up):** Better Auth sign-up is disabled (`disableSignUp`); provision users in your own `withTenant` transaction and store `hashPassword(password)` in `accounts` (`provider_id = 'credential'`, `account_id = user id`). Set `users.login` (best without `@`: a login with `@` is treated as an email on the form) and `users.email` (lower case). In T-027's design unverified sign-ups have no `users` row yet, so "unverified accounts cannot sign in" holds; if the row is created before verification, add an `emailVerified` check to `webSignInBlock`.
- **T-028 (mobile):** reuse `hashPassword`/`verifyPassword`, the rate limiters + `rateLimitKey`, `clientIp`, `recordAuthEvent`. Better Auth sessions are web-only; linemen never get one.
- **T-032 (team):** passwords via `hashPassword`; "sign a staff member out" = delete their `sessions` rows (tenant RLS allows it); disabling a user is enough to end their web sessions (`getSession` re-checks status on every request and deletes the session).

**Security decisions (reviewer please check)**

1. **No Better Auth HTTP endpoints.** `/api/auth/[...all]` is deliberately not mounted: every flow is a Server Action calling `auth.api.*` in-process (Next.js checks every Server Action's Origin = CSRF protection; Better Auth's own origin/CSRF middlewares only run for HTTP requests). Nothing like `/sign-up/email`, `/update-user` or 2FA trust-device is reachable from outside. If a later task needs HTTP, mount only an allowlist.
2. **One gate for every session:** `databaseHooks.session.create.before` re-reads the user (role, status, operator status) and refuses linemen (`ROLE_NOT_ALLOWED`), disabled users and suspended operators (`ACCOUNT_DISABLED`). It covers password sign-in, the 2FA step and session re-issue. `getSession` re-checks on every request and deletes sessions that no longer pass.
3. **No enumeration:** unknown login and wrong password return the same `INVALID_CREDENTIALS`, and Better Auth hashes the password for unknown users (same argon2 cost). `ROLE_NOT_ALLOWED`/`ACCOUNT_DISABLED` are shown only after the password was proven right. Password reset answers the same for every address (it emails only active owners/staff; others silently get nothing); sending runs after the response and email errors are logged, never surfaced. Known gap: a user name whose user has no credential account at all answers without hashing (Better Auth's username plugin); every seeded/provisioned user has one.
4. **Rate limits** in a Better Auth `before` hook (so they cover `auth.api` calls): sign-in 10 attempts / 15 min per **account** (user name and email of one user share the counter; unknown logins are keyed by the typed value) and 100 / 15 min per IP (generous: carrier-grade NAT); reset requests 3 / h per address and 20 / h per IP; setting a password 20 / h per IP; 2FA 30 / 15 min per IP (plus Better Auth's 5 tries per challenge and its 10-failure account lockout). Every attempt counts, atomically. The limiter **fails open** (logged `auth.rate_limit_unavailable`, error level) so an Upstash outage can't lock everyone out. Production requires Upstash (T-011's env rules).
5. **Cookies:** `cb.session_token` / `cb.two_factor` (`__Secure-` prefix and `Secure` whenever the base URL is https, i.e. always in production), `HttpOnly`, `SameSite=Lax`, `Path=/`, Max-Age 30 days. Owners/staff: 30 days sliding, refreshed at most daily (during RSC renders `nextCookies` skips the refresh; Server Actions refresh DB and cookie). Platform admins: 8 hours from sign-in, absolute: capped on create, capped again whenever Better Auth slides a session (`session.update.before`), and enforced by `getSession` (deletes the session).
6. **Platform admin 2FA:** TOTP enrolment is required before anything else (`requirePlatformAdmin` → `/login/2fa/setup`; enrolment re-asks the password); afterwards every sign-in needs the code (`/login/2fa`). Trust-device is never offered.
7. **Tokens at rest:** reset and 2FA verification identifiers are stored **hashed** (`verification.storeIdentifier: "hashed"`); reset tokens are single use (atomic consume), expire after 1 h, and a successful reset deletes all the user's sessions. Session tokens stay as Better Auth stores them (T-021 decision 2).
8. **Audit (no PII):** `auth.signed_in` (`{ method: password | password_totp }`), `auth.sign_in_blocked` (`{ reason }`), `auth.signed_out`, `auth.signed_out_everywhere` (`{ sessions }`), `auth.password_reset_requested`, `auth.password_reset_completed`, `auth.two_factor_enabled`, with actor/role, IP, user agent and request id columns. Tenant users' events go into their tenant's log (the owner sees them in T-035); admin events are platform events. An audit failure never fails the request (logged). Logs carry ids and codes only (strict logger in tests).
9. **The proxy is optimistic** (cookie presence only, as Next.js advises); the server-side helpers are the boundary.

**Deviations / shared files**

- `apps/web/src/proxy.ts` instead of the listed `middleware.ts` (Next 16 rename, as T-005 noted).
- `apps/web/src/app/api/auth/**` deliberately unused (decision 1).
- New folder `apps/web/src/lib/auth/**` (server singletons, guards, sign-out actions, reset email, proxy constants): the guards must be importable from other tasks' layouts and actions, no owned path fits, and no other task owns this folder.
- Shared files: `packages/core/package.json` (`better-auth` 1.7.7 — the version T-021 tested and still the latest — and `@node-rs/argon2` 2.2.2), `packages/core/src/index.ts` (one `export * from "./auth"`; Biome sorts it into place), `apps/web/package.json` (`@cb/core`, `@cb/db`, `@cb/domain`, `better-auth` 1.7.7), `apps/web/next.config.ts` (`transpilePackages` + `@cb/core`, `@cb/db`, `@cb/domain`), `pnpm-lock.yaml`, `packages/i18n/glossary.md` (web sign-in words), generated `apps/web/messages/*`, removed `(auth)/.gitkeep`.
- **CI (T-010's `.github/workflows/web.yml`, done):** the `Web e2e` job now has a Postgres 17 service, `DATABASE_URL`/`BETTER_AUTH_SECRET` (CI-only throwaway values) and a `db:migrate` step before the build, so the sign-in smoke runs against a real database. `/api/health` still reports `not_configured` (its ping isn't wired), so the existing smoke test is unchanged.
- No new environment variables.

**Open questions (product owner)**

- Should owners/staff get optional TOTP too? (The service supports it; the UI only routes admins.)
- Platform admin bootstrap: the first admin's user + password are created out of band (no UI), and whoever first signs in with that password enrols TOTP. Alternative: pre-enrol in a CLI script. Admin password reset by email is not offered (another admin or the database).
- The rate-limit numbers (decision 4) and failing open when the limiter is down.
- Staff without an email can't reset by email; the owner would reset them (T-032 could cover staff as well as linemen).
- Data retention for `sessions`/`verifications` (Q-06): no cleanup job yet.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 28a65fa)

- `pnpm --filter @cb/core test`: 14 files / 307 tests. New `auth/auth.test.ts` (17, real DB): owner by login (any case) and by email; cookie flags (HttpOnly, SameSite=Lax, Max-Age 30 d, not Secure on http; `__Secure-` + Secure on https); TenantContext on `web` for owner and staff; one answer for wrong password / unknown login / unknown email; **lineman with the right password → ROLE_NOT_ALLOWED, no session, audit `sign_in_blocked`**; disabled user and suspended operator → ACCOUNT_DISABLED; **wrong password ×10 (alternating login and email) → the 11th try, even with the right password and from another IP, is RATE_LIMITED**; IP flood → RATE_LIMITED; sliding refresh; session dropped when the user is disabled or becomes a lineman; sign out and sign out everywhere (3 browsers); platform admin enrolment → 2FA step (wrong code) → 8-hour cap (clock moved) and platform audit events; reset: no email for unknown/lineman/admin addresses, token stored hashed, short password refused, **single use**, all sessions ended, old password dead and new one works, expired and made-up tokens refused, per-address reset limit; audit rows and logs contain no login, email or password; tenant audit visible only to its tenant. `auth/units.test.ts` (13): argon2id format/params/salt, legacy hashes, memory limiter windows, Upstash request shape and errors, Resend request shape, policy matrix, safe redirects, IP/request-id parsing.
- Mutation checks (reverted): letting linemen through `webSignInBlock` → the lineman test fails; removing the rate-limit hook → 3 tests fail; storing verification identifiers in plain → the reset test fails; removing the 8-hour check in `getSession` → the admin test fails.
- `pnpm --filter web test`: 10 files / 69 tests (proxy redirect/pass-through, matcher = `PROTECTED_PREFIXES`, cookie names = core prefix, no `middleware.ts`; LoginForm labels, Show/Hide, Hindi, error mapping; reset email in en/hi).
- `pnpm --filter web test:e2e` (`E2E_PORT=3226`, a freshly migrated local database, pre-installed Chromium): 15 passed, 6 of them new: protected page → `/login?next=…`, noindex, Show/Hide, Hindi; owner sign-in → back to the asked page, cookie HttpOnly/Lax/30 d, `/login` → `/home`; wrong password and unknown login give one message, lineman → "phone app" message and no cookie; ×10 wrong → "Too many tries" even for the right password; reset request gives one answer for any address, the link sets the password once (second use refused, `referrer: no-referrer`); platform admin enrolment with a real TOTP code, then the 2FA step.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9), `pnpm build` (9/9; `next build` with no env succeeds), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T12:52:58.900Z claimed by agent-t026
- 2026-10-13T13:32:38.572Z completed on task/T-026-web-authentication-core-better-auth

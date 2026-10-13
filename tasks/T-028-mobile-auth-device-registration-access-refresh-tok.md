---
id: T-028
title: Mobile auth: device registration, access/refresh tokens, app config
phase: 1
area: api
status: done
owner: agent-t028
claimed_at: 2026-10-13T14:08:16.104Z
branch: task/T-028-mobile-auth-device-registration-access-r
depends_on: [T-026, T-051]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/mobile-auth/**, apps/web/src/app/api/mobile/v1/auth/**, apps/web/src/app/api/mobile/v1/app/**, apps/web/src/lib/mobile/**]
---

# T-028 — Mobile auth: device registration, access/refresh tokens, app config

**Phase** 1 · **Area** api · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-026, T-051

## Goal

Linemen sign in once per phone and stay signed in.

## Scope

- `POST /auth/login` (lineman role only) → registers/updates `devices` (install_id, model, app_version), assigns device_code, returns 15-min access token + 180-day sliding refresh token (hashed at rest, rotated on use, reuse detection revokes the family).
- `POST /auth/refresh`, `POST /auth/logout`; `GET /app/config` (min_app_version, operator name, office phone, tenant mode).
- `withMobileAuth(handler)` wrapper producing a TenantContext with deviceId; `APP_TOO_OLD` check on every request.
- Revoke-device service used by T-032.

## Acceptance criteria

- [x] Revoked device gets 401 on refresh; access token expires in 15 min.
- [x] Owner/staff credentials are rejected on mobile login.

## Tests required

- Integration tests: rotation, reuse detection, revocation, version gate.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/mobile-auth/**`
- `apps/web/src/app/api/mobile/v1/auth/**`
- `apps/web/src/app/api/mobile/v1/app/**`
- `apps/web/src/lib/mobile/**`

## References

PLAN §9.2, PLAN §10.2, PLAN §11.6, PLAN §11.9, D-07 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/mobile-auth/mobile-auth.ts` | `createMobileAuthService({ runtime, secret, rateLimiter, minAppVersionCode?, features? })` → `MobileAuthService { login, refresh, logout, authenticate, appConfig, minAppVersionCode }`. camelCase results, `Result<T, MobileAuthFailure>` (`code` = a contract error code, `reason` for logs/tests, `retryAfterSeconds`, `minAppVersionCode`, `fields`). `MOBILE_AUTH_RATE_LIMITS`. |
| `packages/core/src/mobile-auth/tokens.ts` | Access-token signer (`cbm1.<payload>.<HMAC-SHA256>`), `newRefreshToken`, `hashRefreshToken`, `ACCESS_TOKEN_TTL_SECONDS` (900), `REFRESH_TOKEN_TTL_SECONDS` (180 d), `REFRESH_REUSE_GRACE_SECONDS` (300). |
| `packages/core/src/mobile-auth/revoke.ts` | Service `revokeDevice` (`devices.revoke`, capability `team.manage`) and helper `revokeMobileRefreshTokens(tx, { familyId? deviceId? userId?, reason, now })`. |
| `packages/core/src/mobile-auth/version-gate.ts`, `device-code.ts` | `APP_VERSION_CODE_HEADER`, `parseAppVersionCode`, `checkAppVersion`, `DEFAULT_MIN_APP_VERSION_CODE`; device-code alphabet and picker. |
| `packages/core/src/mobile-auth/mobile-auth.isolation.ts` | Isolation case: an owner revoking another tenant's phone → NOT_FOUND, no DB change. |
| `apps/web/src/lib/mobile/http.ts` | `mobileRoute(endpoint, getDeps, handler)`, **`withMobileAuth(endpoint, getDeps, handler)`**, `readJsonBody`, `errorResponse`, `fieldProblems`, types `MobileDeps`, `MobileScope`, `AuthenticatedScope`, `Reply`. |
| `apps/web/src/lib/mobile/{handlers,wire,server,config}.ts` | The four handlers, core → wire mappers, `getMobileDeps()` (lazy singleton over T-026's runtime and rate limiter), `MIN_APP_VERSION_CODE` (= 1) and `MOBILE_FEATURES` (none). |
| `apps/web/src/app/api/mobile/v1/auth/{login,refresh,logout}/route.ts`, `…/app/config/route.ts` | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /app/config` (Node runtime, dynamic). |

**How later tasks use it**

- **T-060 / T-061 (bearer endpoints):** one line per route:
  ```ts
  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";
  export const GET = withMobileAuth(ENDPOINTS.syncCustomers, getMobileDeps, async ({ ctx, deps, request, params, reply, log }) => {
    const r = await someService.call(deps.runtime, ctx, input);
    if (!r.ok) return reply.serviceError(r.error);            // contract code + status, VALIDATION fields
    return reply.ok({ customers, removed_customer_ids, next_cursor, has_more }); // validated vs ENDPOINTS.x.response, server_time added
  });
  ```
  Before `handler` runs: the version gate from `endpoint.appVersionGate` (426 APP_TOO_OLD with `min_app_version_code`; 400 VALIDATION when the header is missing), the bearer token (401 UNAUTHENTICATED: missing, bad signature, expired, family revoked), `resolveTenantContext` (channel `mobile`, the token's device; 401 DEVICE_REVOKED, 403 ACCOUNT_DISABLED / ROLE_NOT_ALLOWED). `ctx.deviceId` is the token's device, `ctx.userId` the lineman. Bodies: `readJsonBody(scope, PaymentBatchEnvelope)` → 400 VALIDATION with `fields`. Path params arrive as `params` (Next's awaited `params`). Use `reply.error(code, message?, extras?)` for endpoint codes (CURSOR_INVALID …); messages are developer English, never PII. A thrown error becomes 500 INTERNAL (logged with ids, sent to Sentry). Every response has `server_time` and `Cache-Control: no-store`.
- **T-032 (team):** `revokeDevice.call(runtime, ownerCtx, { deviceId })` → `{ deviceId, revokedAt, alreadyRevoked, revokedTokens }` (Owner only; idempotent; another tenant's id → NOT_FOUND; audited `devices.revoke`). Deactivating a lineman: set `users.status = 'disabled'` and, in the same `withTenant` transaction, `revokeMobileRefreshTokens(tx, { userId, reason: "user_disabled", now })`; resetting a lineman's password: `revokeMobileRefreshTokens(tx, { userId, reason: "password_changed", now })`. Even without the helper, a disabled user is refused on the very next request (ACCOUNT_DISABLED) and on refresh (which also revokes the family). Phone list columns: `devices.model`, `os_version`, `app_version`, `app_version_code`, `last_seen_at` (updated on login and every refresh, i.e. about every 15 minutes of use), `device_code`, `revoked_at`.
- **T-064 / Android:** nothing changes for the app; T-063's client already matches (reactive refresh on 401, single flight, DEVICE_REVOKED / REFRESH_TOKEN_INVALID / ACCOUNT_DISABLED handling).

**Token format and lifetimes**

- **Access token:** `cbm1.<base64url JSON {sub, op, dev, fam, role, iat, exp}>.<base64url HMAC-SHA256>`, 15 minutes (`exp` checked against the injected clock), opaque to the app. Key = HKDF-SHA256(`BETTER_AUTH_SECRET`, salt `cable-billing`, info `cb.mobile.access-token.v1`): no new secret to provision, and separate from every key Better Auth derives. Why not a JWT: one fixed algorithm and no header means no `alg` negotiation / `none` / algorithm-confusion class, and no library; we are the only issuer and verifier. Why not opaque + DB: every request already re-reads user, operator, device and token family (below), so a stored access token would only add a write per sign-in/refresh. Rotating `BETTER_AUTH_SECRET` invalidates outstanding access tokens; phones refresh transparently.
- **Refresh token:** 32 random bytes, base64url (43 chars). Only `hex(SHA-256)` is stored (T-021's CHECK). 180 days from the **last** use (sliding: each refresh issues a new token with a fresh 180-day expiry). Single use: each refresh sets `rotated_at` on the presented token and inserts its successor (`parent_id`, same `family_id`). One family per sign-in on a phone.
- **App config:** `min_app_version_code` (`MIN_APP_VERSION_CODE` in `apps/web/src/lib/mobile/config.ts`, raised by a deploy), `operator { id, name, office_phone, receipt_footer }` (office phone = `settings.office_phone`, else the operator's business `phone` when it fits the contract format, else null), `tenant_mode` (`readTenantMode`: `read_only` for read_only/cancelled/no subscription), `features` (`{}`).

**Security decisions (reviewer please check)**

1. **Lineman only, no enumeration.** Unknown login and wrong password → the same `INVALID_CREDENTIALS` after the same argon2 work (`verifyPassword`, or `hashPassword` for an unknown login). ROLE_NOT_ALLOWED (owner, staff, platform admin) and ACCOUNT_DISABLED (disabled user, suspended operator) only after the password was proven; nothing is registered for them, and the attempt is audited `auth.sign_in_blocked` `{ reason, channel: "mobile" }` (platform event for an admin).
2. **Rate limits** (reusing T-026's limiter and `rateLimitKey`): sign-in uses **the same keys as the web** (`signin:ip`, `signin:account:<user id>` / `signin:login:<typed>`), so 10 wrong passwords per 15 min per account across both channels; refresh 30 / 15 min per installation and 600 / 15 min per IP; logout 300 / 15 min per IP. Fails open (logged at error), like T-026. apps/web shares one limiter instance with the web auth (`getRateLimiter()`), so the counters add up in memory too.
3. **Rotation + reuse detection:** presenting a rotated token outside the grace rule revokes the **whole family** (`reuse_detected`), audited `mobile_auth.refresh_reuse_detected`; the legitimate phone then signs in again (queued payments kept).
4. **Grace window (T-063 follow-up), decided: 5 minutes, once.** The immediately previous token is accepted again only if (a) it was rotated ≤ 5 min ago, (b) its successor has never been used and is not revoked or expired, and (c) the same installation presents it (the request's `install_id` must match the device). The unused successor is then retired (rotated) and a new pair issued. A third presentation, any older token, or any use after the successor was used is reuse. Trade-off: an attacker holding the previous token *and* the install id could win one race inside those 5 minutes; reuse detection still kills the family on the phone's next refresh. A lost response followed by more than 5 minutes offline signs the phone out (payments stay queued).
5. **Binding:** refresh requires the token's device `install_id` (mismatch → REFRESH_TOKEN_INVALID **without** revoking, so a wrong id can't be used to sign a phone out); access tokens carry the device and family. **Every authenticated request** re-reads the user (status, role), operator (status), device (not revoked, via `resolveTenantContext`) and that the token's family still has a live token: deactivation, "Sign out this phone", logout, reuse detection and another sign-in on the phone all take effect on the next request, not after 15 minutes.
6. **One sign-in per phone:** a new sign-in on an installation revokes every earlier family on that device (reason `logout`), whoever it belonged to; `devices.user_id` moves to the new user (T-046 then flags the previous user's queued payments as `collector_mismatch`, PLAN §9.2). A revoked device signing in again with a password is un-revoked and keeps its `device_code` (T-021 decision 8); the audit row says `was_revoked: true`. Note for the owner: if a lost phone's password may be known, also reset the lineman's password (T-032).
7. **Refresh outcomes:** revoked device → DEVICE_REVOKED (401); unknown / revoked / expired / reused / install mismatch / role changed / device moved to another user → REFRESH_TOKEN_INVALID (401); disabled user → ACCOUNT_DISABLED (403) and the family is revoked (`user_disabled`); suspended operator → ACCOUNT_DISABLED without revoking (suspension can be lifted). Role changes use REFRESH_TOKEN_INVALID (not ROLE_NOT_ALLOWED, which the contract doesn't list for refresh); the next login then says ROLE_NOT_ALLOWED.
8. **Device codes:** 3 characters from 32 unambiguous symbols (no 0/O/1/I; still matches `^[A-Z0-9]{3}$`), random among the operator's free codes, unique per operator forever; concurrent first sign-ins retry the transaction on a unique violation (tested with 6 parallel phones and the same installation twice at once).
9. **Version gate:** `x-app-version-code` below `min_app_version_code` → 426 APP_TOO_OLD on login, refresh and every gated bearer endpoint; a missing/malformed header there → 400 VALIDATION. `/app/config` and `/auth/logout` never refuse on the version (the header is optional there). The gate runs before credentials are checked.
10. **Audit (no PII), same actions as the web:** `auth.signed_in` `{ channel: "mobile", method, device_id, device_code, new_device, was_revoked, previous_user_signed_out, ended_sessions, app_version_code }` in the device-registration transaction; `auth.sign_in_blocked`; `auth.signed_out` `{ channel, device_id }`; `mobile_auth.refresh_reuse_detected`; `devices.revoke`. IP, user agent and request id go in the audit columns. Logs carry ids and reasons only (the strict test logger enforces it). Successful refreshes are not audited (one every 15 minutes per phone); `last_seen_at` records them.
11. **Responses never break the contract:** every success body is validated with the endpoint's Zod schema before it is sent (a mismatch is logged and answered 500 INTERNAL); request bodies are validated with the contract's request schemas (400 VALIDATION with field paths, never values).

**T-046 open question (deactivated lineman's own queue) — proposal, not implemented**

Today a deactivated lineman is refused on every request (ACCOUNT_DISABLED, 403) and on refresh, so their phone keeps its queued payments (never deleted, BR-11). They reach the office when **any active lineman signs in on that phone**: the queue is then posted with `collector_mismatch` / `collector_inactive` review flags (T-046), which is PLAN §9.2's "a different user signs in → held and flagged for office review" and matches T-032's AC ("refresh fails; queued payments still accepted with review flag"). Recommended for T-032: warn on "Deactivate" that the phone may hold unsynced payments and that another lineman signing in on it will send them for review (or deactivate after the day's handover). A narrower alternative — letting a disabled lineman's still-valid session push **only** `POST /payments:batch` (flagged `collector_inactive`) — needs an option in T-025's `resolveTenantContext` and a decision by the product owner; it is not done here (T-061 can pick it up if wanted).

**Deviations / files outside the owned paths**

- `apps/web/src/lib/auth/server.ts` (T-026, done): exposes the existing rate limiter as `getRateLimiter()` (kept in the singletons) so web and mobile share counters. No behaviour change for the web.
- `apps/web/package.json` (+ `@cb/contracts`), `apps/web/next.config.ts` (`transpilePackages` + `@cb/contracts`), `pnpm-lock.yaml`, `packages/core/src/index.ts` (one line `export * from "./mobile-auth";`).
- New `apps/web/e2e/mobile-auth.spec.ts` (API-level Playwright tests against `next start` + a migrated DB, every body parsed with the contract). Runs in the existing `Web e2e` job; no workflow change.
- `min_app_version_code` is a constant in `apps/web/src/lib/mobile/config.ts`, not an environment variable or a DB setting (changing it needs a deploy either way on Vercel; avoids touching T-011's env files). PLAN's `min_app_version` string is the contract's integer `min_app_version_code` (T-051 decision 6).
- No new environment variable, migration, i18n string or dependency outside the workspace.

**Open questions / follow-ups (no task files created)**

- Grace window length (5 min) and the refresh/logout limits are tunable constants (`REFRESH_REUSE_GRACE_SECONDS`, `MOBILE_AUTH_RATE_LIMITS`).
- Retention (Q-06): rotated/revoked `mobile_refresh_tokens` rows accumulate (~40 per phone per working day). A cleanup job (delete families whose newest token expired or was revoked > N days ago) belongs with the other retention work.
- T-032: call `revokeMobileRefreshTokens` on deactivate / password reset (above), show `device_code` + `last_seen_at`, and the T-046 warning.
- T-061: the deactivated-lineman option above, if the product owner wants it.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; DB suites ran, no skips)

- `pnpm --filter @cb/core test`: 31 files / 454 tests. New: `mobile-auth/mobile-auth.test.ts` (28, real DB, injected clock): sign-in registers the phone (install id, model, OS, app version/code, last seen, code alphabet), only the SHA-256 of the refresh token stored, token pair expiries (15 min / 180 d), mobile TenantContext with the device; second sign-in on the same installation keeps device + code and kills the previous family; another lineman taking the phone; 6 concurrent first sign-ins get distinct codes and the same installation twice at once gives one device; **owner and staff with the right password → ROLE_NOT_ALLOWED, nothing registered, audited**; platform admin → ROLE_NOT_ALLOWED (platform audit); unknown login = wrong password; login case/whitespace; disabled user and suspended operator → ACCOUNT_DISABLED; 10 wrong passwords → RATE_LIMITED even with the right one, then the window passes; version gate on login (426 with the minimum, 400 without header); **access token valid at 14:59 and UNAUTHENTICATED at 15:00**; missing / forged (other key) / tampered / non-Bearer tokens; gate on gated endpoints only; deactivation → ACCOUNT_DISABLED on the next request and on refresh (family revoked); **rotation** (single use, parent/family, sliding 180 d, last seen); **reuse detection** (whole family revoked incl. the newest pair, access token dead, audit row); **grace** (lost response → retry accepted once, successor retired, third use = reuse); no grace after 5 min or from another install id (and no revocation on a wrong install id); unknown/expired tokens; refresh version gate and per-install limit; logout (family revoked, refresh/access dead, idempotent, audit); **revokeDevice** → DEVICE_REVOKED on refresh and on the next request, tokens `device_revoked`, audit, idempotent, re-sign-in un-revokes with the same code; staff/lineman FORBIDDEN and another tenant's owner NOT_FOUND; app config (minimum, operator, tenant mode normal → read_only, business-phone fallback); no PII in logs or audit. `mobile-auth/units.test.ts` (11): token round trip and expiry boundary, tampering, foreign key, malformed tokens, correctly signed but wrong claims, secret length, refresh token entropy/hash, version header parsing and gate, device-code alphabet and exhaustion. Isolation suite: `devices.revoke` case passes; coverage test passes.
- **Mutation checks** (reverted): dropping the per-request family check → 4 tests fail; disabling reuse detection → 3 fail; disabling the grace window → the grace test fails; letting owners through the role check → the owner/staff test fails.
- `pnpm --filter web test`: 12 files / 100 tests. New `lib/mobile/handlers.test.ts` (21): every success body parsed with the contract schema and **equal to the contract fixtures** (login, refresh, logout, app config), request → service mapping, VALIDATION for non-JSON and off-contract bodies (paths only), each failure code → its status/extras (401/403/426 + `min_app_version_code`/429 + `Retry-After` + `retry_after_seconds`/400 + fields), request id from `x-vercel-id`, exception → INTERNAL, an off-contract response → INTERNAL (never sent), unconfigured server → INTERNAL, config authenticates with `appVersionGate: false`, auth failures stop before the handler.
- `pnpm --filter web test:e2e` (scratch DB `cb_e2e_t028`, migrated, `E2E_PORT=3228`, pre-installed Chromium; DB dropped afterwards): 18 passed, 3 new API tests: lineman sign-in → app config → refresh → grace retry → reuse kills the family (newest pair and access token dead); owner → 403 ROLE_NOT_ALLOWED, wrong password → 401, missing version header → 400, no token → 401; logout → refresh 401; `revokeDevice` (owner context) → app config and refresh 401 DEVICE_REVOKED. All bodies parsed with `@cb/contracts`.
- Root: `pnpm install`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9), `pnpm build` (9/9; `next build` with no environment succeeds and lists the four routes), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T14:08:16.105Z claimed by agent-t028
- 2026-10-13T14:31:59.808Z completed on task/T-028-mobile-auth-device-registration-access-r

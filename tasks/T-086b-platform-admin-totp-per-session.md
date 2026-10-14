---
id: T-086b
title: Platform admin sessions must each pass TOTP (revoke other sessions on enrolment)
phase: 4
area: core
status: done
owner: agent-t086b
claimed_at: 2026-10-14T14:14:33.779Z
branch: task/T-086b-platform-admin-sessions-must-each-pass-t
depends_on: [T-086]
review: required
claimable_by: agent
size: S
paths: [packages/core/src/admin/context.ts, packages/core/src/auth/auth.ts, apps/web/src/lib/auth/**]
---

# T-086b — Platform admin sessions must each pass TOTP (revoke other sessions on enrolment)

**Phase** 4 · **Area** core · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-086

## Goal

Every web session that reaches `/admin` has itself passed a TOTP check. A password-only session
can never become an admin session later.

## Scope

Today `resolveAdminContext` (`packages/core/src/admin/context.ts`) checks the user row's
`two_factor_enabled` and the session's `twoFactorEnabled`. That flag belongs to the **user**, not
the session. So a session opened with only the password **before** the admin enrolled TOTP (in
another browser) passes the gate once enrolment is done. The T-086 completion notes list this gap.

- On `confirmTwoFactorEnrolment` (T-026, `packages/core/src/auth/auth.ts`), revoke all of the
  user's **other** sessions (Better Auth `revokeOtherSessions` or a delete in the same request),
  and audit it (`auth.signed_out_everywhere` or a new action with words in `audit.json`).
- Record per session that TOTP was checked in it: at enrolment, and at sign-in through the 2FA
  challenge. For example, a session column or a field set by the 2FA plugin's hooks.
  `resolveAdminContext` (or `requirePlatformAdmin`) then requires it for the session in hand,
  not only the user's flag.
- Keep the 8-hour admin session cap and the existing refusals (`two_factor_required`).

## Out of scope

- Step-up TOTP for single sensitive actions (open support access, record a payment). That is a
  separate decision.
- Tenant users' 2FA (optional for owners today).

## Acceptance criteria

- [x] A password-only admin session made before enrolment is refused at `/admin` after enrolment
      completes in another session (and is in fact gone).
- [x] A session that passed the TOTP challenge at sign-in, or enrolled in it, gets in.
- [x] Tenant users are unaffected.

## Tests required

- Integration test (core, real Better Auth over the test DB): two sessions for one admin, enrol in
  one, and the other is revoked or refused by `resolveAdminContext`.
- Playwright: the `admin.spec.ts` enrolment flow still passes.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/admin/context.ts`
- `packages/core/src/auth/auth.ts`
- `apps/web/src/lib/auth/**`

## References

PLAN §9.2, §12.4; T-026 and T-086 completion notes ("Known gap").

## Completion notes

**What Better Auth does (read in the installed 1.7.7 source, not guessed)**

- The twoFactor plugin has **no per-session marker**. Its schema (`dist/plugins/two-factor/schema.mjs`)
  adds only `user.twoFactorEnabled` and the `twoFactor` table (secret, backup codes, `verified`,
  lockout counters). Nothing on `session`.
- A session that passed TOTP is always **created by the `/two-factor/verify-totp` endpoint**
  (`auth.api.verifyTOTP`, `totp/index.mjs` + `verify-two-factor.mjs`), after the code checked out:
  - at sign-in, the twoFactor `after` hook on `/sign-in/*` deletes the password session and sets the
    `two_factor` cookie, then `verifyTOTP` → `valid()` calls `internalAdapter.createSession(userId)`;
  - at enrolment, `verifyTOTP` with a live session and `twoFactor.verified !== true` sets
    `user.twoFactorEnabled`, calls `createSession(user.id, false, activeSession)` and deletes the old
    session. Its response still carries the **old (deleted) token**, so "mark the returned token"
    can't work.
- `databaseHooks.session.create.before` runs inside the endpoint context
  (`with-hooks.mjs`: `tryGetCurrentAuthEndpointContext()`; `dispatch.mjs` sets `path: endpoint.path`),
  so the hook sees `ctx.path === "/two-factor/verify-totp"` exactly when one of those two sessions is
  made.
- `internalAdapter.createSession(…, override)` copies the old session's fields into a re-issued
  one; our hook therefore **forces** the marker either way, so it can never be carried over.

**What changed**

| Where | What |
|---|---|
| `packages/db/src/schema/auth.ts`, migration `0018_session_two_factor_verified` | `sessions.two_factor_verified_at timestamptz NULL`: when **this** session passed TOTP; NULL = password-only. Same RLS as the rest of the row (platform: auth path; tenants: only their own users' sessions, never an admin's). |
| `packages/core/src/auth/auth.ts` | `session.additionalFields.twoFactorVerifiedAt` (`input: false`, so Better Auth refuses it from input). `session.create.before` sets it to `now()` when `ctx.path` is `/two-factor/verify-totp`, else `null`, and remembers that session's token in the call scope. `session.update.before` throws if an update ever carries it (never written after creation). `WebSession.twoFactorVerified` (new). `getSession` **revokes** a platform admin's session when the user has TOTP on but the session never passed it (log reason `two_factor_not_verified_in_session`). `confirmTwoFactorEnrolment` now refuses when TOTP is already on, and after Better Auth's re-issue **deletes every other session of the user** (all but the token the hook just recorded; if none was recorded, all of them: fail closed), audits `auth.other_sessions_ended` `{ sessions, reason: "two_factor_enabled" }` when any were ended, and returns `otherSessionsEnded`. |
| `packages/core/src/admin/context.ts` | `AdminPrincipal` takes `sessionId` instead of the `twoFactorEnabled` boolean. `resolveAdminContext` re-reads the user **and that session** in one read: same user, `expires_at > now()`, and `two_factor_verified_at IS NOT NULL`. New refusals: UNAUTHENTICATED `no_session` (gone, expired, another user's, malformed id) and FORBIDDEN `session_not_two_factor_verified`. Order kept: unknown → disabled → not an admin → no session → TOTP not on (`two_factor_required`, enrol) → this session not verified. |
| `apps/web/src/app/admin/_lib/context.ts` | passes `session.sessionId`; both new refusals fall through to `/login?next=…` (the unverified session was already deleted by `getSession`, so `/login` shows the form, no loop). |
| `packages/core/src/auth/audit-events.ts`, `audit-query/actions.ts`, `packages/i18n/messages/{en,hi}/audit.json` | New action `auth.other_sessions_ended` (count detail) with `sentence.*` and `action.*` words; Hindi in `_review`. Generated `apps/web/messages/*.json`. |

The 8-hour admin cap and `two_factor_required` are unchanged. Tenant users: their sessions get the
marker too when they pass TOTP, but nothing reads it for them.

**Decisions**

- A DB column (not a cookie claim): the gate re-reads the session row, so nothing the browser sends
  can claim TOTP; it also survives Better Auth's re-issues and shows up in queries.
- Marking keyed on the endpoint path, not on our service methods, because the enrolment re-issue's
  token isn't returned by `verifyTOTP` (above). Backup-code (`/two-factor/verify-backup-code`) and
  OTP sign-ins are not marked: neither is reachable (no HTTP endpoints; no service method). If a
  later task adds backup-code sign-in, add its path to the hook.
- Three layers, each tested on its own: revoke on enrolment (immediate), `getSession` revokes a
  stale unverified admin session (covers a missed revocation, e.g. a race or a crash between
  Better Auth's re-issue and our delete), and `resolveAdminContext` checks the session row.
- Ended sessions are audited only when there were any (no "0 devices" noise for the usual
  one-browser enrolment).

**Deviations / files outside the owned paths** (all needed by the change, smallest edits)

- `packages/db/src/schema/auth.ts` + migration 0018 (+ snapshot/journal): the coordinator's brief
  allowed a migration for the marker.
- T-086 (done): `apps/web/src/app/admin/_lib/context.ts` (one field), `admin-gate.test.ts`
  (fixture field + new redirect case), `packages/core/src/admin/test-support.ts`
  (`seedWebSession`; `adminContextFor` now resolves over a real TOTP-verified session row),
  `admin/support.test.ts` (principal built from real sessions + new T-086b case),
  `apps/web/e2e/admin.spec.ts` (second admin + two-browser case).
- T-026/T-035 (done): `audit-events.ts`, `audit-query/actions.ts`, `audit.json` (new action words),
  `auth.test.ts` (expectations + new cases).

**Open questions (product owner)**

- Step-up TOTP for sensitive admin actions stays out of scope (as the task says).
- Should an admin be able to see and end their own other sessions from the console? Today
  "sign out everywhere" ends all of them, and enrolment ends the others automatically.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 5452f5d)

- `@cb/core` `auth/auth.test.ts` (real Better Auth over the test DB), new cases:
  - **two password-only browsers for one admin**: before enrolment, `resolveAdminContext` refuses
    with `two_factor_required`. The phone enrols, and `confirmTwoFactorEnrolment` returns
    `otherSessionsEnded: 1`. One session row is left, with `two_factor_verified_at` set. The laptop's
    row is gone: `getSession` gives null, `resolveAdminContext` gives `no_session`, and confirming
    from it gives UNAUTHENTICATED.
  - The enrolled session gets an AdminContext. The laptop signs in again (password, then the code)
    and gets in. Confirming again gives INVALID_CODE.
  - Audit: `signed_in, signed_in, other_sessions_ended {sessions: 1, reason}, two_factor_enabled,
    signed_in`, all platform events.
  - A password-only admin session that outlives enrolment (TOTP turned on underneath it) is
    revoked by `getSession` on its next request, and the log reason is checked.
  - Staff password session: `twoFactorVerified: false`, still valid, TenantContext ok.
  - The existing enrolment test now also checks `twoFactorVerified` after enrolment and after the
    2FA sign-in.
- `admin/support.test.ts`: the gate uses real session rows. A password-only session gives
  `session_not_two_factor_verified`. Another admin's session, an expired one, a deleted one and a
  malformed id each give `no_session`. A verified session passes. The tenant-user, disabled and
  unknown cases are unchanged.
- `apps/web` `admin-gate.test.ts`: `sessionId` is passed. The new refusals → `/login?next=…`.
- Mutation checks (each reverted): dropping the session check in `resolveAdminContext` fails the
  support T-086b test. Dropping the `getSession` guard fails the "outlives enrolment" test. Making
  enrolment delete nothing fails the two-browser test. A hook that never marks fails the existing
  enrolment test and the two-browser test.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), and
  `TURBO_FORCE=1 pnpm test --concurrency=1` all pass: 10/10 packages, `@cb/core` 1218 passed + 3
  skipped, `@cb/db` 269, `@cb/web` 548. `pnpm build` passes (10/10). `pnpm generate` leaves no diff
  once the regenerated `apps/web/messages` are committed. The tokens/icons/i18n/openapi `--check`
  modes, `pnpm --filter @cb/db db:check` and `node scripts/tasks.mjs check --local` all pass.
- Playwright (`next start`, a freshly migrated scratch DB, pre-installed Chromium,
  `E2E_PORT=3386`): `admin.spec.ts` + `auth.spec.ts` + `mobile-auth.spec.ts` + `audit.spec.ts`
  **17/17**. This includes the new two-browser case: the pre-enrolment browser is sent to `/login`
  from every admin route, and it gets in only after password + code. The enrolment flow is
  unchanged.

## Board log
- 2026-10-14T14:14:33.782Z claimed by agent-t086b
- 2026-10-14T19:56:56.251Z completed on task/T-086b-platform-admin-sessions-must-each-pass-t

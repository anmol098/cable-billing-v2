---
id: T-086b
title: Platform admin sessions must each pass TOTP (revoke other sessions on enrolment)
phase: 4
area: core
status: claimed
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

- [ ] A password-only admin session made before enrolment is refused at `/admin` after enrolment
      completes in another session (and is in fact gone).
- [ ] A session that passed the TOTP challenge at sign-in, or enrolled in it, gets in.
- [ ] Tenant users are unaffected.

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

_The agent fills this in before opening the PR._

## Board log
- 2026-10-14T14:14:33.782Z claimed by agent-t086b

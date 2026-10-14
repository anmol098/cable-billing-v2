---
id: T-086d
title: Enrol platform admins at creation with a one-time setup link; count every failed code
phase: 4
area: core
status: todo
owner:
claimed_at:
branch:
depends_on: [T-086b]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/auth/admin-setup.ts, packages/core/src/auth/admin-setup.test.ts, packages/core/scripts/create-platform-admin.ts, apps/web/src/app/(auth)/admin-setup/**]
---

# T-086d — Enrol platform admins at creation with a one-time setup link; count every failed code

**Phase** 4 · **Area** core · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-086b

## Goal

Only the person a platform admin account was made for can attach an authenticator to it. Wrong
TOTP codes count toward the account lockout wherever they are typed.

## Scope

T-086b found two gaps and left them out of scope:

1. **Self-enrolment trusts first use.** A new platform admin has a password and no TOTP. They turn
   it on themselves at `/login/2fa/setup` on their first sign-in (T-026). So whoever learns the
   password of an admin who has not enrolled yet can enrol **their own** authenticator first, and
   then owns the account. T-026's open question names the bootstrap ("whoever first signs in with
   that password enrols TOTP").
2. **Some failed codes don't count toward the lockout.** Better Auth's account lockout
   (`twoFactor.failedVerificationCount`, 10 failures → 15 minutes) and its 5-tries-per-challenge
   limit only apply to the **sign-in challenge** branch of `verifyTOTP`. In the **existing-session**
   branch (`verify-two-factor.mjs`: a session cookie, no `two_factor` cookie), a wrong code calls
   only `invalid()`: no counter, no lock. `confirmTwoFactorEnrolment` uses that branch. Today only
   our per-IP limit (`AUTH_RATE_LIMITS.twoFactorPerIp`, 30 / 15 min) applies there.

Proposal (product owner to confirm):

- **Create platform admins with a one-time setup link instead of self-enrolment.**
  - A reviewed CLI (`packages/core/scripts/create-platform-admin.ts`, run by an existing admin or
    an operator of the platform) creates the user **without a usable password**.
  - It prints, or emails, a single-use, short-lived link: hashed token, like password reset.
  - The link page sets the password **and** enrols TOTP in one flow, then signs in with a
    TOTP-verified session (T-086b's mark).
  - `/login/2fa/setup` is no longer offered to platform admins. An admin without TOTP is refused
    at sign-in ("ask for a new setup link").
- **Count every wrong code per user**, whichever branch Better Auth takes:
  - Add a per-user key to our rate-limit hook for `/two-factor/*` (the user id comes from the
    session or the 2FA challenge), **or**
  - Record failures in `two_factors.failed_verification_count` from our service methods.
  - Decide which, and document it.
- Existing admins who already enrolled are unaffected. An admin who has not enrolled yet is moved
  to the setup link (a one-off step for the coordinator).

## Out of scope

- Step-up TOTP for single sensitive actions (separate decision, T-086b).
- Tenant users' 2FA (optional; T-026 open question).

## Acceptance criteria

- [ ] A platform admin account can only get TOTP through its own single-use setup link. Knowing
      the password alone never lets anyone enrol.
- [ ] The setup link is single use, expires, and is stored hashed.
- [ ] Wrong codes typed while signed in (enrolment, or a code check on an existing session) count
      toward a per-user limit as well as the per-IP one.

## Tests required

- Core integration test, real Better Auth over the test DB:
  - The setup link enrols once; a second use, an expired link, or a made-up link is refused.
  - A password-only sign-in of an admin who has not enrolled is refused.
  - 10 wrong codes on the existing-session branch lock the account.
- Playwright: admin created by the script → setup link → console.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/auth/admin-setup.ts`, `packages/core/src/auth/admin-setup.test.ts`
- `packages/core/scripts/create-platform-admin.ts`
- `apps/web/src/app/(auth)/admin-setup/**`
- The smallest changes in `packages/core/src/auth/auth.ts` (rate-limit key, refusing
  self-enrolment for platform admins) and `apps/web/e2e/admin.spec.ts`. T-026, T-086 and T-086b
  are done.

## References

PLAN §9.2, §12.4; T-026 (open question "Platform admin bootstrap"), T-086b completion notes.

## Completion notes

_The agent fills this in before opening the PR._

## Board log

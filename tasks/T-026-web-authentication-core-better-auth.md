---
id: T-026
title: Web authentication core (Better Auth)
phase: 1
area: core
status: todo
owner:
claimed_at:
branch:
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

- [ ] Wrong password ×N triggers rate limit.
- [ ] Lineman credentials cannot sign in to the web.

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

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

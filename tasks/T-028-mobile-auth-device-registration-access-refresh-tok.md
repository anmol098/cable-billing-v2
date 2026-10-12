---
id: T-028
title: Mobile auth: device registration, access/refresh tokens, app config
phase: 1
area: api
status: todo
owner:
claimed_at:
branch:
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

- [ ] Revoked device gets 401 on refresh; access token expires in 15 min.
- [ ] Owner/staff credentials are rejected on mobile login.

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

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

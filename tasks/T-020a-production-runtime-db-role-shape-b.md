---
id: T-020a
title: Production runtime DB role (non-owner login role) and boot check
phase: 1
area: infra
status: todo
owner:
claimed_at:
branch:
depends_on: [T-020]
review: required
claimable_by: agent
size: S
paths: [docs/runbooks/environments.md, packages/db/src/runtime-role.ts, packages/db/src/runtime-role.test.ts]
---

# T-020a — Production runtime DB role (non-owner login role) and boot check

**Phase** 1 · **Area** infra · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-020

## Goal

In staging and production the app connects as a login role that is not the table owner and has no
BYPASSRLS ("shape B" in `packages/db/README.md`), so even a raw query that never set a tenant sees
zero rows.

## Scope

- Runbook (`docs/runbooks/environments.md`): after the first migration on the staging/prod Neon
  branch, create `CREATE ROLE cb_app LOGIN PASSWORD '<generated>' INHERIT IN ROLE app_rw, app_platform;`
  and set the runtime `DATABASE_URL` (pooled) to that role; `DATABASE_URL_UNPOOLED` (migrations only)
  stays the owner. Rotation steps for the new password.
- `packages/db/src/runtime-role.ts`: `checkRuntimeRole(db)` that reports if the connected session
  user owns any table in `public`, is superuser or has BYPASSRLS; T-025/apps/web can call it at boot
  in production and log/alert (not crash previews, which use the Neon integration's owner URL).

## Out of scope

- Changing preview environments (the Vercel–Neon integration writes owner URLs; shape A is fine there).

## Acceptance criteria

- [ ] Runbook documents role creation, variable placement and rotation.
- [ ] `checkRuntimeRole` flags an owner/BYPASSRLS session and passes for a shape-B role (integration test).

## Tests required

- Integration test with the @cb/db harness (`createLoginRole()` gives a shape-B URL).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `docs/runbooks/environments.md`
- `packages/db/src/runtime-role.ts`
- `packages/db/src/runtime-role.test.ts`

## References

PLAN §9.1, E-03, T-020 completion notes, `packages/db/README.md` "Who connects as whom".

## Completion notes

_The agent fills this in before opening the PR._

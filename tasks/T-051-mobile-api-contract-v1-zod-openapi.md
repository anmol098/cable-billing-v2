---
id: T-051
title: Mobile API contract v1 (Zod → OpenAPI)
phase: 2
area: api
status: todo
owner:
claimed_at:
branch:
depends_on: [T-024]
review: required
claimable_by: agent
size: M
paths: [packages/contracts/**]
---

# T-051 — Mobile API contract v1 (Zod → OpenAPI)

**Phase** 2 · **Area** api · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-024

## Goal

Freeze the Android ↔ server contract early so both sides build in parallel.

## Scope

- Zod schemas for every endpoint in PLAN §10.2 (requests, responses, error envelope with stable codes, pagination cursor, per-item batch results).
- Generate `openapi.json` (committed) with `--check` mode; JSON fixtures for each response in `fixtures/` used by Android decode tests.
- Versioning rules doc (additive changes only within v1).

## Acceptance criteria

- [ ] Every field documented; money as integer paise; times as ISO-8601 UTC; ids as UUID strings.

## Tests required

- Schema round-trip tests over fixtures.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/contracts/**`

## Notes

- This task has no DB dependency on purpose. Start it as soon as T-024 is done.

## References

PLAN §10.2, PLAN §10.3, PLAN §10.4, E-05 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

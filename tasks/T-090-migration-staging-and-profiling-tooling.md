---
id: T-090
title: Migration: staging and profiling tooling
phase: 5
area: migration
status: claimed
owner: agent-t090
claimed_at: 2026-10-13T15:29:09.812Z
branch: task/T-090-migration-staging-and-profiling-tooling
depends_on: [T-001]
review: self
claimable_by: agent
size: M
paths: [tools/migration/**, docs/migration/README.md]
---

# T-090 — Migration: staging and profiling tooling

**Phase** 5 · **Area** migration · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-001

## Goal

Load the legacy dump locally and profile it without exposing personal data.

## Scope

- Docker compose for MariaDB; `restore.sh` reading the dump from a path outside the repo (or gitignored `tools/migration/data/`).
- Copy legacy tables into a Postgres `legacy` schema (Neon non-prod branch).
- Profiler producing counts-only markdown (`docs/migration/profile-<date>.md`): per-table/operator counts, null/orphan stats, zero dates, duplicate codes, float anomalies, distinct status values.
- Built and tested against a synthetic fixture dump generated from the documented legacy table names.

## Acceptance criteria

- [ ] Profile output contains no names, phones, addresses or passwords (automated check).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/migration/**`
- `docs/migration/README.md`

## Notes

- NEVER commit the dump or any row-level data. Running against the real dump requires a human with access.

## References

PLAN §15 steps 1, FR-026, BRD §13, D-09 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T15:29:09.813Z claimed by agent-t090

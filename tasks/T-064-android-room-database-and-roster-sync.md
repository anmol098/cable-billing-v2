---
id: T-064
title: Android: Room database and roster sync
phase: 3
area: android
status: claimed
owner: agent-t064
claimed_at: 2026-10-13T12:48:27.295Z
branch: task/T-064-android-room-database-and-roster-sync
depends_on: [T-063]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/data/db/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/RosterSync*.kt, apps/android/app/schemas/**]
---

# T-064 — Android: Room database and roster sync

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-063

## Goal

The phone always has the roster, even offline.

## Scope

- Room entities from PLAN §11.5 (payments queue table defined here but used by T-066).
- Roster sync worker: initial + delta, periodic 30 min, on app open, after push; `sync_meta` last-updated.
- Repository flows for search and customer detail with projected balance (server − unsynced local).

## Acceptance criteria

- [ ] Airplane mode: search still works with last data and shows 'Updated X min ago'.

## Tests required

- DAO tests, sync worker tests with MockWebServer, Room migration test baseline.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/data/db/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/RosterSync*.kt`
- `apps/android/app/schemas/**`

## References

PLAN §10.3, PLAN §11.5 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T12:48:27.295Z claimed by agent-t064

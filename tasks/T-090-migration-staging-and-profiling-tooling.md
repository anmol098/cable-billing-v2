---
id: T-090
title: Migration: staging and profiling tooling
phase: 5
area: migration
status: done
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

- [x] Profile output contains no names, phones, addresses or passwords (automated check).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/migration/**`
- `docs/migration/README.md`

## Notes

- NEVER commit the dump or any row-level data. Running against the real dump requires a human with access.

## References

PLAN §15 steps 1, FR-026, BRD §13, D-09 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**Built** `tools/migration` as the workspace package `@cb/migration` (source-only, tsx CLIs, vitest),
plus `docs/migration/README.md` (the runbook: how to run it end to end, the PII layers, the target
guard, which Neon branch to use). Nothing in the repo holds row-level data; dumps and generated
fixtures go to the git-ignored `tools/migration/data/`.

| Piece | What |
|---|---|
| `docker-compose.yml` | MariaDB 10.11 on `127.0.0.1:3307`, relaxed `sql_mode` (zero dates restore as-is), named volume |
| `restore.sh [--local] [--dry-run] DUMP` | `.sql`/`.sql.gz`/`.sql.zst` → fresh database `legacy`. Refuses (exit 2) any path inside the repo except `tools/migration/data/`, and there only if git-ignored and untracked. Warns on `USE`/`CREATE DATABASE` dumps |
| `legacy:copy` | `MariaDbSource` (mysql2, raw values: `dateStrings`, DECIMAL/big ints as strings) → Postgres schema `legacy`, names kept (`"isReceipt"`). Raw types: ints → bigint, FLOAT/DOUBLE → double precision, DECIMAL → numeric, **dates → text as printed** (zero dates survive), binary → bytea. One transaction per table, row count verified, stale tables dropped, metadata in `legacy._copy_columns/_copy_tables/_copy_runs`, `REVOKE ALL ON SCHEMA legacy FROM PUBLIC` |
| `legacy:profile` | counts-only `docs/migration/profile-<IST date>.md`: rows vs PRD App. A baseline, rows per `op_id` (null/unknown operators, group sum vs total), null/zero/orphan references (16 checks), duplicates (customer code / VC no / invoice no per operator, lineman login, operator display name), zero/invalid dates + valid range, float/money anomalies (negative, zero, fractional, > 2 decimals, whole hundreds), filtered status values, per-column null/blank/distinct |
| `legacy:check FILE [--with-data]` | the PII scanner on any finished file |
| `legacy:fixture [--scale small\|legacy]` | synthetic fake dump with the documented table names; `legacy` scale = App. A counts exactly (8 / 7,616 / 7,334 / 146,224 / 7,334 / 134) |

**Interfaces for T-091…T-094:** the `legacy` schema (raw copy) and `legacy._copy_columns` (MariaDB
types); `readCatalog`, `findTable`/`findColumn`, `classifyColumn`, `MariaDbSource`/`MemorySource`
(`LegacySource`), `generateFixture` + `toMysqlDump` (fixtures for transform tests), `checkTarget` +
`assertTargetDeclaredNonProd` (reuse for any step that writes to Neon), exported from `@cb/migration`.
T-092/T-093 own `src/transform/{master,financial}/**`.

**PII check (acceptance criterion).** Four layers (details in the README): the `Profile` type has no
field for row text; sensitive columns (by name words/roots: `customerName`, `cust_mobile2`, `passwd`,
`remark` …) are never listed; status values are shown only if the column has ≤ 25 values, the value
is used by ≥ 5 rows (small integers exempt), is a short code, has no phone/e-mail/hash shape and is
not a value (or name word) of any identifying column; and the rendered file is scanned for shapes
(Indian mobiles, e-mails, hashes/tokens, 9+ digit runs, Aadhaar groups) and for every identifying
value in the copied data. A finding means nothing is written (exit 3); messages name line + column,
never the value. Tests plant a phone and a full name in `costumer.status`, a lineman's first name in
≥ 5 rows of `vc.status`, phones/names in invoice remarks and plaintext + hashed passwords, then assert
by plain substring (independent of the scanner) that none of the fixture's personal values reaches the
profile, and that the scanner catches a name, password, address or spaced phone appended to it.

**Decisions**
- The target is `MIGRATION_TARGET_URL` only (never `DATABASE_URL`). Guard: refuse `VERCEL_ENV`/
  `NODE_ENV=production`/`CB_MIGRATION_FORBIDDEN=1`; refuse host/db/user names with `prod`/
  `production`/`live`; local hosts only unless `--allow-remote <exact host>`; a remote DB must carry
  `cb.migration_target = 'non-prod'` (set once with `ALTER DATABASE … SET`), which the prod project
  never has. The legacy source must be local unless `--allow-remote-source`.
- Profiling runs on the Postgres copy, not on MariaDB: one SQL dialect, testable in CI, and the raw
  text dates keep zero dates visible.
- Copy legacy into a dedicated Neon branch (e.g. `migration-rehearsal` from `staging`), never into a
  branch previews are made from (README "Where the copy may go").
- Scripts are named `legacy:*` because `pnpm profile` is a reserved pnpm command.
- Reference/duplicate checks use candidate column lists in `src/config.ts` (only `op_id`,
  `isReceipt`, `isDeleted` are documented); the report says which column was used or "not checked".

**Verified for real (this container)**
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`.
- `@cb/migration` tests: 110 with MariaDB, of which 4 MariaDB tests are skipped without
  `LEGACY_TEST_MARIADB_URL` (CI). Postgres tests use `DATABASE_URL` like `@cb/db` (scratch
  `cb_mig_test_*` databases; `CB_SKIP_DB_TESTS=1` skips).
- MariaDB 10.11.14 installed with apt (no Docker daemon here): `restore.sh --local` of the small and
  legacy-scale fixture dumps (legacy: 1.8 s), `legacy:copy` from MariaDB (183,410 rows, 3.4 s),
  `legacy:profile` (2.2 s, PII check passed), and a test asserting the profile built through MariaDB
  **equals** the one built from the in-memory fixture.
- **Not exercised:** `docker compose` (no Docker daemon; the compose file is untested), a Neon target
  (the remote guard and marker are unit-tested only), and the real dump (needs the human who holds it).

**Open questions / follow-ups**
- Run the profiler on the real dump (human, feeds T-091/H-06), then replace the candidate column
  names in `config.ts` with the real ones and extend `SENSITIVE_WORDS` if the real schema uses names
  the classifier misses (check section 8 of the first profile: every personal column must say
  `sensitive`).
- Unknown until then: every column of every legacy table except `op_id`/`isReceipt`/`isDeleted`;
  the `plan`/`recharge` definitions; whether there are other tables; the dump's charset and MariaDB
  version; whether money ints are rupees (section 6 "whole hundreds" is evidence).
- The real dump's size and whether it is a `--databases` dump (restore.sh warns).
- No CI job runs the MariaDB tests (CI workflows are outside this task's paths). A MariaDB service
  container in `web.yml` with `LEGACY_TEST_MARIADB_URL` would cover them; worth a small task if the
  migration code grows.

## Board log

- 2026-10-13T15:29:09.813Z claimed by agent-t090
- 2026-10-13T15:57:31.463Z completed on task/T-090-migration-staging-and-profiling-tooling

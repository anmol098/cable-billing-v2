---
id: T-096
title: Backups, monitoring alerts and runbooks
phase: 5
area: infra
status: done
owner: agent-t096
claimed_at: 2026-10-14T12:34:57.733Z
branch: task/T-096-backups-monitoring-alerts-and-runbooks
depends_on: [T-011, T-043]
review: self
claimable_by: agent
size: M
paths: [.github/workflows/backup.yml, docs/runbooks/**]
---

# T-096 — Backups, monitoring alerts and runbooks

**Phase** 5 · **Area** infra · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-011, T-043

## Goal

We can recover from failure and know when something breaks.

## Scope

- Nightly encrypted pg_dump to object storage (30-day retention) + monthly restore drill procedure with invariants check and `restore-log.md`.
- Sentry alert rules, uptime check, billing-failure and sync-spike alerts documented.
- Runbooks: billing run failure, stuck sync, support access, restore, cutover, rollback.

## Acceptance criteria

- [ ] One documented successful restore drill into a scratch branch.
  _Not ticked: needs H-01 (Neon, bucket, keys). The mechanism is proven locally and documented in
  `docs/runbooks/restore-log.md` (three passing drills of fake seed data into scratch Postgres 17
  databases, up to legacy size), and the Neon scratch-branch drill is written out step by step in
  `docs/runbooks/backup-and-restore.md` §5.2. Tick this after the first real drill is logged._

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `.github/workflows/backup.yml`
- `docs/runbooks/**`

## Notes

- Bucket/credentials come from H-01.

## References

PLAN §17, PRD §15 #14, BRD §15 (Operational readiness) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `.github/workflows/backup.yml` | Three jobs. **Backup self-test** (every PR touching the backup scripts, monitoring config, migrations or `core/src/invariants`; and on demand): Postgres 17 service, `db:seed --migrate --scale small`, `self-test.sh`, `node --test docs/runbooks/monitoring/alerts.test.mjs`; no secrets. **Nightly backup** (`0 20 * * *` = 01:30 IST; environment `backup`; only when repo variable `BACKUP_ENABLED=true`): config check that names missing secrets, `backup.sh` to S3/R2, Sentry cron check-ins (`in_progress`/`ok`/`error`) when `BACKUP_SENTRY_CRON_URL` is set. **Restore drill** (`0 2 8 * *` = 07:30 IST on the 8th; environment `restore-drill`; only when `RESTORE_DRILL_ENABLED=true`): restores the newest (or a chosen) backup into a throwaway `postgres:17` service, verifies it, uploads the report as an artifact. Pins = web.yml's. |
| `docs/runbooks/backup/backup.sh` | Exports a REPEATABLE READ snapshot, takes `manifest.pgsql` (row count of every table in `public`/`drizzle`/`app`, 5 money totals, migration journal head) **in that snapshot**, `pg_dump -Fc --snapshot`, `pg_restore --list` sanity check, tar(dump+manifest) → `age` to the public key(s) → `.sha256` sidecar → `s3://…/<env>/YYYY/MM/DD/cable-billing-<env>-<stamp>.tar.age` (or a local dir). Refuses pooled URLs and a pg_dump older than the server. Plain text never outlives the script. |
| `docs/runbooks/backup/restore-drill.sh` | Refuses a non-empty target; fetches (newest under a prefix, or a given file), checks the sha256, decrypts, `roles.pgsql`, `pg_restore --no-owner --single-transaction --exit-on-error` **skipping the dump's DEFAULT ACL entries** then `post-restore.pgsql` re-creates migration 0000's default privileges for the restoring owner, ANALYZE, then `verify-restore.ts`. Prints a Markdown report with per-phase timings (RTO evidence). Exit 0 verified / 1 failed / 2 refused / 3 restored but not verified. |
| `docs/runbooks/backup/verify-restore.ts` | Run with `@cb/db`'s tsx. Compares the restored copy's manifest with the backup's (tables, counts, money totals, migrations) and runs T-052 `checkTenantInvariants` for every tenant in read-only `withTenant` (nothing written). Imports workspace sources by relative path (docs/ is not a package). |
| `docs/runbooks/backup/self-test.sh` | Local/CI only (refuses non-localhost): happy path + 4 failure cases (damaged file, wrong key, non-empty target, deliberately broken books → `BALANCE_MISMATCH`). |
| `docs/runbooks/backup/{install-tools.sh,lifecycle.json}` | PGDG `postgresql-client-17` + `age` on Ubuntu runners; the 30-day S3 lifecycle rule. |
| `docs/runbooks/monitoring/alerts.json` | Alerts as code: 8 Sentry issue alerts (`billing-run-failed`, `invariant-breach`, `job-failed-any`, `cron-failed`, `sync-errors-spike`, `razorpay-webhook-failed`, `unsafe-db-role`, `new-issue`), the `nightly-backup` cron monitor, the `/api/health` uptime check; each with severity, why and runbook section. |
| `docs/runbooks/monitoring/sentry-alerts.mjs` | Dry run by default (prints payloads); `--apply` upserts issue rules by name and cron monitors by slug through Sentry's REST API; `--cron-url` derives the check-in URL from `SENTRY_DSN`. |
| `docs/runbooks/monitoring/alerts.test.mjs` | `node --test`: every message/tag/job type an alert filters on exists in `apps/web/src` / `packages/core/src`; every runbook link in every runbook resolves (file + heading anchor); every alert is in monitoring.md's table; the monitor's schedule equals backup.yml's; payload shapes; `--apply` upsert logic against a fake fetch. |
| Runbooks | `README.md` (index, severities, incident steps, ground rules), `backup-and-restore.md` (RPO/RTO, PITR, dump restore, monthly drill, H-01 setup with every secret name, backup alert, key rotation), `restore-log.md`, `monitoring.md` (alert table, Sentry/uptime setup, triage, site down, daily check, PRD §16 metric queries), `billing-run-failure.md`, `invariant-breach.md`, `stuck-sync.md`, `razorpay-webhooks.md`, `support-access.md`, `rollback.md`, `cutover.md` (draft for H-09). `environments.md` §4.9/§4.10/§7 now point at the backup environments and key rotation. |

**Proven locally** (Node 24.21.0, pnpm 12.11.2, Postgres 17.11, `age` 1.1.1; details in `restore-log.md`)

- Backup → restore → verify of the T-036 `legacy`-size seed (8 operators, 7,616 customers, 1,174,912
  rows, 66 MB encrypted): backup 18 s, restore + verify **44 s** (a first run before the default-ACL
  change: 60 s), all counts and totals equal, 16 migrations, 8 tenants 0 violations.
- `self-test.sh` (= the CI job): all 5 cases as expected (PASS / checksum refused / decrypt refused /
  non-empty refused / exit 3 with `BALANCE_MISMATCH 1`), nothing written to refused targets.
- Restore as a **non-superuser owner** (like Neon's `neondb_owner`): first failed on the dump's
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`, fixed (skip + re-create), then PASS; `pg_default_acl`
  shows the app roles' grants by the new owner.
- `db:migrate` on a restored copy applies nothing (journal intact).
- `s3://` paths (upload layout, newest-object choice, download) against a stand-in `aws` command that
  maps the bucket to a folder (not the real AWS CLI).
- `alerts.test.mjs` 14/14; 5 mutations of `alerts.json` / a runbook heading each fail the tests;
  `sentry-alerts.mjs` dry run, `--cron-url` and the `--apply` missing-credentials refusal run.
- shellcheck 0.9.0 clean on all scripts; actionlint 1.7.7 clean on `backup.yml` (and web.yml).

**Needs H-01 (not done, not claimed):** Neon PITR steps (§3) and the Neon scratch-branch drill (§5.2),
the real bucket/keys/AWS CLI upload, the GitHub environments `backup`/`restore-drill` and the
`BACKUP_ENABLED`/`RESTORE_DRILL_ENABLED` variables, `sentry-alerts.mjs --apply` against a real Sentry
org (payloads follow Sentry's documented API but were never sent), the uptime check, the first real
drill (the unticked acceptance criterion). Scheduled runs start only once `backup.yml` is on `main`.

**Decisions (reviewer please check)**

1. **age public-key encryption**: CI holds only public keys; the private key lives in the password
   manager (two keys recommended). Exception: the optional automated monthly drill needs a private key
   in the `restore-drill` environment (reviewer-gated, `main` only); off unless
   `RESTORE_DRILL_ENABLED=true`, with the manual drill as the alternative (backup-and-restore.md §5.1).
2. **Separate GitHub environments** `backup` (no required reviewer, else the nightly job would wait for
   approval every night) and `restore-drill`, instead of `production` as environments.md said.
3. **Opt-in variables** so the workflow is green and silent before H-01; once enabled, missing secrets
   fail loudly. Backup alerting = Sentry cron monitor (E-08 tool) + GitHub's failure email.
4. **Manifest in the dump's snapshot**, so a restore can demand exact equality (counts and money).
5. **Proposed RPO/RTO**: PITR RPO ≈ 0 / RTO 1 h; dump RPO 24 h / RTO 4 h (needs the product owner's
   sign-off; BRD §16 support SLA, Q-11). Severities P1–P3 and response times are proposals too.
6. SQL helpers are `.pgsql` because the root `.gitignore` ignores `*.sql` outside `packages/db`
   (legacy-dump guard); I did not touch `.gitignore`.
7. The "every event" Sentry condition is "seen more than 0 times in 1 minute" (events of one message
   group into one issue, so "first seen" would fire once ever); to be confirmed on the first `--apply`.
8. `rollback.md` proposes an **additive-first migration rule** (not enforced by a tool).

**Deviations / shared files**

- `cutover.md` is owned by H-09 (which depends on T-096); this is the draft it fills in (`____` blanks
  for T-092/T-093/T-094/T-086 specifics).
- `environments.md` (T-011's file, inside this task's `docs/runbooks/**`): only §4.9, the §4.10 table
  and one §7 row changed.
- New follow-up task file `tasks/T-096a-health-db-ping-and-cron-check-ins.md`.

**Follow-ups / open questions**

- **T-096a**: `/api/health` still reports `db: not_configured` (T-005 placeholder), so the uptime check
  can't see a dead database; Vercel crons don't check in with Sentry, so a cron that silently stops
  raises nothing (only crashes alert). Until then monitoring.md §6's daily SQL check covers it.
- Support access clicks depend on T-086 (in review): support-access.md §2 has a box to replace.
- The 30-day lifecycle rule covers the whole bucket: keep the 12-month legacy archive (Q-07) in a
  different bucket (cutover.md §4 step 2).
- Product owner: approve RPO/RTO and severities; decide whether the CI restore drill may hold a private
  key (decision 1).

**Verification (definition of done)**: `pnpm install --frozen-lockfile`, `pnpm lint` (Biome: 1,105
files, no fixes), `pnpm typecheck` (forced, 10/10), `pnpm test` and `pnpm build` (10/10 each, turbo
cache hits: this PR changes no package input), `pnpm --filter @cb/core exec vitest run src/invariants`
with DATABASE_URL (3 files, 18 tests), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`,
`node scripts/tasks.mjs check --local`. No apps/web change, so the e2e suite was not run.

## Board log

- 2026-10-14T12:34:57.733Z claimed by agent-t096
- 2026-10-14T13:16:03.451Z completed on task/T-096-backups-monitoring-alerts-and-runbooks

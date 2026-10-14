# Runbook: backups, restore and the monthly restore drill

Who this is for: the engineer on call, and the human doing H-01 (§6). PLAN §17, PRD §11
(Backup/recovery) and §15 #14 ("backup restore and production monitoring checks pass before cutover").

- Scripts: [`backup/`](backup/) (`backup.sh`, `restore-drill.sh`, `verify-restore.ts`, `self-test.sh`)
- Workflow: [`.github/workflows/backup.yml`](../../.github/workflows/backup.yml)
- Drill results: [`restore-log.md`](restore-log.md)
- Rolling back a deploy or a migration (not a restore): [`rollback.md`](rollback.md)

---

## 1. Recovery objectives (proposed, need the product owner's sign-off)

| Failure | How we recover | RPO (data we can lose) | RTO (time to working again) |
|---|---|---|---|
| Bad write, bad migration, an operator's data damaged | **Neon point-in-time restore** of the production branch (§3) | about 0: any moment inside Neon's history window | **1 hour** |
| Neon branch or project lost, Neon account locked, provider outage | **Nightly encrypted `pg_dump`** in our own bucket, restored into a new Neon project (§4) | **24 hours** (the last nightly backup) | **4 hours** |
| Someone needs data as it was on a past day (> Neon window, ≤ 30 days) | Restore that night's dump into a scratch database and read it (§4), never over production | 24 hours | 1 working day |

What the numbers rest on:

- **Neon history window** is set by the Neon plan (H-01 picks a paid plan; environments.md §4.2 says
  "the longest PITR / history retention the plan allows"). Check it in Neon → project → Settings →
  Instant restore / history retention, and write the value here: `____ days` (needs H-01).
- **Dump restore time measured locally** (restore-log.md): the `legacy`-size seed (8 operators, 7,616
  customers, 1.17 million rows, 66 MB encrypted) restored and verified in **44–60 s** on a busy 4-CPU
  container. A Neon restore over the network will be slower; the first real drill (§5) gives the number.
  4 hours leaves room for creating the project, roles, Vercel variables and checks (§4).
- **Phones help the RPO for field payments.** A payment saved on a phone that had not reached the
  office yet is re-sent after the restore (idempotent on its id). But payments that had already reached
  the office after the last backup are marked "Sent to office" on the phone and are **not** re-sent:
  after a dump restore, re-enter them from the linemen's handover records and the receipts (§4 step 9).
- Neon also encrypts data at rest, and the bucket keeps 30 days of dumps (§2).

## 2. What is backed up, where, for how long

| | Neon PITR | Nightly dump |
|---|---|---|
| What | the whole production branch, continuously (WAL) | `pg_dump` of the production database: every schema, incl. drizzle's migration journal |
| When | always | 20:00 UTC = **01:30 IST** daily (after the 00:15 bill scheduler and 00:30 session close, before the 02:30 invariants check) |
| Where | inside Neon | our object-storage bucket (S3 `ap-southeast-1` or Cloudflare R2), **outside Neon** |
| Encrypted | Neon at rest | yes, with **age** to our public key, before upload; only the private key (password manager, never CI except §5) decrypts |
| Kept | Neon plan's window | **30 days** (bucket lifecycle rule, [`backup/lifecycle.json`](backup/lifecycle.json)) + versioning |
| Checked | monthly drill (§5) | every night: `pg_restore --list` reads the dump before upload; monthly drill restores it |

Each nightly object is `production/YYYY/MM/DD/cable-billing-production-<UTC stamp>.tar.age` plus a
`.sha256` sidecar. Inside the encrypted tar:

- `db.dump`: `pg_dump --format=custom`, taken from an **exported snapshot**.
- `manifest.json`: the row count of every table and five money totals (Σ payments, Σ invoice charges,
  Σ ledger, Σ balances, Σ credit) **taken in that same snapshot**, plus the migration journal head,
  versions and sizes. Aggregates only, no personal data. The restore demands equality with it.

Not in the dump: database roles (pg_dump never has them). `backup/roles.pgsql` re-creates `app_rw` and
`app_platform`; the runtime login role `cb_app` is made by hand (environments.md §4.12).

## 3. Restore with Neon point-in-time restore (most incidents)

Use this when production is up but data is wrong (a bad deploy wrote rubbish, a migration went wrong,
someone ran a bad statement). **Financial records are append-only**: first ask whether a reversal or an
adjustment fixes it (invariant-breach.md). A PITR rewinds **every** tenant, so everything written after
the chosen moment (payments, handovers, sign-ups) is lost from the branch and must be re-entered.

> Not yet rehearsed on a real Neon project (none exists before H-01). The Neon Console words below
> are Neon's at the time of writing; correct them on the first rehearsal and note it in restore-log.md.

1. **Declare an incident** (README.md §2). Note the time the damage started, in UTC. Say in the incident
   note who decided to rewind and why.
2. **Stop the cause first.** If a deploy is still writing bad data, roll it back (rollback.md §1)
   before anything else. Every write after the rewind point is lost by the rewind, so keep the time
   between deciding and step 4 short, and write down both times.
3. **Look before you rewind** (no risk to production): Neon → `cable-billing-prod` → Branches → `main`
   → **Create branch** from a point in time just before the damage → connect with psql (owner, direct
   URL) and check that the data you expect is there. Counts and money totals in one line:
   `grep -v '^--' docs/runbooks/backup/manifest.pgsql | psql "<branch URL>" -X -A -t`.
4. **Rewind**: Neon → Branches → `main` → **Restore** → from history, the same timestamp. Neon keeps
   the pre-restore state as a backup branch (note its name in the incident note; delete it only after
   the incident is closed). The connection strings stay the same; open connections are dropped and
   the app reconnects.
5. **Check the books**: queue the invariants check and run it now, by calling the crons by hand
   (CRON_SECRET from the password manager):
   `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<production host>/api/cron/invariants`,
   then the same for `/api/cron/job-worker`. A breach comes back as the usual alert (invariant-breach.md);
   no alert and an `ok` row per tenant in `invariant_checks` means the books add up.
6. **Check the app**: `/api/health` is 200, an Owner signs in, one phone's "Try now" syncs.
7. **Re-enter what was lost** after the rewind point: tell the affected operators (Owner) which time
   window to re-check; phones re-send what they still hold. Write it all in the incident note.
8. Delete the inspection branch from step 3 (it holds real data).

## 4. Restore from a nightly dump (Neon is gone or the window is too short)

Needs: a machine with this repo (`pnpm install` done), `psql`/`pg_restore` 17, `age`, AWS CLI; the age
**private key** from the password manager; read access to the bucket.

1. **Declare an incident.** Decide which backup: normally the newest. List them:
   `aws s3 ls --recursive s3://<bucket>/<prefix>/production/ | tail` (R2: add `--endpoint-url`).
2. **Create the new database**: a new Neon project `cable-billing-prod-restore-<date>` in
   `aws-ap-southeast-1`, Postgres 17 (environments.md §4.2 step 2), or a new branch with an empty
   database if the old project still works. Copy the **owner's direct URL** (no `-pooler`).
3. Put the private key in a file only you can read, outside the repo:
   ```bash
   umask 077; mkdir -p ~/restore && cat > ~/restore/identity.txt   # paste the AGE-SECRET-KEY-… line, Ctrl-D
   ```
4. **Restore and verify** (refuses a non-empty database; all or nothing):
   ```bash
   read -rs TARGET_DATABASE_URL && export TARGET_DATABASE_URL   # owner, direct URL of the NEW database
   export BACKUP_AGE_IDENTITY_FILE=~/restore/identity.txt
   export BACKUP_DEST=s3://<bucket>/<prefix>          # newest backup under production/, or:
   # export BACKUP_FILE=s3://<bucket>/<prefix>/production/2026/11/02/cable-billing-production-….tar.age
   export RESTORE_REPORT=~/restore/report.md
   docs/runbooks/backup/restore-drill.sh
   ```
   Exit 0 = restored and verified (counts, totals and migrations equal the backup's manifest; T-052
   invariants hold for every tenant). Exit 3 = restored but **not** verified: read the report before
   going on. Exit 1/2 = nothing usable was restored (the message says why).
5. **Runtime role**: create `cb_app` on the new database and check it (environments.md §4.12 steps
   1–4). Never point the app at the owner URL.
6. **Apply newer migrations** if the app is newer than the dump (the report shows the journal): run the
   migrations workflow / `pnpm --filter @cb/db db:migrate` with the new owner URL. It applies only the
   missing ones.
7. **Switch Vercel**: Production `DATABASE_URL` = the new `cb_app` pooled URL; update the GitHub
   environments' `DATABASE_URL_UNPOOLED` and `BACKUP_DATABASE_URL` (§6) to the new owner URL;
   redeploy. If the Neon ↔ Vercel integration is linked to the old project, re-check environments.md
   §4.2 step 6.
8. **Check**: `/api/health` 200, an Owner signs in, one phone syncs, crons run (Vercel → Crons).
9. **Recover the gap** (everything after the backup's `snapshot_taken_at`): payments the office had
   already received are not on the server any more. Ask each operator for the receipts and handover
   slips since that time and re-enter them as counter payments; phones re-send only what they still
   hold. Bills: the scheduler's catch-up re-creates a missing run for the current month.
10. Delete `~/restore` (`rm -rf ~/restore`), close the incident, add a row to restore-log.md.

## 5. Monthly restore drill

PLAN §17: once a month, restore a real backup into a scratch target, check it, and record it in
[`restore-log.md`](restore-log.md). It proves the backups can be read, the key works and the
procedure is still right. **Before cutover a drill must have passed** (PRD §15 #14, cutover.md).

### 5.1 Automatic drill (GitHub Actions, after H-01)

`backup.yml` → job **Restore drill** runs on the **8th of each month at 07:30 IST** (never near the
1st, when bills run) and on demand (Actions → Backup → Run workflow → `restore-drill`, optionally a
`backup_file`). It restores the newest backup into a throwaway Postgres 17 container on the runner,
verifies it and uploads `restore-drill-report` (no personal data). Copy the report into
restore-log.md in a small PR. Enable it with the repository variable `RESTORE_DRILL_ENABLED=true`.

Trade-off, decided here (reviewer please check): this needs the age **private key** as a secret of the
GitHub environment `restore-drill` (required reviewer: the product owner, deployment branch `main`
only). The decrypted data exists only inside that job's container. The production database URL already
reaches GitHub runners for the nightly dump, so this does not widen who could read the data; it does
mean a GitHub compromise could also read old backups. If that is not acceptable, leave
`RESTORE_DRILL_ENABLED` off and do the manual drill (§5.2) every month instead.

### 5.2 Manual drill into a Neon scratch branch (the PLAN's wording; do this at least before cutover)

1. Neon → `cable-billing-prod` → Branches → **Create branch** `restore-drill-YYYYMMDD` from `main`
   (head). Open the SQL editor **on that branch** and run `CREATE DATABASE restore_drill;` (the branch
   holds a copy of production in `neondb`; the drill needs an **empty** database, so it restores into
   `restore_drill`, which belongs to the same owner role and sees the same roles).
2. Copy that branch's owner **direct** URL and change the database name to `restore_drill`.
3. Run §4 steps 3–4 with that URL as `TARGET_DATABASE_URL` (newest backup).
4. Paste `RESTORE_REPORT` into restore-log.md (it records times, counts and results, never the URL).
5. **Delete the branch** (Neon → Branches → `restore-drill-YYYYMMDD` → Delete) and `rm -rf ~/restore`.
   A scratch branch holds real customer data: never leave it, never give it to a preview.

### 5.3 What "passed" means

`restore-drill.sh` exits 0 and the report says **PASS**: the checksum matched, the backup decrypted,
`pg_restore` succeeded in one transaction, every table's row count and the five money totals equal
the backup's own manifest, the migration journal is the same, and `checkTenantInvariants` (T-052) found
0 violations in every tenant. Also note the total time: it is our RTO evidence for §1. A FAIL is an
incident (README.md §2): find out why before the next nightly backup is relied on.

The mechanism itself is tested on every PR that touches it (`backup.yml` → Backup self-test,
[`backup/self-test.sh`](backup/self-test.sh)): a seeded database is backed up and restored, and a
damaged file, a wrong key, a non-empty target and deliberately broken books must each fail.

## 6. Setting it up (H-01)

Do these after environments.md §4.2 (Neon) and §4.9 (bucket). Until then the workflow's backup and
drill jobs are skipped (their variables are off), and only the self-test runs.

1. **Encryption keys** (on your own machine, `age` installed):
   ```bash
   age-keygen -o cable-billing-backup.key      # prints "Public key: age1…"
   ```
   Store the whole file in the password manager entry "Cable Billing backup key (age)", then delete
   it from disk. Make a **second** key the same way for a second person (or an offline copy) so
   losing one person does not lose every backup. Both public keys go into `BACKUP_AGE_RECIPIENTS`
   (space-separated); either private key can decrypt.
2. **Bucket** (environments.md §4.9): private, versioning on, lifecycle 30 days from
   [`backup/lifecycle.json`](backup/lifecycle.json):
   `aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://docs/runbooks/backup/lifecycle.json`
   (R2: dashboard → bucket → Settings → Object lifecycle rules → delete after 30 days). Two access
   keys: **backup-writer** (PutObject only, on `<prefix>/*`) and **backup-reader** (GetObject +
   ListBucket, for drills and restores).
3. **GitHub environments** (repo → Settings → Environments):

   | Environment | Protection | Secrets | Variables |
   |---|---|---|---|
   | `backup` | deployment branch `main` only; **no** required reviewer (it runs nightly) | `BACKUP_DATABASE_URL` (prod owner, **direct**), `BACKUP_S3_ACCESS_KEY_ID` + `BACKUP_S3_SECRET_ACCESS_KEY` (backup-writer), `BACKUP_SENTRY_CRON_URL` (monitoring.md §2) | `BACKUP_S3_URI` (`s3://<bucket>/<prefix>`), `BACKUP_S3_REGION` (`ap-southeast-1`; R2: `auto`), `BACKUP_S3_ENDPOINT` (R2 only: `https://<account>.r2.cloudflarestorage.com`), `BACKUP_AGE_RECIPIENTS` |
   | `restore-drill` | deployment branch `main` only; required reviewer = product owner | `BACKUP_AGE_IDENTITY` (one private key file's contents), `BACKUP_S3_ACCESS_KEY_ID` + `BACKUP_S3_SECRET_ACCESS_KEY` (backup-reader) | `BACKUP_S3_URI`, `BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT` |

   Also set `CB_SEED_FORBIDDEN=1` as a variable on both (environments.md §4.13).
4. **Turn it on**: repository variable `BACKUP_ENABLED=true` (and `RESTORE_DRILL_ENABLED=true` if you
   accept §5.1). Scheduled runs only happen on the default branch, so the nightly backup starts once
   `backup.yml` is on `main`.
5. **First run by hand**: Actions → Backup → Run workflow → `backup`. The job summary shows the object;
   check it is in the bucket. Then run `restore-drill` (or §5.2) and record it in restore-log.md.
6. **Alerting**: create the Sentry cron monitor and put its check-in URL in `BACKUP_SENTRY_CRON_URL`
   (monitoring.md §2). GitHub also emails the workflow's last editor when a scheduled run fails.

## 7. When the backup alert fires

The Sentry monitor `nightly-backup` says the backup **missed** (no check-in by 21:00 UTC) or
**failed**. GitHub's failure email may arrive too.

1. Actions → Backup → the latest "Nightly backup" run → read the failed step.
   - *Check the configuration* failed: a secret or variable is missing (§6).
   - *Back up* failed with `pg_dump … older than the server`: Neon moved to a newer Postgres major;
     bump `PG_MAJOR` in `backup/install-tools.sh` and the `postgres:` images in `backup.yml`.
   - `could not export a snapshot` / connection errors: is `BACKUP_DATABASE_URL` the **direct** URL and
     is the password current (environments.md §7 "Owner password")? Is Neon up?
   - `aws` errors (`AccessDenied`, `NoSuchBucket`): the writer key or bucket name (§6).
   - No run at all: `BACKUP_ENABLED` is not `true`, the workflow is not on `main`, or GitHub disabled
     the schedule (it does after 60 days without repository activity: re-enable it in Actions).
2. Fix it and run the workflow by hand (`backup`). Neon PITR still covers production meanwhile, so one
   missed night is a P2; **two** missed nights, or a failed drill, is a P1.
3. Write a line in the incident note (README.md §2).

## 8. Rotating the backup keys

Write each rotation in the password-manager entry (date, what, who), like environments.md §7.

| Key | How | Watch out |
|---|---|---|
| age key pair (encryption) | Make a new pair (§6 step 1). Set `BACKUP_AGE_RECIPIENTS` to the **new** public key(s) and, if the drill runs in CI, `BACKUP_AGE_IDENTITY` to the new private key. | **Keep the old private key for 30 days** (until the last backup made with it expires), and for as long as any long-kept archive (cutover.md §4 step 2) is encrypted with it. If a private key leaked: rotate at once and treat every backup it can open as exposed (incident). |
| Bucket keys (writer / reader) | Create the new key, update the GitHub environment secret, run the workflow by hand, then delete the old key. | The writer key must never be able to delete or list. |
| `BACKUP_DATABASE_URL` | Changes when the Neon owner password is reset (environments.md §7 "Owner password"): update it together with `DATABASE_URL_UNPOOLED`. | A wrong value fails that night's backup (alert, §7). |
| `BACKUP_SENTRY_CRON_URL` | Changes only if the DSN key changes (monitoring.md §2 step 4). | Until updated, the monitor reports a miss every night. |

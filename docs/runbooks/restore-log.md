# Restore log

Every restore drill and every real restore gets an entry here, newest first (PLAN §17, PRD §15 #14).
Paste the report `restore-drill.sh` prints (it never contains a database URL or personal data), then
add what the drill proves and what it does not. How to run a drill: [backup-and-restore.md §5](backup-and-restore.md#5-monthly-restore-drill).

| Date (IST) | Kind | Backup restored | Target | Result | Total time | By |
|---|---|---|---|---|---|---|
| 2026-10-14 | Mechanism rehearsal (T-096), **fake seed data** | local `backup.sh` output, `legacy` seed | local Postgres 17 scratch DB | PASS | 44 s | agent-t096 |
| 2026-10-14 | Mechanism rehearsal (T-096), fake seed data, non-superuser owner | local `backup.sh` output, `small` seed | local Postgres 17 scratch DB | PASS | 9 s | agent-t096 |
| 2026-10-14 | Mechanism rehearsal (T-096), fake seed data | local `backup.sh` output, `small` seed | local Postgres 17 scratch DB | PASS | 8 s | agent-t096 |

**Still to do (needs H-01):** the first drill of a **real production backup** from the bucket into a
**Neon scratch branch** (backup-and-restore.md §5.2). It is required before cutover (cutover.md, PRD
§15 #14). Until it is done, nothing below proves our real backups can be restored.

---

## 2026-10-14: mechanism rehearsal at legacy size (T-096)

- **What this proves:** the scripts work end to end at the legacy system's size: `backup.sh` (exported
  snapshot → `pg_dump` → manifest → age encryption → `.sha256` sidecar) and `restore-drill.sh`
  (checksum → decrypt → roles → `pg_restore` in one transaction → counts, totals, migrations and the
  T-052 invariants for every tenant).
- **What it does not prove:** anything about Neon, the real bucket, the real keys or real data. Source
  and target were scratch databases on one local Postgres 17.11 (a busy 4-CPU container shared with
  other jobs), the "bucket" a local folder, the age key a throwaway made for the test.
- **Source:** `pnpm db:seed --migrate --scale legacy --as-of 2026-10-14` (T-036 fake data: 8 operators,
  7,616 customers, 23 months). Backup: 18 s, 66,279,416 bytes encrypted, 586 TOC entries. (A first run
  of the same rehearsal, before the default-privileges change below, also passed in 60 s.)

### 2026-10-14 restore of `cable-billing-legacy-drill-20261014T130558Z.tar.age`: **PASS**

| | |
|---|---|
| Snapshot taken (UTC) | 2026-10-14T13:05:58Z |
| Restored at (UTC) | 2026-10-14T13:07:07Z |
| Target | Postgres 17, pg_restore 17 |
| Fetch + checksum | 1 s |
| Decrypt + unpack | 0 s |
| pg_restore + ANALYZE | 33 s |
| Verify | 10 s |
| **Total (restore time, RTO evidence)** | **44 s** |

Verification: **PASS**

| Check | Restored copy | Result |
|---|---|---|
| Tables and row counts | 38 tables, 1174912 rows | equal to the backup manifest |
| Money totals (5 sums) | equal | payments, invoice charges, ledger, balances, credit |
| Migrations | 16 applied | same journal as the backup |
| Invariants (T-052) | 8 tenants checked | 0 violations |


## 2026-10-14: mechanism rehearsal as a non-superuser owner (T-096)

Neon's owner role (`neondb_owner`) is not a superuser, so the `small` backup was also restored by a
local role with only `LOGIN CREATEDB CREATEROLE` that owns the target database and holds ADMIN on
`app_rw`/`app_platform` (as Neon's owner does after running migration 0000).

- First attempt **failed** (exit 1, nothing restored): the dump's `ALTER DEFAULT PRIVILEGES FOR ROLE
  postgres …` can only be replayed by that same role. Fixed in `restore-drill.sh`: it skips the dump's
  `DEFAULT ACL` entries and `post-restore.pgsql` re-creates migration 0000's default privileges for the
  restoring owner. Checked afterwards in `pg_default_acl`: tables `app_rw=arwd`, `app_platform=arwd`;
  sequences `rU` for both, granted by the new owner.
- Second attempt: **PASS** in 9 s (38 tables, 12,783 rows equal; 5 money totals equal; 16
  migrations; 3 tenants, 0 violations).
- Before that, without ADMIN on the app roles, `roles.pgsql` stopped the restore with "permission
  denied to grant role app_rw" (exit 1, nothing restored). On Neon the owner created those roles, so it
  has ADMIN; on a server where someone else made them, a superuser must grant them first.

## 2026-10-14: mechanism rehearsal and failure cases (T-096)

`small` seed (3 operators, 150 customers, 12 months). `self-test.sh` (the same as CI's "Backup
self-test" job):

| Case | Exit | Result |
|---|---|---|
| 1. backup → restore → verify | 0 | PASS: 38 tables / 12,783 rows, 5 totals, 16 migrations, 3 tenants 0 violations, about 10 s |
| 2. a damaged backup file (one byte appended) | 1 | refused: checksum mismatch; 0 tables in the target |
| 3. the wrong age key | 1 | refused: could not decrypt; 0 tables in the target |
| 4. a target that already has tables | 2 | refused before writing anything |
| 5. books broken in the source (one balance off by ₹1) | 3 | restored, verification FAIL: `BALANCE_MISMATCH 1` |

The `s3://` code paths (upload layout, choosing the newest object, download) were exercised against a
stand-in `aws` command that maps the bucket to a folder: two backups uploaded under
`production/2026/10/14/`, the drill picked the newer one and passed. The real AWS CLI and bucket were
not used.

After the restore, `pnpm --filter @cb/db db:migrate` against the restored copy applied nothing (16
migrations in the journal before and after): the app's migration tooling accepts a restored database
as up to date. The whole file was re-run with the final scripts (self-test 47 s, all cases as above).

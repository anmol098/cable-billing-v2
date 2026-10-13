# Legacy migration: staging and profiling

How to load the legacy MariaDB dump on a secure machine, copy it into a Postgres `legacy` schema,
and produce the counts-only profile `docs/migration/profile-<date>.md` (PLAN §15 step 1, T-090).
The tooling lives in `tools/migration` (`@cb/migration`).

> **The dump holds real customer data (D-09).** It never goes into git, a chat, a ticket or CI.
> Only a human with access runs these steps, on their own machine or a secure runner. The only
> output that may be committed is the profile, which is counts only and is checked for personal data
> automatically before it is written.

## What you need

- Node 24 and pnpm (see the repository `CLAUDE.md`), then `pnpm install` at the repository root.
- Docker (for the staging MariaDB), or a local MariaDB 10.x and its `mariadb` client.
- A Postgres to copy into: a local Postgres 17 for a first look, or a **non-production** Neon branch
  for the real rehearsal (see [Where the copy may go](#where-the-copy-may-go)).
- The dump file, kept **outside the repository** (for example `~/secure/legacy-2026-10.sql.gz`) or
  inside `tools/migration/data/`, which is git-ignored.

## Run it end to end

All commands run from the repository root.

```bash
# 1. Start the staging MariaDB (127.0.0.1:3307, data in the docker volume cb-legacy-mariadb).
docker compose -f tools/migration/docker-compose.yml up -d --wait

# 2. Restore the dump into a fresh database `legacy` (.sql, .sql.gz or .sql.zst).
tools/migration/restore.sh ~/secure/legacy-2026-10.sql.gz
#    no Docker? use a local MariaDB:  LEGACY_DB_PORT=3306 tools/migration/restore.sh --local <dump>

# 3. Copy every table, raw, into the `legacy` schema of the target Postgres.
export MIGRATION_TARGET_URL=postgres://postgres:postgres@localhost:5432/cb_legacy_stage
createdb -h localhost -U postgres cb_legacy_stage   # once, for a local target
pnpm --filter @cb/migration legacy:copy
#    LEGACY_DB_URL defaults to mysql://root:legacy-local-only@127.0.0.1:3307/legacy (the compose service)

# 4. Profile it. Writes docs/migration/profile-<today in IST>.md, or nothing if the PII check fails.
pnpm --filter @cb/migration legacy:profile

# 5. Read the profile, then commit it on a task branch (it is counts only).
#    Re-check a file at any time (add --with-data to check against the copied values too):
pnpm --filter @cb/migration legacy:check docs/migration/profile-2026-10-13.md

# 6. When you are done with the dump for now:
docker compose -f tools/migration/docker-compose.yml down --volumes
```

Every command has `--help`. Exit codes: `0` done, `1` failed, `2` refused (guard or bad arguments),
`3` personal data found (`legacy:profile` then writes nothing).

Re-running is safe: `restore.sh` drops and recreates the MariaDB database, `legacy:copy` replaces
each table in its own transaction (and removes tables that are no longer in the source), and
`legacy:profile` overwrites the day's file.

## Trying it without the real dump

A synthetic fixture with the documented table names and **fake** data is generated on demand:

```bash
pnpm --filter @cb/migration legacy:fixture                 # small: 3 operators, 150 customers
pnpm --filter @cb/migration legacy:fixture --scale legacy  # PRD App. A counts (146,224 invoices)
tools/migration/restore.sh tools/migration/data/fixture-small.sql
```

Then continue with steps 3 and 4. Only these table and column names come from the docs: `operator`,
`costumer`, `vc`, `invoice`, `ledger`, `lineman`, `plan`, `recharge`, `op_id`, `isReceipt`,
`isDeleted`, the nullable invoice customer reference and FLOAT ledger amounts. **Every other column
in the fixture is invented**; the real names arrive with the first real profile.

## What each step does

### `restore.sh`

- Accepts a dump only if it is **outside the repository**, or inside `tools/migration/data/` *and*
  git-ignored *and* not tracked. Any other path in the repository is refused (exit 2), so a dump
  can never sit next to tracked files. `--dry-run` runs only these checks.
- Drops and recreates the database (`LEGACY_DB_NAME`, default `legacy`) and loads the dump with a
  relaxed `sql_mode`, so zero dates (`0000-00-00`) restore unchanged.
- Warns when the dump contains `USE` / `CREATE DATABASE` (a `mysqldump --databases` dump), because
  its tables then land in the database the dump names: set `LEGACY_DB_NAME` and `LEGACY_DB_URL` to
  that name.

### `legacy:copy`

- Reads every base table of `LEGACY_DB_URL` (local hosts only, unless `--allow-remote-source`) and
  writes it to `legacy.<table>` in `MIGRATION_TARGET_URL`, keeping table and column names exactly
  (`legacy.costumer."isReceipt"` …).
- The copy is **raw**: integers → `bigint`, FLOAT/DOUBLE → `double precision`, DECIMAL → `numeric`,
  dates and times → **`text` as MariaDB printed them** (Postgres has no zero date; converting would
  hide them), text/ENUM/SET → `text`, binary → `bytea`. NUL characters, which Postgres text cannot
  hold, are removed and counted per column. Transforms (T-092/T-093) interpret the values later.
- Each table is copied in one transaction and its row count is checked against the source.
- Metadata next to the data: `legacy._copy_columns` (each column's MariaDB type, used by the
  profiler), `legacy._copy_tables` (row counts) and `legacy._copy_runs` (one row per run).
- `REVOKE ALL ON SCHEMA legacy FROM PUBLIC`: the app's runtime role (`cb_app`) can never read it.

### `legacy:profile`

Counts only, from aggregate queries over the `legacy` schema:

| Section | What it counts |
|---|---|
| Tables | rows per table, against the PRD Appendix A baseline |
| Rows per operator | rows per legacy `op_id` in every table that has one, null and unknown operators, and whether the groups add up to the total (the known off-by-one, PRD App. A) |
| References | null, zero (`0`/empty) and orphan references: every table → operator, vc/invoice/ledger → costumer, invoice → lineman/recharge, ledger/recharge → vc, vc/recharge → plan |
| Duplicates | customer codes, VC numbers and invoice numbers per operator; lineman logins and operator display names globally (trimmed, case-insensitive) |
| Dates | zero dates, invalid dates (`2019-00-10`), earliest and latest valid value |
| Numbers | negative, zero, fractional, more than 2 decimals (finer than a paisa) and whole-hundred values for float/decimal columns and money-named integer columns |
| Status values | distinct values of status-like columns (flags such as `isReceipt`, `status`/`type`/`mode` …), filtered as below |
| Columns | per column: MariaDB type, primary key, class, null, blank and distinct counts |

The reference and duplicate checks need column names that are not documented yet. They use
candidate lists in `tools/migration/src/config.ts` (for example the customer reference is the first
of `customer`, `costumer`, `customer_id`, `cust_id` … that exists). The profile says which column it
used, or "not checked" with the candidates it tried. After the first real run, put the real names
first in those lists (T-091 maps them properly).

## How personal data is kept out of the profile

The acceptance criterion for T-090 is that the profile contains no names, phone numbers, addresses
or passwords, checked automatically. Four layers:

1. **Counts only by construction.** The profile data structure (`src/profile/types.ts`) has no field
   that can hold a row's text: only numbers, table and column names, legacy operator ids, and status
   values that passed layer 3.
2. **Sensitive columns are never listed.** Columns are classified by name (`src/profile/classify.ts`;
   `customerName`, `cust_mobile2`, `addr1`, `passwd`, `remark` … all match). Sensitive columns get
   counts only, not even earliest/latest dates.
3. **Status values are filtered.** A distinct value is shown only if the column has at most 25
   distinct values, at least 5 rows use the value, it is a short code (letters, digits, `_.-`, at
   most two words of 16 characters), it has no phone/e-mail/hash shape, and it does not occur as a
   value (or, for name columns, as a single word) in any identifying column of the data. Everything
   else is counted as "held back". The same filter applies to operator ids.
4. **The finished file is scanned** (`src/pii/scan.ts`) before it is written:
   - shapes: Indian mobile numbers (with or without +91/0 and a space), e-mail addresses, password
     hashes and tokens (long hex, bcrypt/argon2/crypt prefixes), runs of 9+ digits and 4-4-4 digit
     groups (Aadhaar);
   - values: every distinct value of every identifying column in the copied data (names, phones,
     addresses, logins, passwords, tokens …) and every word of person-name columns, matched as whole
     words after lower-casing and dropping punctuation. Values shorter than 4 characters, digit-only
     values shorter than 8 and values equal to a table or column name are ignored.

   If anything matches, `legacy:profile` writes nothing and exits 3. The message names the line and
   the column the value came from, never the value.

The tests prove it on the synthetic fixture, which plants personal data where a careless profiler
would print it (a phone number and a full name in `costumer.status`, a lineman's first name in 5+ rows
of `vc.status`, phone numbers in invoice remarks, plaintext and hashed passwords): the profile must
contain none of the fixture's personal values (checked independently, by substring), and the scanner
must catch a name, password, address or phone number appended to a finished profile.

The check errs on the side of refusing. If it refuses a real profile, read the named line: a real
leak is a bug in the profiler; a false alarm (an identifying value that happens to equal a word of
the report's own text, such as a lineman password that is literally `zero`) should be reported so the scanner can be
tuned. Never edit the report by hand to get past the check.

## Where the copy may go

`legacy:copy`, `legacy:profile` and `legacy:check --with-data` read the target from
`MIGRATION_TARGET_URL` only (never `DATABASE_URL`, so a URL left in your shell for other work is
never used by accident) and refuse to run unless **all** of these hold (`src/target.ts`):

1. Not a production environment: `VERCEL_ENV=production`, `NODE_ENV=production` or
   `CB_MIGRATION_FORBIDDEN=1` refuse, with no override.
2. A `postgres://` URL whose host, database and user names do not contain the words `prod`,
   `production` or `live`.
3. A local host (`localhost`, `127.0.0.1`, `::1`), or exactly the host passed with
   `--allow-remote <host>`.
4. A remote database must **declare itself non-production**: the database setting
   `cb.migration_target` must be `non-prod`. Set it once on the Neon migration branch:

   ```sql
   ALTER DATABASE neondb SET cb.migration_target = 'non-prod';
   ```

   The production project never has this setting, so even a production URL passed with
   `--allow-remote` is refused.

**Which Neon branch.** Use a dedicated branch in the **non-prod** project, for example
`migration-rehearsal`, made from `staging`. Do not copy legacy data into `staging` itself or any branch
that preview branches are made from: previews would inherit real customer data
(`docs/runbooks/environments.md` keeps previews to seed data only). Delete the branch when the
rehearsal is over. The final import into production (H-09) is a separate, gated step (T-092+).

## Running the tests

```bash
pnpm --filter @cb/migration test
```

- Unit tests (guards, scanner, classifier, type mapping, fixture, `restore.sh` path rules) always run.
- The Postgres pipeline test uses `DATABASE_URL` (CI's Postgres service; locally
  `postgres://postgres:postgres@localhost:5432/cable_billing`) and creates and drops its own
  `cb_mig_test_*` database. `CB_SKIP_DB_TESTS=1` skips it.
- The MariaDB tests (real restore with `restore.sh --local`, `MariaDbSource`, and "the profile from
  MariaDB equals the profile from the in-memory fixture") run only when `LEGACY_TEST_MARIADB_URL` is
  set, e.g. `mysql://root:legacy-local-only@127.0.0.1:3307/`. CI has no MariaDB, so they are skipped
  there with a warning.

## Files

| Path | What |
|---|---|
| `tools/migration/docker-compose.yml` | staging MariaDB 10.11, bound to 127.0.0.1:3307 |
| `tools/migration/restore.sh` | dump → MariaDB, with the path rules |
| `tools/migration/src/config.ts` | documented tables, baseline counts, candidate column names, classification words |
| `tools/migration/src/target.ts` | the production guard |
| `tools/migration/src/source/` | `MariaDbSource` (mysql2) and `MemorySource` (fixture) |
| `tools/migration/src/copy/` | raw copy into the `legacy` schema |
| `tools/migration/src/profile/` | catalog, classification, aggregate queries, markdown |
| `tools/migration/src/pii/` | forbidden values from the data, and the scanner |
| `tools/migration/src/fixture/` | synthetic fixture and its mysqldump-style writer |
| `tools/migration/data/` | git-ignored: dumps and generated fixtures |

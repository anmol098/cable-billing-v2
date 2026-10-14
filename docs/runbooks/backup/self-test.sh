#!/usr/bin/env bash
# Self-test of the backup and restore mechanism (T-096), against a LOCAL or CI Postgres only.
# Proves that backup.sh + restore-drill.sh restore a seeded database exactly, AND that the drill
# fails loudly when it should:
#   1. backup → restore into an empty DB → PASS (counts, totals, migrations, invariants)
#   2. a damaged backup file           → refused (checksum mismatch), nothing restored
#   3. the wrong age key               → refused (decrypt fails), nothing restored
#   4. a target that already has tables → refused before anything is written
#   5. books broken in the source (one customer_balances row off by ₹1) → restored, verification
#      FAILS with BALANCE_MISMATCH (exit 3)
#
# Environment:
#   ADMIN_DATABASE_URL  required: superuser URL of the maintenance DB, e.g.
#                       postgres://postgres:postgres@localhost:5432/postgres (no query string).
#   SOURCE_DB           required: a migrated + seeded database on that server (`pnpm db:seed --migrate`).
#                       It is only read (and used as a template), never changed.
#   SELF_TEST_PREFIX    optional, default `bk_selftest`: prefix of the scratch databases it creates
#                       and drops.
# Refuses any host other than localhost / 127.0.0.1. Exit 0 = every expectation held.
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:---client-min-messages=warning}"
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL}" "${SOURCE_DB:?set SOURCE_DB}"
case "$ADMIN_DATABASE_URL" in
  *@localhost:* | *@localhost/* | *@127.0.0.1:* | *@127.0.0.1/*) ;;
  *) echo "self-test: refusing a non-local server" >&2; exit 2 ;;
esac
[[ "$ADMIN_DATABASE_URL" != *\?* ]] || { echo "self-test: no query string in ADMIN_DATABASE_URL" >&2; exit 2; }
prefix="${SELF_TEST_PREFIX:-bk_selftest}"
[[ "$prefix" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "self-test: bad SELF_TEST_PREFIX" >&2; exit 2; }
base="${ADMIN_DATABASE_URL%/*}"
url() { printf '%s/%s' "$base" "$1"; }
admin() { psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "$1"; }
fresh_db() { admin "DROP DATABASE IF EXISTS $1 WITH (FORCE)"; admin "CREATE DATABASE $1"; }

work=$(mktemp -d)
cleanup() {
  for db in "${prefix}_restore" "${prefix}_nonempty" "${prefix}_breach_src" "${prefix}_breach_restore" "${prefix}_bad"; do
    admin "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

age-keygen -o "$work/key.txt" 2>/dev/null
age-keygen -o "$work/other-key.txt" 2>/dev/null
pub=$(age-keygen -y "$work/key.txt")

results=()
failed=0
expect() { # expect <name> <wanted exit> <got exit> [<log file> <pattern>]
  local ok=1
  [[ "$3" == "$2" ]] || ok=0
  if ((ok)) && [[ -n "${4:-}" ]]; then grep -q -- "$5" "$4" || ok=0; fi
  if ((ok)); then results+=("| $1 | $3 | ok |"); else results+=("| $1 | $3 (wanted $2) | **FAILED** |"); failed=1; fi
}
run_backup() { # run_backup <db> <dest>
  DATABASE_URL=$(url "$1") BACKUP_AGE_RECIPIENTS="$pub" BACKUP_DEST="$2" BACKUP_ENV_NAME=selftest \
    BACKUP_GIT_SHA="${GITHUB_SHA:-}" bash "$here/backup.sh" | tail -n 1
}
run_restore() { # run_restore <target db> <file> <identity> <log>; prints the exit code
  set +e
  TARGET_DATABASE_URL=$(url "$1") BACKUP_FILE="$2" BACKUP_AGE_IDENTITY_FILE="$3" \
    RESTORE_REPORT="$work/report-$1.md" GITHUB_STEP_SUMMARY="" bash "$here/restore-drill.sh" >"$4" 2>&1
  local status=$?
  set -e
  echo "$status"
}
tables_in() { psql "$(url "$1")" -X -A -t -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"; }

# 1. The happy path.
file=$(run_backup "$SOURCE_DB" "$work/store")
fresh_db "${prefix}_restore"
status=$(run_restore "${prefix}_restore" "$file" "$work/key.txt" "$work/1.log")
expect "1. backup → restore → verify" 0 "$status" "$work/1.log" "Verification: \*\*PASS\*\*"
[[ "$status" == "0" ]] && cat "$work/report-${prefix}_restore.md"

# 2. A damaged file (one byte appended; the sidecar checksum is the original one).
mkdir -p "$work/bad"
cp "$file" "$file.sha256" "$work/bad/"
printf 'x' >>"$work/bad/$(basename "$file")"
fresh_db "${prefix}_bad"
status=$(run_restore "${prefix}_bad" "$work/bad/$(basename "$file")" "$work/key.txt" "$work/2.log")
expect "2. damaged backup file is refused" 1 "$status" "$work/2.log" "checksum mismatch"
expect "2. … and nothing was restored" 0 "$(tables_in "${prefix}_bad")"

# 3. The wrong private key.
fresh_db "${prefix}_bad"
status=$(run_restore "${prefix}_bad" "$file" "$work/other-key.txt" "$work/3.log")
expect "3. wrong age key is refused" 1 "$status" "$work/3.log" "could not decrypt"
expect "3. … and nothing was restored" 0 "$(tables_in "${prefix}_bad")"

# 4. A target that is not empty (the database restored in step 1).
status=$(run_restore "${prefix}_restore" "$file" "$work/key.txt" "$work/4.log")
expect "4. non-empty target is refused" 2 "$status" "$work/4.log" "restore needs an empty one"

# 5. Broken books in the source must be caught by the drill's invariants check.
admin "DROP DATABASE IF EXISTS ${prefix}_breach_src WITH (FORCE)"
admin "CREATE DATABASE ${prefix}_breach_src TEMPLATE $SOURCE_DB"
psql "$(url "${prefix}_breach_src")" -X -q -v ON_ERROR_STOP=1 -c \
  "UPDATE customer_balances SET balance_paise = balance_paise + 100
   WHERE customer_id = (SELECT customer_id FROM customer_balances ORDER BY customer_id LIMIT 1)"
breach_file=$(run_backup "${prefix}_breach_src" "$work/store-breach")
fresh_db "${prefix}_breach_restore"
status=$(run_restore "${prefix}_breach_restore" "$breach_file" "$work/key.txt" "$work/5.log")
expect "5. broken books are restored but FAIL verification" 3 "$status" "$work/5.log" "BALANCE_MISMATCH 1"

{
  echo "### Backup/restore self-test"
  echo
  echo "| Case | Exit code / tables | Result |"
  echo "|---|---|---|"
  printf '%s\n' "${results[@]}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
if ((failed)); then
  for f in "$work"/*.log; do echo "--- $f"; tail -n 20 "$f"; done
  exit 1
fi

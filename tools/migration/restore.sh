#!/usr/bin/env bash
# Restores a legacy MariaDB dump into the local staging MariaDB (T-090, PLAN §15 step 1).
# How to run the whole staging + profiling flow: docs/migration/README.md.
#
# The dump holds real customer data (D-09). It must live OUTSIDE the repository, or inside the
# git-ignored tools/migration/data/. Any other path inside the repository is refused, so a dump
# can't end up next to tracked files and be committed by accident.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/migration/restore.sh [--local] [--dry-run] DUMP

Restores DUMP (.sql, .sql.gz or .sql.zst) into a fresh database (default "legacy") on the staging
MariaDB. DUMP must be outside the repository or inside tools/migration/data/ (git-ignored).

  --local    use the `mariadb` client on this machine (LEGACY_DB_HOST/PORT/USER/PASSWORD) instead
             of the docker compose service
  --dry-run  check the dump path and print what would run; touch nothing

Environment (defaults match tools/migration/docker-compose.yml):
  LEGACY_DB_HOST      127.0.0.1           (--local only)
  LEGACY_DB_PORT      3307                (--local only)
  LEGACY_DB_USER      root
  LEGACY_DB_PASSWORD  legacy-local-only   (local-only container password, not a secret)
  LEGACY_DB_NAME      legacy

Exit codes: 0 restored, 1 failed, 2 refused (bad path or arguments).
EOF
}

refuse() {
  echo "restore.sh: $*" >&2
  exit 2
}

mode="docker"
dry_run=0
dump=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) mode="local" ;;
    --dry-run) dry_run=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) refuse "unknown option $1 (see --help)" ;;
    *)
      [[ -z "$dump" ]] || refuse "only one dump file, please"
      dump="$1"
      ;;
  esac
  shift
done
[[ -n "$dump" ]] || {
  usage >&2
  exit 2
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dir="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || (cd "$script_dir/../.." && pwd -P))"
repo_dir="$(cd "$repo_dir" && pwd -P)"
data_dir="$script_dir/data"

[[ -f "$dump" ]] || refuse "no such file: $dump"
[[ -r "$dump" ]] || refuse "cannot read: $dump"
dump_path="$(cd "$(dirname "$dump")" && pwd -P)/$(basename "$dump")"

# ---- Where the dump may live ------------------------------------------------------------------
case "$dump_path" in
  "$repo_dir"/*)
    case "$dump_path" in
      "$data_dir"/*) ;;
      *) refuse "the dump is inside the repository ($dump_path). Keep it outside the repository or in tools/migration/data/ (git-ignored)." ;;
    esac
    if ! git -C "$repo_dir" check-ignore -q "$dump_path" 2>/dev/null; then
      refuse "$dump_path is not git-ignored. tools/migration/data/ must stay in .gitignore."
    fi
    if git -C "$repo_dir" ls-files --error-unmatch "$dump_path" >/dev/null 2>&1; then
      refuse "$dump_path is tracked by git. Remove it from the index (git rm --cached) first."
    fi
    ;;
esac

case "$dump_path" in
  *.sql) reader=(cat) ;;
  *.sql.gz | *.gz) reader=(gzip -dc) ;;
  *.sql.zst | *.zst) reader=(zstd -dc) ;;
  *) refuse "unsupported dump type (expected .sql, .sql.gz or .sql.zst): $dump_path" ;;
esac

db_name="${LEGACY_DB_NAME:-legacy}"
[[ "$db_name" =~ ^[A-Za-z0-9_]+$ ]] || refuse "LEGACY_DB_NAME may only contain letters, digits and _"
db_user="${LEGACY_DB_USER:-root}"
export MYSQL_PWD="${LEGACY_DB_PASSWORD:-legacy-local-only}"

compose_file="$script_dir/docker-compose.yml"
if [[ "$mode" == "docker" ]]; then
  client=(docker compose -f "$compose_file" exec -T -e MYSQL_PWD mariadb mariadb -u "$db_user")
else
  client=(mariadb --protocol=TCP -h "${LEGACY_DB_HOST:-127.0.0.1}" -P "${LEGACY_DB_PORT:-3307}" -u "$db_user")
fi

echo "dump:     $dump_path"
echo "target:   database \`$db_name\` via ${mode} ($(printf '%q ' "${client[@]}"))"
if [[ "$dry_run" == 1 ]]; then
  echo "dry run:  path checks passed; nothing restored"
  exit 0
fi

if [[ "$mode" == "docker" ]]; then
  docker compose -f "$compose_file" up -d --wait mariadb
fi

# A dump made with `mysqldump --databases` switches database itself; say so instead of guessing.
if (set +o pipefail; "${reader[@]}" "$dump_path" | head -c 5000000 | grep -qiE '^(USE |CREATE DATABASE)'); then
  echo "warning:  the dump contains USE / CREATE DATABASE statements, so its tables may land in" >&2
  echo "          that database instead of \`$db_name\`. Set LEGACY_DB_NAME (and LEGACY_DB_URL for the" >&2
  echo "          copy step) to the database the dump names." >&2
fi

"${client[@]}" -e "DROP DATABASE IF EXISTS \`$db_name\`; CREATE DATABASE \`$db_name\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
{
  # Legacy data has zero dates; strict modes would reject them.
  echo "SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';"
  "${reader[@]}" "$dump_path"
} | "${client[@]}" --max-allowed-packet=1G "$db_name"

tables="$("${client[@]}" -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$db_name'")"
echo "restored: $tables tables into \`$db_name\`"
echo "next:     MIGRATION_TARGET_URL=postgres://… pnpm --filter @cb/migration legacy:copy"

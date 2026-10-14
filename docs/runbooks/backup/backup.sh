#!/usr/bin/env bash
# Nightly logical backup (PLAN §17, T-096): pg_dump → age-encrypted archive → object storage.
#
# What it makes: one file `cable-billing-<env>-<UTC stamp>.tar.age`, an age-encrypted tar of
#   db.dump        pg_dump custom format (all schemas, incl. drizzle's migration journal)
#   manifest.json  row count of every table and money totals, taken in the SAME snapshot as the dump,
#                  plus versions and the latest applied migration (used by restore-drill.sh)
# and a sidecar `<file>.sha256` (checksum of the encrypted file, safe to store in plain text).
#
# Environment (nothing is ever echoed):
#   DATABASE_URL          required. The DIRECT (not -pooler) owner URL. A pooled URL can't export a
#                         snapshot. Production: the GitHub environment secret DATABASE_URL_UNPOOLED.
#   BACKUP_AGE_RECIPIENTS required. One or more age PUBLIC keys (age1…), separated by spaces, commas
#                         or newlines. Public keys are not secret; the private key never goes to CI.
#   BACKUP_DEST           required. `s3://bucket/prefix` (AWS CLI; set AWS_ENDPOINT_URL for R2 or
#                         another S3-compatible store) or a local directory (tests, local drills).
#   BACKUP_ENV_NAME       optional, default `production`. Part of the object key and file name.
#   BACKUP_WORKDIR        optional, default a new temp dir. Plain-text files are deleted on exit.
#   BACKUP_GIT_SHA        optional, written to the manifest (CI passes GITHUB_SHA).
#
# Object key: <BACKUP_DEST>/<env>/YYYY/MM/DD/cable-billing-<env>-<YYYYMMDDTHHMMSSZ>.tar.age
# Retention is the bucket's lifecycle rule (30 days, docs/runbooks/backup/lifecycle.json), not this script.
# Exit codes: 0 ok, 1 failure, 2 bad configuration.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
log() { printf '%s backup: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit "${2:-1}"; }

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set" 2
[[ -n "${BACKUP_AGE_RECIPIENTS:-}" ]] || die "BACKUP_AGE_RECIPIENTS is not set" 2
[[ -n "${BACKUP_DEST:-}" ]] || die "BACKUP_DEST is not set" 2
case "$DATABASE_URL" in *-pooler.*) die "DATABASE_URL is a pooled (-pooler) URL; use the direct one" 2 ;; esac
env_name="${BACKUP_ENV_NAME:-production}"
[[ "$env_name" =~ ^[a-z0-9-]+$ ]] || die "BACKUP_ENV_NAME must be lower-case letters, digits or '-'" 2
for tool in pg_dump pg_restore psql age tar sha256sum; do
  command -v "$tool" >/dev/null || die "missing tool: $tool" 2
done

recipients=()
for r in ${BACKUP_AGE_RECIPIENTS//,/ }; do
  [[ "$r" =~ ^age1[0-9a-z]{58}$ ]] || die "BACKUP_AGE_RECIPIENTS holds something that is not an age public key" 2
  recipients+=(-r "$r")
done

own_workdir=0
if [[ -z "${BACKUP_WORKDIR:-}" ]]; then own_workdir=1; fi
workdir="${BACKUP_WORKDIR:-$(mktemp -d)}"
mkdir -p "$workdir/plain"
cleanup() {
  # Plain-text dump and manifest never outlive the script.
  rm -rf "$workdir/plain"
  if ((own_workdir)); then rm -rf "$workdir"; fi
  if [[ -n "${coproc_pid:-}" ]]; then kill "$coproc_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

started_epoch=$(date -u +%s)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
day_path=$(date -u +%Y/%m/%d)
name="cable-billing-${env_name}-${stamp}"

# 1. pg_dump must be at least the server's major version.
server_num=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c 'SHOW server_version_num')
server_major=$((server_num / 10000))
dump_version=$(pg_dump --version | sed -E 's/^pg_dump \(PostgreSQL\) ([0-9.]+).*/\1/')
dump_major=${dump_version%%.*}
((dump_major >= server_major)) || die "pg_dump $dump_major is older than the server ($server_major)" 2
log "server major $server_major, pg_dump $dump_version"

# 2. Open a REPEATABLE READ transaction, export its snapshot, and take the manifest in it. pg_dump then
#    dumps exactly that snapshot, so the restore drill can demand equal counts and equal totals.
coproc SNAP { psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 2>&1; }
coproc_pid=$SNAP_PID
{
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
  echo "SELECT pg_export_snapshot();"
} >&"${SNAP[1]}"
IFS= read -r -t 60 snapshot <&"${SNAP[0]}" || die "could not export a snapshot"
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "unexpected snapshot id from the server"

# manifest.pgsql as one line (comment lines dropped), so one `read` gets its one-line result.
manifest_sql=$(grep -v '^--' "$here/manifest.pgsql" | tr '\n' ' ')
printf '%s\n' "$manifest_sql" >&"${SNAP[1]}"
IFS= read -r -t 600 db_manifest <&"${SNAP[0]}" || die "manifest query failed"
[[ "$db_manifest" == \{* ]] || die "manifest query failed: ${db_manifest:0:200}"

log "dumping snapshot $snapshot"
pg_dump "$DATABASE_URL" --format=custom --compress=6 --snapshot="$snapshot" --lock-wait-timeout=60s \
  --no-password --file="$workdir/plain/db.dump"
echo "COMMIT;" >&"${SNAP[1]}"
snap_in=${SNAP[1]}
exec {snap_in}>&- # close psql's stdin so it exits
wait "$coproc_pid" || true
coproc_pid=""

# 3. The dump must be readable before we call it a backup.
toc_entries=$(pg_restore --list "$workdir/plain/db.dump" | grep -cv '^;')
((toc_entries > 0)) || die "pg_restore can't read the dump"
dump_bytes=$(stat -c %s "$workdir/plain/db.dump")

finished_epoch=$(date -u +%s)
cat >"$workdir/plain/manifest.json" <<JSON
{
  "format": 1,
  "name": "$name",
  "environment": "$env_name",
  "snapshot_taken_at": "$(date -u -d "@$started_epoch" +%Y-%m-%dT%H:%M:%SZ)",
  "git_sha": "${BACKUP_GIT_SHA:-}",
  "pg_dump_version": "$dump_version",
  "dump_bytes": $dump_bytes,
  "toc_entries": $toc_entries,
  "dump_seconds": $((finished_epoch - started_epoch)),
  "database": $db_manifest
}
JSON

# 4. Encrypt (tar of dump + manifest → age), checksum the ciphertext, remove the plain text.
out="$workdir/$name.tar.age"
tar -C "$workdir/plain" -cf - db.dump manifest.json | age "${recipients[@]}" -o "$out"
rm -rf "$workdir/plain"
(cd "$workdir" && sha256sum "$name.tar.age" >"$name.tar.age.sha256")
enc_bytes=$(stat -c %s "$out")

# 5. Upload (or copy) both files.
case "$BACKUP_DEST" in
  s3://*)
    command -v aws >/dev/null || die "missing tool: aws" 2
    target="${BACKUP_DEST%/}/$env_name/$day_path"
    aws s3 cp --only-show-errors "$out" "$target/$name.tar.age"
    aws s3 cp --only-show-errors "$out.sha256" "$target/$name.tar.age.sha256"
    ;;
  *)
    target="${BACKUP_DEST%/}/$env_name/$day_path"
    mkdir -p "$target"
    cp "$out" "$out.sha256" "$target/"
    ;;
esac
rm -f "$out" "$out.sha256"

log "ok: $target/$name.tar.age ($enc_bytes bytes encrypted, $toc_entries TOC entries, $((finished_epoch - started_epoch)) s)"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Backup $name"
    echo
    echo "| | |"
    echo "|---|---|"
    echo "| Object | \`$target/$name.tar.age\` |"
    echo "| Encrypted size | $enc_bytes bytes |"
    echo "| Dump TOC entries | $toc_entries |"
    echo "| Dump time | $((finished_epoch - started_epoch)) s |"
  } >>"$GITHUB_STEP_SUMMARY"
fi
# Machine-readable last line for callers (the object path; no secrets).
echo "$target/$name.tar.age"

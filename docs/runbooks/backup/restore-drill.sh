#!/usr/bin/env bash
# Restore drill / real restore (PLAN §17, PRD §15 #14, T-096): fetch an encrypted backup made by
# backup.sh, check it, restore it into an EMPTY database, then prove the copy is whole:
#   1. sha256 of the encrypted file matches its sidecar;
#   2. pg_restore succeeds in one transaction (all or nothing);
#   3. every table's row count, the money totals and the migration journal equal the manifest
#      taken in the dump's own snapshot;
#   4. the T-052 invariants (checkTenantInvariants) hold for every tenant of the restored copy.
# It prints a Markdown entry for docs/runbooks/restore-log.md (also to $GITHUB_STEP_SUMMARY).
#
# Environment (nothing is ever echoed):
#   TARGET_DATABASE_URL       required. An EMPTY database: a Neon scratch branch's database, a CI
#                             service container, or a local scratch DB. Refused if it has tables.
#                             Use the owner's DIRECT URL (restore needs DDL; no -pooler).
#   BACKUP_AGE_IDENTITY_FILE  required. File holding the age PRIVATE key (from the password manager).
#   BACKUP_FILE               the `.tar.age` to restore: a local path or `s3://…` URL; or leave it
#                             unset and set BACKUP_DEST (+ BACKUP_ENV_NAME, default production) to
#                             take the newest backup under <BACKUP_DEST>/<env>/.
#   RESTORE_REPORT            optional. Where to write the Markdown entry (default: a temp file).
#   RESTORE_WORKDIR           optional. Scratch dir (plain-text files are deleted on exit).
#   RESTORE_SKIP_INVARIANTS=1 optional. Skip step 4 (only for an emergency restore when minutes count;
#                             run the check right after, the drill never skips it).
# Needs: psql, pg_restore (major ≥ the dump's), age, tar, sha256sum, aws (for s3://), and a repo
# checkout with `pnpm install` done (step 4 runs verify-restore.ts with @cb/db's tsx).
# Exit codes: 0 restored and verified, 1 failure, 2 bad configuration, 3 restored but NOT verified.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../.." && pwd)
log() { printf '%s restore: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit "${2:-1}"; }
now() { date -u +%s; }

[[ -n "${TARGET_DATABASE_URL:-}" ]] || die "TARGET_DATABASE_URL is not set" 2
[[ -f "${BACKUP_AGE_IDENTITY_FILE:-}" ]] || die "BACKUP_AGE_IDENTITY_FILE is not a file" 2
case "$TARGET_DATABASE_URL" in *-pooler.*) die "TARGET_DATABASE_URL is pooled (-pooler); use the direct URL" 2 ;; esac
if [[ -n "${DATABASE_URL:-}" && "$DATABASE_URL" == "$TARGET_DATABASE_URL" ]]; then
  die "TARGET_DATABASE_URL equals DATABASE_URL; restore into a scratch database only" 2
fi
for tool in psql pg_restore age tar sha256sum; do
  command -v "$tool" >/dev/null || die "missing tool: $tool" 2
done

own_workdir=0
if [[ -z "${RESTORE_WORKDIR:-}" ]]; then own_workdir=1; fi
workdir="${RESTORE_WORKDIR:-$(mktemp -d)}"
mkdir -p "$workdir/plain"
cleanup() {
  rm -rf "$workdir/plain"
  if ((own_workdir)); then rm -rf "$workdir"; fi
}
trap cleanup EXIT
report="${RESTORE_REPORT:-${TMPDIR:-/tmp}/restore-report-$(date -u +%Y%m%dT%H%M%SZ).md}"
t_start=$(now)

# 0. The target must be empty: never restore over a live database.
existing=$(psql "$TARGET_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'")
[[ "$existing" == "0" ]] || die "the target database already has $existing tables; restore needs an empty one" 2
target_major=$(($(psql "$TARGET_DATABASE_URL" -X -A -t -c 'SHOW server_version_num') / 10000))

# 1. Find and fetch the backup.
env_name="${BACKUP_ENV_NAME:-production}"
src="${BACKUP_FILE:-}"
if [[ -z "$src" ]]; then
  [[ -n "${BACKUP_DEST:-}" ]] || die "set BACKUP_FILE, or BACKUP_DEST to take the newest backup" 2
  prefix="${BACKUP_DEST%/}/$env_name/"
  case "$prefix" in
    s3://*)
      bucket_part="${prefix#s3://}"
      bucket="${bucket_part%%/*}"
      newest=$(aws s3 ls --recursive "$prefix" | awk '{print $4}' | grep '\.tar\.age$' | sort | tail -n 1 || true)
      [[ -n "$newest" ]] || die "no backups under $prefix"
      src="s3://$bucket/$newest"
      ;;
    *)
      src=$(find "$prefix" -type f -name '*.tar.age' | sort | tail -n 1 || true)
      [[ -n "$src" ]] || die "no backups under $prefix"
      ;;
  esac
fi
name=$(basename "$src")
[[ "$name" == *.tar.age ]] || die "BACKUP_FILE must end in .tar.age" 2
log "backup: $src"
case "$src" in
  s3://*)
    command -v aws >/dev/null || die "missing tool: aws" 2
    aws s3 cp --only-show-errors "$src" "$workdir/$name"
    aws s3 cp --only-show-errors "$src.sha256" "$workdir/$name.sha256"
    ;;
  *)
    cp "$src" "$workdir/$name"
    cp "$src.sha256" "$workdir/$name.sha256"
    ;;
esac
(cd "$workdir" && sha256sum --check --quiet "$name.sha256") || die "checksum mismatch: the file is damaged or not ours"
t_fetched=$(now)

# 2. Decrypt and unpack (plain text stays in $workdir/plain, removed on exit).
age --decrypt -i "$BACKUP_AGE_IDENTITY_FILE" -o "$workdir/plain/backup.tar" "$workdir/$name" ||
  die "could not decrypt the backup (wrong private key?)"
tar -C "$workdir/plain" -xf "$workdir/plain/backup.tar" db.dump manifest.json ||
  die "the decrypted backup is not a tar with db.dump and manifest.json"
rm -f "$workdir/plain/backup.tar"
manifest="$workdir/plain/manifest.json"
dump_major=$(sed -nE 's/.*"pg_dump_version": "([0-9]+).*/\1/p' "$manifest")
restore_major=$(pg_restore --version | sed -E 's/^pg_restore \(PostgreSQL\) ([0-9]+).*/\1/')
((restore_major >= dump_major)) || die "pg_restore $restore_major is older than the dump's pg_dump $dump_major" 2
((target_major >= dump_major)) || log "warning: target server $target_major is older than the dump's pg_dump $dump_major"
t_decrypted=$(now)

# 3. Roles, then the restore, all or nothing. --no-owner: objects belong to the restoring (owner)
#    role. Privileges are kept: the app roles' GRANTs and default privileges come back with the data.
psql "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$here/roles.pgsql" ||
  die "could not prepare the app roles (connect as the database owner that created app_rw/app_platform)"
# The dump's DEFAULT ACL entries say "FOR ROLE <source owner>", which only works when restoring as
# that same role; skip them and re-create them for the restoring owner (post-restore.pgsql).
pg_restore --list "$workdir/plain/db.dump" | sed -E 's/^([0-9]+; [0-9]+ [0-9]+ DEFAULT ACL )/;\1/' \
  >"$workdir/plain/restore.list"
log "pg_restore into the target (single transaction)"
pg_restore --dbname="$TARGET_DATABASE_URL" --no-owner --single-transaction --exit-on-error \
  --no-password --use-list="$workdir/plain/restore.list" "$workdir/plain/db.dump" ||
  die "pg_restore failed; the transaction was rolled back"
psql "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$here/post-restore.pgsql" ||
  die "could not re-create the default privileges"
psql "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c 'ANALYZE' || die "ANALYZE failed"
t_restored=$(now)

# 4. Verify: counts/totals/migrations against the manifest, then the invariants per tenant.
grep -v '^--' "$here/manifest.pgsql" | tr '\n' ' ' >"$workdir/plain/manifest-one-line.sql"
psql "$TARGET_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -f "$workdir/plain/manifest-one-line.sql" \
  >"$workdir/plain/restored.json"
verify_args=(--manifest "$manifest" --restored "$workdir/plain/restored.json" --report "$workdir/plain/verify.md")
[[ "${RESTORE_SKIP_INVARIANTS:-}" == "1" ]] && verify_args+=(--skip-invariants)
set +e
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" pnpm --dir "$repo" --silent --filter @cb/db exec \
  tsx "$here/verify-restore.ts" "${verify_args[@]}"
verify_status=$?
set -e
t_verified=$(now)

result="PASS"
((verify_status == 0)) || result="FAIL"
snapshot_at=$(sed -nE 's/.*"snapshot_taken_at": "([^"]+)".*/\1/p' "$manifest")
{
  echo "### $(date -u +%Y-%m-%d) restore of \`$name\`: **$result**"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Backup | \`$src\` |"
  echo "| Snapshot taken (UTC) | $snapshot_at |"
  echo "| Restored at (UTC) | $(date -u +%Y-%m-%dT%H:%M:%SZ) |"
  echo "| Target | Postgres $target_major, pg_restore $restore_major (\`TARGET_DATABASE_URL\` host not recorded) |"
  echo "| Fetch + checksum | $((t_fetched - t_start)) s |"
  echo "| Decrypt + unpack | $((t_decrypted - t_fetched)) s |"
  echo "| pg_restore + ANALYZE | $((t_restored - t_decrypted)) s |"
  echo "| Verify | $((t_verified - t_restored)) s |"
  echo "| **Total (restore time, RTO evidence)** | **$((t_verified - t_start)) s** |"
  echo
  cat "$workdir/plain/verify.md" 2>/dev/null || echo "Verification did not produce a report (exit $verify_status)."
} >"$report"
[[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && cat "$report" >>"$GITHUB_STEP_SUMMARY"
log "report: $report"
cat "$report"
((verify_status == 0)) || die "restored, but verification FAILED (see the report)" 3
log "restored and verified in $((t_verified - t_start)) s"

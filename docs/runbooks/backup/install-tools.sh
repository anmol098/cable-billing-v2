#!/usr/bin/env bash
# Installs the tools backup.sh / restore-drill.sh need on an Ubuntu runner (GitHub Actions
# ubuntu-24.04): the PostgreSQL 17 client from the PGDG apt repository (Ubuntu's own is 16, and
# pg_dump must be at least the server's major version) and `age`. The AWS CLI is preinstalled on
# GitHub's runners. Puts /usr/lib/postgresql/17/bin first on PATH (GITHUB_PATH) so the Ubuntu
# pg_wrapper can't pick an older client. Does nothing that is already done.
set -euo pipefail
PG_MAJOR=17

need_pg=1
if [[ -x "/usr/lib/postgresql/$PG_MAJOR/bin/pg_dump" ]]; then need_pg=0; fi
need_age=1
if command -v age >/dev/null; then need_age=0; fi

if ((need_pg || need_age)); then
  sudo=""
  [[ "$(id -u)" == "0" ]] || sudo="sudo"
  if ((need_pg)); then
    $sudo install -d /usr/share/postgresql-common/pgdg
    $sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main" |
      $sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  fi
  $sudo apt-get update -qq
  pkgs=()
  ((need_pg)) && pkgs+=("postgresql-client-$PG_MAJOR")
  ((need_age)) && pkgs+=(age)
  $sudo apt-get install -y -qq --no-install-recommends "${pkgs[@]}"
fi

if [[ -n "${GITHUB_PATH:-}" ]]; then echo "/usr/lib/postgresql/$PG_MAJOR/bin" >>"$GITHUB_PATH"; fi
"/usr/lib/postgresql/$PG_MAJOR/bin/pg_dump" --version
age --version

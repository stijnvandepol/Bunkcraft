#!/usr/bin/env bash
# BunkCraft: update to the newest version without losing data.
#
#   ./scripts/update.sh            (or: bunkcraft update)
#
# 1. backup of all worlds (scripts/backup.sh), 2. git pull (fast-forward only), 3. build the new image while
# the old one keeps serving, 4. restart: SIGTERM makes the server save every world and tell players to
# reconnect (they are back within seconds), 5. wait until the new server is healthy, 6. prune old images.
# The worlds live in the Docker volume and are never touched by an update.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

# Everything runs inside main(): bash reads a script while it runs, and the pull may replace this file.
main() {

  say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "error: local changes in $(pwd); commit or stash them first (git status)." >&2
    exit 1
  fi
  before="$(git rev-parse HEAD)"

  say "backup before the update"
  ./scripts/backup.sh --keep "${BUNKCRAFT_BACKUP_KEEP:-14}"

  say "fetching the newest version"
  git pull --ff-only
  after="$(git rev-parse HEAD)"
  if [ "$before" = "$after" ] && [ "${1:-}" != "--force" ]; then
    say "already up to date ($(git log -1 --format='%h %s'))"
    exit 0
  fi
  git --no-pager log --oneline "$before..$after" | head -n 20

  say "building (the old server keeps running)"
  docker compose build --pull

  say "restarting (worlds are saved on shutdown)"
  docker compose up -d --remove-orphans

  for _ in $(seq 1 60); do
    if docker compose exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health 2>/dev/null | grep -q '"ok":true'; then
      say "healthy: $(docker compose exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health)"
      docker image prune -f >/dev/null || true
      exit 0
    fi
    sleep 2
  done
  echo "error: the new version is not healthy. Logs: docker compose logs --tail=100 bunkcraft" >&2
  echo "Roll back: git checkout $before && docker compose up -d --build" >&2
  exit 1
}
main "$@"
# shellcheck disable=SC2317  # reached only if main returns
exit

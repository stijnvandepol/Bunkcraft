#!/usr/bin/env bash
# BunkCraft: update to the newest version without losing data, and roll back by itself if it is not healthy.
#
#   ./scripts/update.sh [options]            (or: bunkcraft update [options])
#
# 1. git pull (fast-forward; compose file and scripts), 2. pull the new image from GHCR (or build it, see
# --build) while the old server keeps running, 3. stop here if nothing changed, 4. backup of all worlds,
# 5. recreate: SIGTERM makes the server save every world and tell players to reconnect, 6. wait until the
# new server is healthy, 7. if it is not: put the previous image (and commit) back and start that again.
# The worlds live in the Docker volume and are never touched by an update.
#
# Options:
#   --tag TAG      switch to another image version and remember it in .env (BUNKCRAFT_TAG): latest,
#                  sha-<commit>, a release like 1.2.0, or latest@sha256:<digest> for one exact build
#   --build        build the image from this checkout from now on (COMPOSE_FILE in .env); needs ~1.5 GB RAM
#   --pull         go back to the ready-made image from GHCR (the default)
#   --force        recreate even when nothing changed
#   --rollback     go back to the image that ran before the last update (kept as bunkcraft:previous)
#   --no-backup    skip the backup
#   --dry-run      print what would happen, change nothing
#   -h, --help
#
# Environment: BUNKCRAFT_HEALTH_TIMEOUT (seconds, default 120), BUNKCRAFT_BACKUP_KEEP (default 14).
set -euo pipefail
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")/.."

# Everything runs inside main(): bash reads a script while it runs, and the pull may replace this file.
main() {
  local tag="" mode="" force=0 backup=1 dry=0 rollback=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
      --tag=*) tag="${1#*=}"; shift ;;
      --build) mode=build; shift ;;
      --pull) mode=pull; shift ;;
      --force) force=1; shift ;;
      --rollback) rollback=1; shift ;;
      --no-backup) backup=0; shift ;;
      --dry-run) dry=1; shift ;;
      -h|--help) sed -n '2,/^set -euo/p' "$SELF" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
  done
  case "$tag" in
    *[!A-Za-z0-9._:@-]*) die "invalid tag '$tag'" ;;
  esac
  if [ "$rollback" = 1 ]; then manual_rollback; return; fi

  # ---- persistent choices in .env (compose reads COMPOSE_FILE and BUNKCRAFT_TAG from it)
  touch_env
  local old_tag old_compose_file
  old_tag="$(env_get BUNKCRAFT_TAG)"
  old_compose_file="$(env_get COMPOSE_FILE)"
  [ -n "$tag" ] && env_set BUNKCRAFT_TAG "$tag"
  case "$mode" in
    build) env_set COMPOSE_FILE docker-compose.yml:docker-compose.build.yml ;;
    pull) env_unset COMPOSE_FILE ;;
  esac
  local building=0
  case "$(env_get COMPOSE_FILE)" in *docker-compose.build.yml*) building=1 ;; esac
  case "$mode" in build) building=1 ;; pull) building=0 ;; esac

  # ---- 1. code
  local before="" after=""
  if [ -d .git ] && git rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      die "local changes in $(pwd); commit or stash them first (git status)."
    fi
    before="$(git rev-parse HEAD)"
    say "fetching the newest code"
    if [ "$dry" = 1 ]; then
      git fetch -q && echo "  [dry-run] git pull --ff-only: $(git rev-list --count 'HEAD..@{u}') new commit(s)"
    else
      git pull -q --ff-only
    fi
    after="$(git rev-parse HEAD)"
    [ "$before" = "$after" ] || git --no-pager log --oneline "$before..$after" | head -n 20
  fi

  # ---- 2. image
  local ref old_id new_id
  ref="$(docker compose config --images bunkcraft)"
  old_id="$(running_image_id)"
  if [ "$building" = 1 ]; then
    say "building $ref from this checkout (the old server keeps running)"
    run docker compose build --pull bunkcraft
    run docker compose pull --quiet caddy
  else
    say "pulling $ref (the old server keeps running)"
    run docker compose pull --quiet
  fi
  new_id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"

  # ---- 3. anything to do?
  if [ "$dry" = 1 ]; then
    echo "  [dry-run] running: ${old_id:-nothing}; then backup, docker compose up -d, health check, rollback if unhealthy"
    restore_env "$old_tag" "$old_compose_file"
    say "dry run finished: nothing was changed"
    return 0
  fi
  if [ -n "$old_id" ] && [ "$old_id" = "$new_id" ] && [ "$before" = "$after" ] && [ "$force" = 0 ]; then
    # Applies a changed .env (e.g. a new limit); a no-op otherwise.
    docker compose up -d --remove-orphans >/dev/null 2>&1 || true
    say "already up to date ($ref, $(short "$new_id"))"
    return 0
  fi

  # ---- 4. backup (only when there is a world to back up)
  if [ "$backup" = 1 ] && [ -n "$old_id" ]; then
    say "backup before the update"
    ./scripts/backup.sh --keep "${BUNKCRAFT_BACKUP_KEEP:-14}"
  fi

  # The image that runs now stays reachable as bunkcraft:previous (rollback below, and 'bunkcraft rollback').
  [ -n "$old_id" ] && [ "$old_id" != "$new_id" ] && docker tag "$old_id" bunkcraft:previous

  # ---- 5./6. recreate and check
  say "restarting on $(short "$new_id") (worlds are saved on shutdown)"
  docker compose up -d --remove-orphans
  if wait_healthy; then
    say "healthy: $(health)"
    docker image prune -f >/dev/null 2>&1 || true
    return 0
  fi

  # ---- 7. automatic rollback
  echo "error: the new version is not healthy. Its log:" >&2
  docker compose logs --tail=40 bunkcraft >&2 || true
  [ -n "$old_id" ] || die "nothing ran before this update, so there is nothing to roll back to; see 'bunkcraft logs'."
  say "rolling back to the previous version (image $(short "$old_id"))"
  restore_env "$old_tag" "$old_compose_file"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then git reset -q --keep "$before"; fi
  ref="$(docker compose config --images bunkcraft)"
  # A tag can be pointed back at the old image; a digest reference (latest@sha256:…) already names it.
  case "$ref" in *@*) ;; *) docker tag "$old_id" "$ref" ;; esac
  docker compose up -d --remove-orphans
  if wait_healthy; then
    say "rolled back, healthy again: $(health)"
    echo "The update was undone; the next 'bunkcraft update' tries again. Report the log above." >&2
  else
    echo "error: the rollback is not healthy either: see 'bunkcraft logs'." >&2
  fi
  exit 1
}

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "${dry:-0}" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
short() { local id="${1#sha256:}"; printf '%s' "${id:0:12}"; }

touch_env() { [ -f .env ] || { [ "${dry:-0}" = 1 ] || { touch .env && chmod 600 .env; }; }; }
env_get() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n1 || true; }
env_unset() {
  [ -f .env ] && grep -q "^$1=" .env || return 0
  if [ "${dry:-0}" = 1 ]; then echo "  [dry-run] .env: remove $1"; return 0; fi
  local tmp; tmp="$(mktemp)"; grep -v "^$1=" .env >"$tmp" || true; cat "$tmp" >.env; rm -f "$tmp"
}
env_set() {
  [ "$(env_get "$1")" = "$2" ] && return 0
  if [ "${dry:-0}" = 1 ]; then echo "  [dry-run] .env: $1=$2"; return 0; fi
  env_unset "$1"; echo "$1=$2" >>.env
}
# Put BUNKCRAFT_TAG and COMPOSE_FILE back as they were (empty = not set).
restore_env() {
  [ "${dry:-0}" = 1 ] && return 0
  if [ -n "$1" ]; then env_set BUNKCRAFT_TAG "$1"; else env_unset BUNKCRAFT_TAG; fi
  if [ -n "$2" ]; then env_set COMPOSE_FILE "$2"; else env_unset COMPOSE_FILE; fi
}

running_image_id() {
  local cid; cid="$(docker compose ps -q bunkcraft 2>/dev/null | head -n1)"
  [ -n "$cid" ] && docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
}
health() { docker compose exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health 2>/dev/null; }
wait_healthy() {
  local deadline=$(( $(date +%s) + ${BUNKCRAFT_HEALTH_TIMEOUT:-120} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    health | grep -q '"ok":true' && return 0
    sleep 2
  done
  return 1
}

# One line: bash has read all of it before main runs, so a replaced update.sh cannot be read half-way.
# 'bunkcraft rollback': swap the running image and bunkcraft:previous, so running it twice goes forward again.
manual_rollback() {
  local ref cur prev
  ref="$(docker compose config --images bunkcraft)"
  case "$ref" in *@*) die "$ref is pinned by digest: set BUNKCRAFT_TAG in .env to the version you want, then 'bunkcraft update'." ;; esac
  prev="$(docker image inspect --format '{{.Id}}' bunkcraft:previous 2>/dev/null)" || die "no previous image (bunkcraft:previous) on this machine."
  cur="$(running_image_id)"
  [ "$prev" != "$cur" ] || die "the previous image is already running."
  say "switching $ref from $(short "${cur:-none}") to the previous image $(short "$prev")"
  if [ "${dry:-0}" = 1 ]; then echo "  [dry-run] docker tag $(short "$prev") $ref; docker compose up -d; health check"; return 0; fi
  [ -n "$cur" ] && docker tag "$cur" bunkcraft:previous
  docker tag "$prev" "$ref"
  docker compose up -d --remove-orphans
  wait_healthy || die "not healthy after the rollback: see 'bunkcraft logs' ('bunkcraft rollback' again switches back)."
  say "healthy: $(health)"
  echo "Note: the next 'bunkcraft update' pulls the newest version again; pin one with --tag to stay on it."
}

# One line: bash has read all of it before main runs, so a replaced update.sh cannot be read half-way.
main "$@"; exit $?

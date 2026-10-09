#!/usr/bin/env bash
# BunkCraft: update to the newest version without losing data, and roll back by itself if it is not healthy.
#
#   ./scripts/update.sh [options]            (or: bunkcraft update [options])
#
# 1. git pull (fast-forward; compose file and scripts), 2. pull the new image from GHCR (or build it, see
# --build) while the old server keeps running, 3. stop here if nothing changed, 4. backup of all worlds,
# 5. recreate: SIGTERM makes the server save every world and tell players to reconnect, 6. wait until the
# new server is healthy and passes the smoke test (scripts/server-check.mjs: game page, API, a throw-away
# game), 7. if it is not: put the previous image (and commit) back and start that again.
# The worlds live in the Docker volume and are never touched by an update. Every result goes to the deploy
# log and, when DEPLOY_WEBHOOK_URL is set in .env, to Discord/Slack. Only one update runs at a time.
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
# Environment: BUNKCRAFT_HEALTH_TIMEOUT (seconds, default 120), BUNKCRAFT_BACKUP_KEEP (default 14),
# BUNKCRAFT_SMOKE=0 (skip the smoke test).
set -euo pipefail
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")/.."
# shellcheck source=scripts/lib/deploy.sh
. scripts/lib/deploy.sh

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
  if [ "$dry" = 0 ]; then
    take_lock 0 || die "another update is running (an auto-update may be waiting for players to finish a match); see 'bunkcraft autoupdate status'."
  fi
  migrate_proxy_env || true
  if [ "$rollback" = 1 ]; then manual_rollback; return; fi

  # ---- persistent choices in .env (compose reads COMPOSE_FILE and BUNKCRAFT_TAG from it)
  touch_env
  local old_tag old_compose_file
  old_tag="$(env_get BUNKCRAFT_TAG)"
  old_compose_file="$(env_get COMPOSE_FILE)"
  [ -n "$tag" ] && env_set BUNKCRAFT_TAG "$tag"
  # COMPOSE_FILE = base file + build override (--build) + direct-port override (PROXY=none in .env).
  case "$mode" in
    build) env_set COMPOSE_FILE "$(compose_file_value build)" ;;
    pull) if [ -n "$(compose_file_value pull)" ]; then env_set COMPOSE_FILE "$(compose_file_value pull)"; else env_unset COMPOSE_FILE; fi ;;
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
    # -n instead of "| head": with pipefail a closed pipe (SIGPIPE, exit 141) would end the whole update.
    [ "$before" = "$after" ] || git --no-pager log --oneline -n 20 "$before..$after" || true
  fi

  # ---- 2. image
  local ref old_id new_id
  ref="$(docker compose config --images bunkcraft)"
  old_id="$(running_image_id)"
  # A failed pull or build changes nothing: .env and the code go back, the old server never stopped.
  local fetched=1
  if [ "$building" = 1 ]; then
    # The commit goes into the image: /health and the title screen show it (docker-compose.build.yml).
    GIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"; export GIT_SHA
    say "building $ref from this checkout (the old server keeps running)"
    { run docker compose build --pull bunkcraft && { [ "$(proxy_mode)" = none ] || run docker compose pull --quiet caddy; }; } || fetched=0
  else
    say "pulling $ref (the old server keeps running)"
    run docker compose pull --quiet || fetched=0
  fi
  if [ "$fetched" = 0 ]; then
    restore_env "$old_tag" "$old_compose_file"
    if [ -n "$before" ] && [ "$before" != "$after" ]; then git reset -q --keep "$before"; fi
    [ "$dry" = 1 ] || deploy_log "update failed: could not fetch $ref (nothing changed)"
    die "could not $([ "$building" = 1 ] && echo build || echo pull) $ref; nothing was changed, the old server keeps running."
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
  local prev_before; prev_before="$(docker image inspect --format '{{.Id}}' bunkcraft:previous 2>/dev/null || true)"
  [ -n "$old_id" ] && [ "$old_id" != "$new_id" ] && docker tag "$old_id" bunkcraft:previous

  # ---- 5./6. recreate and check
  local old_version; old_version="$(server_version || true)"
  say "restarting on $(short "$new_id") (worlds are saved on shutdown)"
  deploy_log "update started: ${old_version:-not running} -> $ref ($(short "$new_id"))"
  recreate
  if wait_healthy && smoke_test; then
    local new_version; new_version="$(server_version || true)"
    say "healthy: $(health)"
    deploy_log "update ok: ${old_version:-not running} -> $new_version ($ref, $(short "$new_id"))"
    notify "updated ${old_version:-not running} -> $new_version"
    docker image prune -f >/dev/null 2>&1 || true
    return 0
  fi

  # ---- 7. automatic rollback
  echo "error: the new version is not healthy or failed the smoke test. Its log:" >&2
  docker compose logs --tail=40 bunkcraft >&2 || true
  if [ -z "$old_id" ]; then
    deploy_log "update failed: $ref is not healthy and nothing ran before it"
    notify "update to $ref failed (not healthy) and there is nothing to roll back to"
    die "nothing ran before this update, so there is nothing to roll back to; see 'bunkcraft logs'."
  fi
  say "rolling back to the previous version (image $(short "$old_id"))"
  restore_env "$old_tag" "$old_compose_file"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then git reset -q --keep "$before"; fi
  ref="$(docker compose config --images bunkcraft)"
  # A tag can be pointed back at the old image; a digest reference (latest@sha256:…) already names it.
  case "$ref" in *@*) ;; *) docker tag "$old_id" "$ref" ;; esac
  # 'bunkcraft rollback' keeps pointing at the version before this one.
  if [ -n "$prev_before" ]; then docker tag "$prev_before" bunkcraft:previous; fi
  recreate
  if wait_healthy; then
    say "rolled back, healthy again: $(health)"
    deploy_log "update ROLLED BACK: $(short "$new_id") failed its checks; back on ${old_version:-$(short "$old_id")}"
    notify "update to $(short "$new_id") failed its checks and was rolled back to ${old_version:-$(short "$old_id")}"
    echo "The update was undone. 'bunkcraft update' tries this build again; auto-update waits for a newer one." >&2
  else
    deploy_log "update FAILED: the rollback to $(short "$old_id") is not healthy either"
    notify "update failed and the rollback is not healthy either: the server needs attention"
    echo "error: the rollback is not healthy either: see 'bunkcraft logs'." >&2
  fi
  # 3 = this build failed its health/smoke checks (auto-update then skips it); other failures stay retryable.
  exit 3
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
  local cid; cid="$(docker compose ps -q bunkcraft 2>/dev/null | sed -n 1p)"
  [ -n "$cid" ] && docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
}
# With Caddy: it waits for a healthy game server, so 'up' itself fails when the new one is unhealthy: wait_healthy decides.
recreate() { docker compose up -d --remove-orphans || true; }
health() { docker compose exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health 2>/dev/null; }
# After a healthy start: the game page, its script, the API and a throw-away game (scripts/server-check.mjs).
smoke_test() {
  [ "${BUNKCRAFT_SMOKE:-1}" = 0 ] && return 0
  local out; out="$(server_check smoke 2>&1)" && { say "smoke test: $out"; return 0; }
  echo "error: smoke test: $out" >&2
  return 1
}
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
  recreate
  wait_healthy || { deploy_log "manual rollback: not healthy"; die "not healthy after the rollback: see 'bunkcraft logs' ('bunkcraft rollback' again switches back)."; }
  say "healthy: $(health)"
  deploy_log "manual rollback: now on $(server_version || short "$prev")"
  notify "rolled back by hand to $(server_version || short "$prev")"
  echo "Note: the next 'bunkcraft update' pulls the newest version again; pin one with --tag to stay on it."
}

# One line: bash has read all of it before main runs, so a replaced update.sh cannot be read half-way.
main "$@"; exit $?

#!/usr/bin/env bash
# BunkCraft auto-update: deploy a new build of the configured channel by itself, at a quiet moment.
#
#   ./scripts/autoupdate.sh [options]   (bunkcraft autoupdate; the systemd timer runs it every 5 minutes)
#   bunkcraft deploy                    (the same, also when AUTOUPDATE=off: push deploys from GitHub)
#
# 1. One run at a time (shared lock with update.sh). 2. Is there something new? Compares the registry digest
#    of the channel tag (BUNKCRAFT_TAG: latest or stable) with the running image: one small request, nothing
#    is downloaded (falls back to 'docker compose pull' for registries that need a login). With --build
#    installs: is there a new commit upstream. A tag pinned by digest (…@sha256:…) is never auto-updated.
# 3. Wait for a quiet server: nobody in a Minecraft world and no running match (/health playersInPlay), up to
#    AUTOUPDATE_MAX_WAIT_MIN minutes; then warn every player in chat AUTOUPDATE_WARN_SEC seconds ahead and go.
# 4. Save every world, then scripts/update.sh: backup, pull, recreate, health check + smoke test, and an
#    automatic rollback when the new version fails. A build that was rolled back is not tried again; the
#    next new build is.
#
# Options:
#   --force       run even when AUTOUPDATE=off (what 'bunkcraft deploy' does)
#   --wait-lock   wait (up to an hour) for a running update instead of giving up
#   --no-wait     do not wait for a quiet server (players still get the warning)
#   --check       only report: exit 0 = up to date, 10 = an update is available
#   --dry-run     print what would happen, change nothing
#   -h, --help
#
# Settings (.env): AUTOUPDATE=on|off (default on), AUTOUPDATE_WAIT_FOR_EMPTY=1, AUTOUPDATE_MAX_WAIT_MIN=30,
# AUTOUPDATE_WARN_SEC=60, AUTOUPDATE_INTERVAL=5min (the timer; install.sh), DEPLOY_WEBHOOK_URL,
# BUNKCRAFT_DEPLOY_LOG. Logs: journalctl -u bunkcraft-autoupdate, and the deploy log (bunkcraft autoupdate status).
set -euo pipefail
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")/.."
# shellcheck source=lib/deploy.sh
. scripts/lib/deploy.sh

STATE=.autoupdate-state

# Everything runs inside main(): update.sh's git pull may replace this file while it runs.
main() {
  local force=0 wait_lock=0 no_wait=0 check=0 dry=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1 ;;
      --wait-lock) wait_lock=1 ;;
      --no-wait) no_wait=1 ;;
      --check) check=1 ;;
      --dry-run) dry=1 ;;
      -h|--help) sed -n '2,/^set -euo/p' "$SELF" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
  done

  if [ "$force" = 0 ] && [ "$check" = 0 ] && [ "$(setting AUTOUPDATE on)" = off ]; then
    log "AUTOUPDATE=off in .env: nothing to do ('bunkcraft autoupdate on' turns it back on)"
    return 0
  fi
  if [ "$check" = 0 ] && [ "$dry" = 0 ]; then
    if ! take_lock "$([ "$wait_lock" = 1 ] && echo 3600 || echo 0)"; then
      log "another update is running; skipping this run"
      return 0
    fi
  fi

  # ---- 2. something new?
  local ref key building=0
  ref="$(docker compose config --images bunkcraft)"
  case "$(dotenv_get COMPOSE_FILE)" in *docker-compose.build.yml*) building=1 ;; esac
  if [ "$building" = 0 ]; then
    case "$ref" in *@*) log "$ref is pinned by digest: never auto-updated"; [ "$check" = 1 ] && exit 0; return 0 ;; esac
  fi
  if [ -z "$(running_image_id)" ]; then
    # Somebody stopped it on purpose (or it is being installed): do not start it behind their back.
    log "the game server is not running: skipping (start it with 'bunkcraft update')"
    [ "$check" = 1 ] && exit 0
    return 0
  fi
  if ! key="$(available_update "$ref" "$building")"; then
    log "up to date ($ref)"
    [ "$check" = 1 ] && exit 0
    return 0
  fi
  if [ "$key" = "$(state_get bad)" ]; then
    log "skipping $key: this build was rolled back before (waiting for a newer one)"
    [ "$check" = 1 ] && exit 0
    return 0
  fi
  if [ "$check" = 1 ]; then echo "update available: $ref ($key)"; exit 10; fi
  deploy_log "auto-update: new build of $ref ($key)"
  if [ "$dry" = 1 ]; then
    echo "  [dry-run] wait for a quiet server, warn players, save, then scripts/update.sh"
    return 0
  fi

  # ---- 3. a quiet moment
  local in_play online
  if [ "$(setting AUTOUPDATE_WAIT_FOR_EMPTY 1)" = 1 ] && [ "$no_wait" = 0 ]; then
    local max_min deadline said=0
    max_min="$(setting AUTOUPDATE_MAX_WAIT_MIN 30)"
    deadline=$(( $(date +%s) + max_min * 60 ))
    while :; do
      read -r in_play online < <(players)
      [ "$in_play" = 0 ] && break
      if [ "$(date +%s)" -ge "$deadline" ]; then
        deploy_log "auto-update: still $in_play player(s) in play after $max_min min; updating anyway"
        break
      fi
      [ "$said" = 1 ] || log "waiting for a quiet server: $in_play player(s) in a world or a running match (at most $max_min min)"
      said=1
      sleep "${AUTOUPDATE_POLL_SEC:-15}"
    done
  fi
  read -r in_play online < <(players)
  if [ "$in_play" != 0 ]; then
    local warn; warn="$(setting AUTOUPDATE_WARN_SEC 60)"
    announce "Server update: the server restarts in $warn seconds. You reconnect by yourself; your world is saved."
    log "warned $online player(s); restarting in ${warn}s"
    sleep "$warn"
  elif [ "$online" != 0 ]; then
    announce "Server update: restarting now, back in a few seconds."
    sleep 3
  fi

  # ---- 4. save, then the update itself (backup, pull, recreate, health + smoke test, rollback)
  server_check save >/dev/null 2>&1 || log "could not save through the admin API (no ADMIN_TOKEN?); the server saves on shutdown anyway"
  local rc=0
  ./scripts/update.sh || rc=$?
  if [ "$rc" = 0 ]; then
    state_set bad ""
  else
    state_set bad "$key"
    deploy_log "auto-update: $key failed (exit $rc); it is not tried again, the next new build is"
  fi
  return "$rc"
}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

running_image_id() {
  local cid; cid="$(docker compose ps -q bunkcraft 2>/dev/null | head -n1)"
  [ -n "$cid" ] && docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
}

# "<players in play> <players online>"; unknown counts as busy, so a broken check never cuts a match short.
players() {
  local out; out="$(server_check players 2>/dev/null)" || out=""
  case "$out" in
    [0-9]*' '[0-9]*) echo "$out" ;;
    *) echo "1 1" ;;
  esac
}
announce() { server_check announce "$1" >/dev/null 2>&1 || log "could not warn the players (no ADMIN_TOKEN?)"; }

state_get() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | tail -n1 || true; }
state_set() {
  local tmp; tmp="$(mktemp)"
  { grep -v "^$1=" "$STATE" 2>/dev/null || true; echo "$1=$2"; } >"$tmp"
  cat "$tmp" >"$STATE"; rm -f "$tmp"
}

# Prints a key for the new build and succeeds when there is one; fails when the running build is current.
available_update() {
  local ref="$1" building="$2"
  if [ "$building" = 1 ]; then
    # Built here from the checkout: new commits upstream are the update.
    git rev-parse -q --verify '@{u}' >/dev/null 2>&1 || return 1
    git fetch -q || { log "git fetch failed"; return 1; }
    local up; up="$(git rev-parse '@{u}')"
    [ "$up" != "$(git rev-parse HEAD)" ] || return 1
    echo "commit:${up:0:12}"
    return 0
  fi
  local digest running
  running="$(docker image inspect --format '{{join .RepoDigests " "}}' "$(running_image_id)" 2>/dev/null || true)"
  if digest="$(registry_digest "$ref")"; then
    case " $running " in *"@$digest "*) return 1 ;; esac
    echo "$digest"
    return 0
  fi
  # The registry wants a login (private image) or the HEAD request failed: pull with Docker's own credentials.
  log "registry digest check failed for $ref; comparing by pulling instead"
  docker compose pull --quiet bunkcraft >/dev/null 2>&1 || { log "pull failed"; return 1; }
  local id; id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
  [ -n "$id" ] && [ "$id" != "$(running_image_id)" ] || return 1
  echo "image:${id#sha256:}" | cut -c1-18
}

# The manifest digest of an image tag, asked from the registry (anonymous bearer token when it wants one).
registry_digest() {
  local ref="$1" name tag host repo scheme url accept hdrs auth realm service scope token
  command -v curl >/dev/null 2>&1 || return 1
  name="${ref%:*}"; tag="${ref##*:}"
  case "$tag" in */*) name="$ref"; tag=latest ;; esac
  host="${name%%/*}"
  if [ "$host" = "$name" ] || { [[ "$host" != *.* ]] && [[ "$host" != *:* ]] && [ "$host" != localhost ]; }; then
    host=registry-1.docker.io; repo="$name"
    [[ "$repo" == */* ]] || repo="library/$repo"
  else
    repo="${name#*/}"
  fi
  scheme=https
  case "$host" in localhost|localhost:*|127.0.0.1|127.0.0.1:*) scheme=http ;; esac
  url="$scheme://$host/v2/$repo/manifests/$tag"
  accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
  hdrs="$(curl -sS -m 20 -I -H "Accept: $accept" "$url" 2>/dev/null | tr -d '\r')" || return 1
  if printf '%s\n' "$hdrs" | head -n1 | grep -q ' 401'; then
    auth="$(printf '%s\n' "$hdrs" | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *[Bb]earer *//p' | head -n1)"
    realm="$(printf '%s' "$auth" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
    service="$(printf '%s' "$auth" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
    scope="$(printf '%s' "$auth" | sed -n 's/.*scope="\([^"]*\)".*/\1/p')"
    [ -n "$realm" ] || return 1
    token="$(curl -fsS -m 20 -G --data-urlencode "service=$service" --data-urlencode "scope=${scope:-repository:$repo:pull}" "$realm" 2>/dev/null \
      | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')"
    [ -n "$token" ] || return 1
    hdrs="$(curl -sS -m 20 -I -H "Accept: $accept" -H "Authorization: Bearer $token" "$url" 2>/dev/null | tr -d '\r')" || return 1
  fi
  printf '%s\n' "$hdrs" | head -n1 | grep -q ' 200' || return 1
  local digest
  digest="$(printf '%s\n' "$hdrs" | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | head -n1)"
  case "$digest" in sha256:*) echo "$digest" ;; *) return 1 ;; esac
}

main "$@"; exit $?

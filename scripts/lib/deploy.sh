# shellcheck shell=bash
# Shared by update.sh, autoupdate.sh and bunkcraft.sh (sourced; the caller has cd'ed to the checkout).
#
# Settings read from .env:
#   DEPLOY_WEBHOOK_URL    Discord or Slack incoming webhook for deploy messages (empty = off, the default)
#   BUNKCRAFT_DEPLOY_LOG  deploy log file, one line per deploy event (default /var/log/bunkcraft-deploy.log)

dotenv_get() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n1 || true; }
dotenv_set() {
  [ "$(dotenv_get "$1")" = "$2" ] && return 0
  local tmp; tmp="$(mktemp)"
  { grep -v "^$1=" .env 2>/dev/null || true; echo "$1=$2"; } >"$tmp"
  cat "$tmp" >.env; rm -f "$tmp"
}

# A setting: the environment wins over .env, then the default.
setting() { local v="${!1:-}"; [ -n "$v" ] || v="$(dotenv_get "$1")"; printf '%s' "${v:-$2}"; }

# The proxy in front of the game server (PROXY in .env, written by install.sh): caddy (also every install from before
# this setting existed) or none (Cloudflare Tunnel or another proxy of your own; docker-compose.direct.yml publishes the port).
proxy_mode() { local v; v="$(dotenv_get PROXY)"; printf '%s' "${v:-caddy}"; }

# Caddy is a compose profile: with the Caddy proxy COMPOSE_PROFILES in .env must name it, or 'docker compose up' leaves it
# alone. Installs from before the profile existed get PROXY=caddy and the profile here, on their first update.
# Never fatal and silent when .env is not writable (a status command run as a normal user).
migrate_proxy_env() {
  [ -w .env ] && [ "${dry:-0}" != 1 ] || return 0
  [ "$(proxy_mode)" = caddy ] || return 0
  [ -n "$(dotenv_get PROXY)" ] || dotenv_set PROXY caddy
  local profiles; profiles="$(dotenv_get COMPOSE_PROFILES)"
  case ",$profiles," in *,caddy,*) ;; *) dotenv_set COMPOSE_PROFILES "${profiles:+$profiles,}caddy" ;; esac
}

# The COMPOSE_FILE value for "build" or "pull" (the image) plus the proxy mode; empty = docker compose's default file.
compose_file_value() {
  local files=docker-compose.yml
  [ "$1" = build ] && files="$files:docker-compose.build.yml"
  [ "$(proxy_mode)" = none ] && files="$files:docker-compose.direct.yml"
  [ "$files" = docker-compose.yml ] && files=""
  printf '%s' "$files"
}

# One line per deploy event in the deploy log (and on stdout, so the systemd journal has it too).
deploy_log() {
  local line file
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$line"
  file="$(setting BUNKCRAFT_DEPLOY_LOG /var/log/bunkcraft-deploy.log)"
  { echo "$line" >>"$file"; } 2>/dev/null || return 0
  # Keep it small: the newest 1000 lines.
  if [ "$(wc -l <"$file")" -gt 1000 ]; then
    local tmp; tmp="$(mktemp)"; tail -n 500 "$file" >"$tmp" && cat "$tmp" >"$file"; rm -f "$tmp"
  fi
}

# Optional chat notification; never fails the caller.
notify() {
  local url text body
  url="$(setting DEPLOY_WEBHOOK_URL '')"
  [ -n "$url" ] && command -v curl >/dev/null 2>&1 || return 0
  text="BunkCraft ($(hostname 2>/dev/null || echo server)): $*"
  text="${text//\\/\\\\}"; text="${text//\"/\\\"}"
  # Discord wants "content", Slack (and most others) "text".
  case "$url" in
    *discord.com/*|*discordapp.com/*) body="{\"content\":\"$text\"}" ;;
    *) body="{\"text\":\"$text\"}" ;;
  esac
  curl -fsS -m 10 -o /dev/null -H 'content-type: application/json' -d "$body" "$url" 2>/dev/null \
    || echo "warning: the deploy notification could not be sent" >&2
}

# scripts/server-check.mjs inside the running game server container (see that file for the commands).
server_check() {
  docker compose exec -T bunkcraft node --input-type=module - "$@" <scripts/server-check.mjs
}
server_version() {
  local v; v="$(server_check health 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  [ -n "$v" ] && printf '%s' "$v"
}

# Only one update at a time: update.sh, autoupdate.sh and 'bunkcraft deploy' share this lock (fd 9).
# take_lock [seconds to wait]; a child started with BUNKCRAFT_UPDATE_LOCKED=1 runs under its parent's lock.
take_lock() {
  [ "${BUNKCRAFT_UPDATE_LOCKED:-0}" = 1 ] && return 0
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>>.update.lock
  if [ "${1:-0}" -gt 0 ]; then flock -w "$1" 9; else flock -n 9; fi || return 1
  export BUNKCRAFT_UPDATE_LOCKED=1
}

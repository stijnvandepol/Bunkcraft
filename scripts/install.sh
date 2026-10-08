#!/usr/bin/env bash
# BunkCraft: one-command install on a fresh Ubuntu or Debian server (Docker + Caddy with automatic HTTPS,
# or --proxy none behind a Cloudflare Tunnel / a proxy of your own).
#
#   curl -fsSL https://raw.githubusercontent.com/stijnvandepol/Bunkcraft/main/scripts/install.sh \
#     | sudo bash -s -- --domain play.example.com
#   # or from a checkout:
#   sudo ./scripts/install.sh --domain play.example.com [--admin-token TOKEN]
#   # behind a Cloudflare Tunnel (cloudflared runs here or elsewhere), no Caddy, no ports 80/443:
#   sudo ./scripts/install.sh --proxy none --domain play.example.com [--bind 0.0.0.0] [--port 3000]
#
# The game server comes as a ready-made image (ghcr.io/stijnvandepol/bunkcraft, amd64 + arm64): nothing is
# built on the server, so 1 GB of RAM is enough. --build builds it from the checkout instead.
#
# Safe to run again (idempotent): it only installs what is missing, keeps the existing .env values and
# worlds, and pulls/restarts the containers. See docs/SERVER.md ("Op je eigen Linux-server in 5 minuten").
#
# Options (or the environment variable in brackets):
#   --domain NAME        domain that points at this server (DOMAIN); asked when missing and a terminal is attached
#                        (with --proxy none it is optional: only used for ALLOWED_ORIGINS=https://NAME)
#   --proxy MODE         caddy (default): Caddy in front, automatic HTTPS on ports 80/443 (PROXY, kept in .env)
#                        none: no Caddy and no 80/443; the game server is published on --bind:--port for a Cloudflare
#                        Tunnel or another proxy you run yourself (TRUST_CLOUDFLARE=1: the CF-Connecting-IP header
#                        is the client address, but only on connections from --trust-from)
#   --bind ADDR          --proxy none: 127.0.0.1 (default; the proxy runs on this machine) or 0.0.0.0 (it runs
#                        elsewhere) (BIND_ADDR)
#   --port N             --proxy none: the port on the host, default 3000 (BUNKCRAFT_PORT)
#   --trust-from ADDRS   --proxy none: address(es)/IPv4 CIDRs of the cloudflared host, comma separated
#                        (TRUSTED_PROXY_ADDRS). Required with --bind 0.0.0.0 to trust CF-Connecting-IP; with
#                        --bind 127.0.0.1 the default is this machine and the Docker networks
#   --admin-token TOKEN  admin token for /admin (ADMIN_TOKEN); generated when missing
#   --dir PATH           where the code lives (BUNKCRAFT_DIR); default: this checkout, else /opt/bunkcraft
#   --repo URL           git repository to clone (BUNKCRAFT_REPO)
#   --branch NAME        branch to clone/follow (BUNKCRAFT_BRANCH, default main)
#   --tag TAG            image version (BUNKCRAFT_TAG in .env): latest (default, every green push to main),
#                        stable (only releases), sha-<commit>, 1.2.0, or latest@sha256:<digest> (one exact build)
#   --image NAME         image repository (BUNKCRAFT_IMAGE), for a mirror or a fork
#   --build              build the image on this server instead of pulling it (needs ~1.5 GB RAM; adds swap)
#   --pull               switch an earlier --build install back to the ready-made image
#   --no-firewall        do not touch ufw
#   --no-swap            do not create a swap file on small machines (only used with --build)
#   --no-backups         do not install the daily backup timer
#   --no-autoupdate      do not deploy new builds of the channel by itself (AUTOUPDATE=off in .env);
#                        'bunkcraft autoupdate on|off' changes it later
#   --autoupdate-interval SPAN   how often to look for a new build (AUTOUPDATE_INTERVAL, default 5min)
#   --no-start           prepare everything but do not pull/build/start the containers
#   --dry-run            print what would happen, change nothing (works without root)
#   -h, --help
set -euo pipefail

DOMAIN="${DOMAIN:-}"
ADMIN_TOKEN_ARG="${ADMIN_TOKEN:-}"
DIR="${BUNKCRAFT_DIR:-}"
REPO="${BUNKCRAFT_REPO:-https://github.com/stijnvandepol/Bunkcraft.git}"
BRANCH="${BUNKCRAFT_BRANCH:-main}"
TAG_ARG="${BUNKCRAFT_TAG:-}"
IMAGE_ARG="${BUNKCRAFT_IMAGE:-}"
MODE=""   # build | pull | "" (keep what .env says; pull on a fresh install)
FIREWALL=1 SWAP=1 BACKUPS=1 START=1 DRY=0
AUTOUPDATE_ARG="" INTERVAL_ARG=""
PROXY="${PROXY:-}" BIND_ARG="${BIND_ADDR:-}" PORT_ARG="${BUNKCRAFT_PORT:-}" TRUST_FROM_ARG="${TRUSTED_PROXY_ADDRS:-}"
ORIG_ARGS=("$@")

usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --admin-token) ADMIN_TOKEN_ARG="${2:?--admin-token needs a value}"; shift 2 ;;
    --admin-token=*) ADMIN_TOKEN_ARG="${1#*=}"; shift ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --tag) TAG_ARG="${2:?--tag needs a value}"; shift 2 ;;
    --tag=*) TAG_ARG="${1#*=}"; shift ;;
    --image) IMAGE_ARG="${2:?--image needs a value}"; shift 2 ;;
    --image=*) IMAGE_ARG="${1#*=}"; shift ;;
    --proxy) PROXY="${2:?--proxy needs a value}"; shift 2 ;;
    --proxy=*) PROXY="${1#*=}"; shift ;;
    --bind) BIND_ARG="${2:?--bind needs a value}"; shift 2 ;;
    --bind=*) BIND_ARG="${1#*=}"; shift ;;
    --port) PORT_ARG="${2:?--port needs a value}"; shift 2 ;;
    --trust-from) TRUST_FROM_ARG="${2:?--trust-from needs a value}"; shift 2 ;;
    --trust-from=*) TRUST_FROM_ARG="${1#*=}"; shift ;;
    --port=*) PORT_ARG="${1#*=}"; shift ;;
    --build) MODE=build; shift ;;
    --pull) MODE=pull; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    --no-swap) SWAP=0; shift ;;
    --no-backups) BACKUPS=0; shift ;;
    --no-autoupdate) AUTOUPDATE_ARG=off; shift ;;
    --autoupdate) AUTOUPDATE_ARG=on; shift ;;
    --autoupdate-interval) INTERVAL_ARG="${2:?--autoupdate-interval needs a value}"; shift 2 ;;
    --autoupdate-interval=*) INTERVAL_ARG="${1#*=}"; shift ;;
    --no-start) START=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
# Every change goes through run: --dry-run prints it instead.
run() {
  if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }
systemd_running() { [ -d /run/systemd/system ]; }

# ---------------------------------------------------------------- preconditions
[ "$(uname -s)" = Linux ] || [ "$DRY" = 1 ] || die "this installer is for Linux servers (Ubuntu/Debian)."
if [ "$(id -u)" -ne 0 ] && [ "$DRY" = 0 ]; then
  { have sudo && [ -f "$0" ]; } || die "run as root (… | sudo bash -s -- --domain …)."
  exec sudo -E bash "$0" "${ORIG_ARGS[@]}"
fi
OS_ID="" OS_CODENAME=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}" OS_CODENAME="${VERSION_CODENAME:-}"
fi
APT=0
case "$OS_ID" in
  ubuntu|debian) APT=1 ;;
  *) have docker || [ "$DRY" = 1 ] || die "unsupported OS '$OS_ID': install Docker with the compose plugin yourself and run this again." ;;
esac

# Where the code lives: this checkout when the script runs from one, otherwise /opt/bunkcraft.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "$DIR" ]; then
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../docker-compose.yml" ]; then DIR="$(cd "$SCRIPT_DIR/.." && pwd)"; else DIR=/opt/bunkcraft; fi
fi

# The proxy: argument, else what an earlier run wrote to .env, else Caddy.
env_value() { [ -f "$DIR/.env" ] && sed -n "s/^$1=//p" "$DIR/.env" | tail -n1 || true; }
PREV_PROXY="$(env_value PROXY)"
[ -n "$PROXY" ] || PROXY="${PREV_PROXY:-caddy}"
case "$PROXY" in
  caddy|none) ;;
  *) die "--proxy '$PROXY': use caddy or none." ;;
esac
BIND_ADDR="${BIND_ARG:-$(env_value BIND_ADDR)}"; BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
GAME_PORT="${PORT_ARG:-$(env_value BUNKCRAFT_PORT)}"; GAME_PORT="${GAME_PORT:-3000}"
[[ "$BIND_ADDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--bind '$BIND_ADDR': use an IPv4 address such as 127.0.0.1 or 0.0.0.0."
{ [[ "$GAME_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$GAME_PORT" -ge 1 ] && [ "$GAME_PORT" -le 65535 ]; } || die "--port '$GAME_PORT': use a number from 1 to 65535."
if [ "$PROXY" = caddy ] && { [ -n "$BIND_ARG" ] || [ -n "$PORT_ARG" ]; }; then warn "--bind and --port only apply with --proxy none; ignored."; fi

# The domain: argument, existing .env, or ask. Caddy needs it (certificate); without a proxy it is optional.
if [ -z "$DOMAIN" ]; then DOMAIN="$(env_value DOMAIN)"; fi
if [ -z "$DOMAIN" ] && [ "$PROXY" = caddy ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  printf 'Domain for BunkCraft (e.g. play.example.com): ' >/dev/tty
  read -r DOMAIN </dev/tty || true
fi
if [ "$PROXY" = caddy ]; then
  [ -n "$DOMAIN" ] || die "no domain: pass --domain play.example.com (an A/AAAA record must point at this server), or --proxy none behind a Cloudflare Tunnel."
fi
case "$DOMAIN" in
  *[!A-Za-z0-9.:-]*) die "domain '$DOMAIN' contains invalid characters." ;;
esac
case "$TAG_ARG$IMAGE_ARG" in
  *[!A-Za-z0-9._:@/-]*) die "--tag/--image contain invalid characters." ;;
esac
if [ -n "$INTERVAL_ARG" ] && ! [[ "$INTERVAL_ARG" =~ ^[0-9]+(m|min|h)?$ ]]; then
  die "--autoupdate-interval '$INTERVAL_ARG': use minutes or hours, e.g. 5min, 15m or 1h."
fi
# Build or pull: the argument, else what an earlier run wrote to .env, else pull.
if [ -z "$MODE" ]; then
  MODE=pull
  if [ -f "$DIR/.env" ] && grep -q '^COMPOSE_FILE=.*docker-compose\.build\.yml' "$DIR/.env"; then MODE=build; fi
fi

say "BunkCraft install: $([ "$PROXY" = caddy ] && echo "domain $DOMAIN (Caddy)" || echo "no proxy, ${DOMAIN:-no domain}, ${BIND_ADDR}:${GAME_PORT}"), directory $DIR, image $([ "$MODE" = build ] && echo 'built here' || echo 'pulled')$([ "$DRY" = 1 ] && echo ' (dry run)')"

# ---------------------------------------------------------------- packages
if [ "$APT" = 1 ]; then
  missing=""
  for p in ca-certificates curl git openssl; do
    dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"
  done
  if [ -n "$missing" ]; then
    say "installing:$missing"
    run apt-get update -qq
    # shellcheck disable=SC2086
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing
  fi
fi

# ---------------------------------------------------------------- Docker (official apt repository)
if have docker && docker compose version >/dev/null 2>&1; then
  say "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '(daemon not running)') with compose: present"
else
  [ "$APT" = 1 ] || die "Docker with the compose plugin is missing."
  say "installing Docker Engine + compose plugin from download.docker.com"
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  repo_line="deb [arch=$(dpkg --print-architecture 2>/dev/null || echo amd64) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable"
  if [ "$DRY" = 1 ]; then echo "  [dry-run] write /etc/apt/sources.list.d/docker.list: $repo_line"; else echo "$repo_line" >/etc/apt/sources.list.d/docker.list; fi
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if [ "$DRY" = 0 ] && ! docker info >/dev/null 2>&1; then
  if systemd_running; then
    run systemctl enable --now docker
  else
    # Containers and minimal systems without systemd (also how the installer is tested): start the daemon directly.
    warn "systemd is not running: starting dockerd in the background"
    nohup dockerd >/var/log/dockerd.log 2>&1 &
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  docker info >/dev/null 2>&1 || die "the Docker daemon does not start (see 'journalctl -u docker')."
fi

# ---------------------------------------------------------------- swap on small machines (only for --build)
# Building the image (TypeScript + Vite) needs more than 1 GB; the running server (pulled image) needs far less.
MEM_MB=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 2048)
if [ "$MODE" = build ] && [ "$SWAP" = 1 ] && [ "$MEM_MB" -lt 1900 ] && [ "$(awk 'NR > 1' /proc/swaps 2>/dev/null | wc -l)" -eq 0 ]; then
  say "only ${MEM_MB} MB RAM and no swap: adding a 2 GB /swapfile (for the image build)"
  if [ ! -f /swapfile ]; then
    run fallocate -l 2G /swapfile || run dd if=/dev/zero of=/swapfile bs=1M count=2048
    run chmod 600 /swapfile
    run mkswap /swapfile
  fi
  if run swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab 2>/dev/null || { [ "$DRY" = 1 ] && echo "  [dry-run] add /swapfile to /etc/fstab" || echo '/swapfile none swap sw 0 0' >>/etc/fstab; }
  else
    warn "could not enable swap (container or unsupported filesystem); the build may run out of memory on < 2 GB"
  fi
fi

# ---------------------------------------------------------------- code
if [ -f "$DIR/docker-compose.yml" ]; then
  say "code: $DIR"
  if [ -d "$DIR/.git" ] && [ "$DIR" != "$(cd "${SCRIPT_DIR:-.}/.." 2>/dev/null && pwd)" ]; then
    run git -C "$DIR" pull --ff-only || warn "git pull failed; continuing with the current code"
  fi
else
  say "cloning $REPO ($BRANCH) into $DIR"
  run git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

# ---------------------------------------------------------------- .env
# Values that are already there stay (re-runs never rotate tokens); --domain and --admin-token overwrite.
ENV_FILE="$DIR/.env"
set_env() { # key value [overwrite]
  local key="$1" value="$2" force="${3:-0}"
  if [ -f "$ENV_FILE" ] && grep -q "^$key=" "$ENV_FILE"; then
    [ "$force" = 1 ] || return 0
    [ "$(sed -n "s/^$key=//p" "$ENV_FILE" | tail -n1)" = "$value" ] && return 0
    if [ "$DRY" = 1 ]; then echo "  [dry-run] .env: update $key"; return 0; fi
    local tmp; tmp="$(mktemp)"
    grep -v "^$key=" "$ENV_FILE" >"$tmp"; echo "$key=$value" >>"$tmp"
    cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
  else
    if [ "$DRY" = 1 ]; then echo "  [dry-run] .env: set $key"; return 0; fi
    echo "$key=$value" >>"$ENV_FILE"
  fi
}
if [ "$DRY" = 0 ]; then
  [ -d "$DIR" ] || die "$DIR does not exist"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
fi
token() { openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
CPUS=$(nproc 2>/dev/null || echo 1)
# Container memory: 60 % of RAM (384 MB .. 3 GB); the V8 heap gets 60 % of that (docs/research/SERVER-DEPLOY.md).
CONTAINER_MB=$(( MEM_MB * 6 / 10 )); [ "$CONTAINER_MB" -lt 384 ] && CONTAINER_MB=384; [ "$CONTAINER_MB" -gt 3072 ] && CONTAINER_MB=3072
HEAP_MB=$(( CONTAINER_MB * 6 / 10 ))
unset_env() { # key
  [ -f "$ENV_FILE" ] && grep -q "^$1=" "$ENV_FILE" || return 0
  if [ "$DRY" = 1 ]; then echo "  [dry-run] .env: remove $1"; return 0; fi
  local tmp; tmp="$(mktemp)"; grep -v "^$1=" "$ENV_FILE" >"$tmp" || true; cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}
# COMPOSE_PROFILES: Caddy is the compose profile "caddy"; add or remove it and keep any other profile the owner set.
set_profiles() { # caddy|nocaddy
  local cur new="" p list=()
  cur="$(env_value COMPOSE_PROFILES)"
  IFS=, read -ra list <<<"$cur"
  for p in ${list[@]+"${list[@]}"}; do [ "$p" = caddy ] || new="${new:+$new,}$p"; done
  [ "$1" = caddy ] && new="${new:+$new,}caddy"
  if [ -n "$new" ]; then set_env COMPOSE_PROFILES "$new" 1; else unset_env COMPOSE_PROFILES; fi
}
set_env PROXY "$PROXY" 1
if [ -n "$DOMAIN" ]; then
  set_env DOMAIN "$DOMAIN" 1
  set_env ALLOWED_ORIGINS "https://$DOMAIN"
fi
if [ "$PROXY" = none ]; then
  # Behind Cloudflare: its edge sets CF-Connecting-IP (the visitor); X-Forwarded-For is not trusted.
  set_env BIND_ADDR "$BIND_ADDR" "$([ -n "$BIND_ARG" ] && echo 1 || echo 0)"
  set_env BUNKCRAFT_PORT "$GAME_PORT" "$([ -n "$PORT_ARG" ] && echo 1 || echo 0)"
  set_env TRUST_PROXY 0
  # CF-Connecting-IP is only trusted on connections from the cloudflared host: anyone else reaching the
  # port could forge it. On 127.0.0.1 only this machine (via Docker's bridge gateway) can connect.
  TRUST_FROM="${TRUST_FROM_ARG:-$(env_value TRUSTED_PROXY_ADDRS)}"
  if [ -z "$TRUST_FROM" ] && [ "$BIND_ADDR" = 127.0.0.1 ]; then TRUST_FROM="127.0.0.1,::1,172.16.0.0/12"; fi
  if [ -n "$TRUST_FROM" ]; then
    set_env TRUSTED_PROXY_ADDRS "$TRUST_FROM" 1
    set_env TRUST_CLOUDFLARE 1 1
  else
    set_env TRUST_CLOUDFLARE 0 1
    warn "--bind $BIND_ADDR without --trust-from: CF-Connecting-IP is NOT trusted (anyone reaching the port could forge it), so"
    warn "rate limits use the cloudflared host's address. Rerun with --trust-from <cloudflared-ip> and firewall the port to it."
  fi
  set_profiles nocaddy
else
  if [ "$PREV_PROXY" = none ]; then unset_env TRUST_PROXY; unset_env TRUST_CLOUDFLARE; unset_env TRUSTED_PROXY_ADDRS; fi
  set_profiles caddy
fi
if [ -n "$ADMIN_TOKEN_ARG" ]; then set_env ADMIN_TOKEN "$ADMIN_TOKEN_ARG" 1; else set_env ADMIN_TOKEN "$(token)"; fi
set_env METRICS_TOKEN "$(token)"
set_env BUNKCRAFT_CPUS "$CPUS"
set_env BUNKCRAFT_MEMORY "${CONTAINER_MB}m"
set_env BUNKCRAFT_NODE_OPTIONS "--max-old-space-size=$HEAP_MB --max-semi-space-size=16"
if [ -n "$TAG_ARG" ]; then set_env BUNKCRAFT_TAG "$TAG_ARG" 1; fi
if [ -n "$IMAGE_ARG" ]; then set_env BUNKCRAFT_IMAGE "$IMAGE_ARG" 1; fi
# Auto-update (scripts/autoupdate.sh): on by default; a re-run keeps an earlier choice unless told otherwise.
if [ -n "$AUTOUPDATE_ARG" ]; then set_env AUTOUPDATE "$AUTOUPDATE_ARG" 1; else set_env AUTOUPDATE on; fi
if [ -n "$INTERVAL_ARG" ]; then set_env AUTOUPDATE_INTERVAL "$INTERVAL_ARG" 1; else set_env AUTOUPDATE_INTERVAL 5min; fi
# docker compose reads COMPOSE_FILE from .env, so every later command (update, backup, restart) builds too and
# publishes the port: base file + build override (--build) + direct-port override (--proxy none).
COMPOSE_FILES=docker-compose.yml
[ "$MODE" = build ] && COMPOSE_FILES="$COMPOSE_FILES:docker-compose.build.yml"
[ "$PROXY" = none ] && COMPOSE_FILES="$COMPOSE_FILES:docker-compose.direct.yml"
if [ "$COMPOSE_FILES" != docker-compose.yml ]; then set_env COMPOSE_FILE "$COMPOSE_FILES" 1; else unset_env COMPOSE_FILE; fi
say ".env ready ($ENV_FILE, mode 600): ${CPUS} CPU, ${CONTAINER_MB} MB for the game server"

# ---------------------------------------------------------------- firewall
if [ "$PROXY" = none ]; then
  echo "    Firewall: nothing changed (no proxy, so no 80/443). Only the tunnel should reach ${BIND_ADDR}:${GAME_PORT}."
  if [ "$BIND_ADDR" != 127.0.0.1 ]; then
    echo "    Restrict that port to the cloudflared machine with a cloud firewall, or iptables in the DOCKER-USER chain (ufw does not filter Docker ports)."
  fi
elif [ "$FIREWALL" = 1 ]; then
  if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    say "ufw: opening 80/tcp, 443/tcp and 443/udp (HTTP/3)"
    run ufw allow 80/tcp >/dev/null; run ufw allow 443/tcp >/dev/null; run ufw allow 443/udp >/dev/null
  else
    echo "    Firewall hint: allow SSH first, then 80/tcp, 443/tcp and 443/udp, e.g."
    echo "      ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable"
    echo "    (Docker publishes ports past ufw's INPUT rules; a cloud firewall in front is the stricter option.)"
  fi
fi

# ---------------------------------------------------------------- DNS sanity check (warning only)
if [ "$PROXY" = caddy ] && have getent; then
  # getent fails for a name that does not resolve yet; with pipefail that must not end the install.
  resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)"
  local_ips="$(hostname -I 2>/dev/null || true)"
  if [ -z "$resolved" ]; then
    warn "$DOMAIN does not resolve yet: create an A/AAAA record to this server, Caddy retries the certificate."
  else
    match=0; for ip in $resolved; do case " $local_ips " in *" $ip "*) match=1 ;; esac; done
    [ "$match" = 1 ] || echo "    DNS: $DOMAIN → $resolved (this server: ${local_ips:-unknown}; fine behind NAT/a floating IP)"
  fi
fi

# ---------------------------------------------------------------- helper command + backups
run ln -sf "$DIR/scripts/bunkcraft.sh" /usr/local/bin/bunkcraft
if [ "$BACKUPS" = 1 ]; then
  if systemd_running; then
    say "daily backup at 04:30 → /var/backups/bunkcraft (systemd timer bunkcraft-backup.timer, keeps 14)"
    unit="[Unit]
Description=BunkCraft world backup
After=docker.service

[Service]
Type=oneshot
ExecStart=$DIR/scripts/backup.sh --keep 14"
    timer="[Unit]
Description=Daily BunkCraft world backup

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target"
    if [ "$DRY" = 1 ]; then
      echo "  [dry-run] write /etc/systemd/system/bunkcraft-backup.{service,timer}"
    else
      printf '%s\n' "$unit" >/etc/systemd/system/bunkcraft-backup.service
      printf '%s\n' "$timer" >/etc/systemd/system/bunkcraft-backup.timer
    fi
    run systemctl daemon-reload
    run systemctl enable --now bunkcraft-backup.timer
  elif [ -d /etc/cron.d ]; then
    say "daily backup at 04:30 → /var/backups/bunkcraft (/etc/cron.d/bunkcraft, keeps 14)"
    if [ "$DRY" = 1 ]; then echo "  [dry-run] write /etc/cron.d/bunkcraft"
    else echo "30 4 * * * root $DIR/scripts/backup.sh --keep 14 >>/var/log/bunkcraft-backup.log 2>&1" >/etc/cron.d/bunkcraft; fi
  else
    warn "no systemd and no cron: schedule '$DIR/scripts/backup.sh' yourself"
  fi
fi

# ---------------------------------------------------------------- pull (or build) and start
# From the install directory, so compose finds its files and reads .env (COMPOSE_FILE, BUNKCRAFT_TAG).
compose() { (cd "$DIR" && docker compose "$@"); }
if [ "$START" = 1 ]; then
  if [ "$PROXY" = none ] && [ "$DRY" = 0 ] && [ -n "$(compose --profile caddy ps -aq caddy 2>/dev/null)" ]; then
    say "switching to --proxy none: removing the Caddy container (certificates stay in the caddy-data volume)"
    compose --profile caddy rm -sf caddy >/dev/null 2>&1 || warn "could not remove the Caddy container: docker compose --profile caddy rm -sf caddy"
  fi
  if [ "$MODE" = build ]; then
    say "building and starting (the first build takes a few minutes)"
    run compose up -d --build --remove-orphans || warn "not every container started (see the health check below)"
  else
    say "pulling the images and starting"
    run compose pull --quiet
    run compose up -d --remove-orphans || warn "not every container started (see the health check below)"
  fi
  if [ "$DRY" = 0 ]; then
    ok=0
    for _ in $(seq 1 60); do
      if compose exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
      sleep 2
    done
    [ "$ok" = 1 ] || die "the game server is not healthy: see 'bunkcraft logs'."
    if [ "$PROXY" = none ] && have curl; then
      probe="$BIND_ADDR"; [ "$probe" = 0.0.0.0 ] && probe=127.0.0.1
      curl -fsS -m 5 "http://$probe:${GAME_PORT}/health" >/dev/null 2>&1 \
        || warn "the game is healthy in its container but not reachable on ${BIND_ADDR}:${GAME_PORT} from here: is the port in use?"
    fi
  fi
fi

# ---------------------------------------------------------------- auto-update timer (bunkcraft autoupdate on|off)
# After the start, so its first run never races the pull/start above.
AUTOUPDATE_NOW="$AUTOUPDATE_ARG"
if [ -z "$AUTOUPDATE_NOW" ]; then
  AUTOUPDATE_NOW="$( [ -f "$ENV_FILE" ] && sed -n 's/^AUTOUPDATE=//p' "$ENV_FILE" | tail -n1 || true)"
fi
if [ "${AUTOUPDATE_NOW:-on}" = off ]; then
  say "auto-update: off (turn on with 'bunkcraft autoupdate on')"
  run "$DIR/scripts/bunkcraft.sh" autoupdate off >/dev/null
else
  say "auto-update: new builds of the channel are deployed by themselves at a quiet moment ('bunkcraft autoupdate off' stops it)"
  run "$DIR/scripts/bunkcraft.sh" autoupdate on
fi

if [ "$DRY" = 1 ]; then echo; say "dry run finished: nothing was changed"; exit 0; fi
if [ "$PROXY" = none ]; then
  HOST_IP="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
  if [ "$BIND_ADDR" = 127.0.0.1 ]; then TARGET="127.0.0.1:${GAME_PORT}"; else TARGET="${HOST_IP:-<ip of this server>}:${GAME_PORT}"; fi
  TAG_NOW="$(env_value BUNKCRAFT_TAG)"
  cat <<EOF

BunkCraft is running (no proxy: for a Cloudflare Tunnel).
  Game server:  http://${BIND_ADDR}:${GAME_PORT}   (check: curl http://127.0.0.1:${GAME_PORT}/health)

  Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public Hostname → Add:
      Hostname:  ${DOMAIN:-play.example.com}
      Service:   HTTP   ${TARGET}          (= http://${TARGET})
  WebSockets work through a tunnel by default; nothing else to enable.
EOF
  if [ "$BIND_ADDR" = 127.0.0.1 ]; then
    echo "  Bound to 127.0.0.1: cloudflared must run on THIS machine. cloudflared elsewhere? Re-run with --bind 0.0.0.0."
  else
    echo "  Bound to ${BIND_ADDR}: let only the cloudflared machine reach port ${GAME_PORT} (TRUST_CLOUDFLARE=1 trusts the CF-Connecting-IP header)."
  fi
  cat <<EOF

  Admin:     https://${DOMAIN:-<your hostname>}/admin   token: ADMIN_TOKEN in $ENV_FILE
  Metrics:   https://${DOMAIN:-<your hostname>}/metrics with 'Authorization: Bearer <METRICS_TOKEN>'
  Commands:  bunkcraft status | logs | update | rollback | backup | restart | autoupdate [on|off|status]
  Updates:   automatic, channel '${TAG_NOW:-latest}' (every green push to main); check: bunkcraft autoupdate status
  Version:   /health shows the version and commit that are live
  Settings:  $ENV_FILE (docs/SERVER.md), then 'bunkcraft restart'
EOF
  exit 0
fi
cat <<EOF

BunkCraft is running.
  Play:      https://$DOMAIN   (the first visit can take ~30 s while Caddy gets the certificate)
  Admin:     https://$DOMAIN/admin   token: ADMIN_TOKEN in $ENV_FILE
  Metrics:   https://$DOMAIN/metrics with 'Authorization: Bearer <METRICS_TOKEN>'
  Commands:  bunkcraft status | logs | update | rollback | backup | restart | autoupdate [on|off|status]
  Version:   https://$DOMAIN/health shows the version and commit that are live
  Settings:  $ENV_FILE (docs/SERVER.md), then 'bunkcraft restart'
EOF

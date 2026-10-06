#!/usr/bin/env bash
# BunkCraft: one-command install on a fresh Ubuntu or Debian server (Docker + Caddy with automatic HTTPS).
#
#   curl -fsSL https://raw.githubusercontent.com/stijnvandepol/Bunkcraft/main/scripts/install.sh \
#     | sudo bash -s -- --domain play.example.com
#   # or from a checkout:
#   sudo ./scripts/install.sh --domain play.example.com [--admin-token TOKEN]
#
# Safe to run again (idempotent): it only installs what is missing, keeps the existing .env values and
# worlds, and rebuilds/restarts the containers. See docs/SERVER.md ("Op je eigen Linux-server in 5 minuten").
#
# Options (or the environment variable in brackets):
#   --domain NAME        domain that points at this server (DOMAIN); asked when missing and a terminal is attached
#   --admin-token TOKEN  admin token for /admin (ADMIN_TOKEN); generated when missing
#   --dir PATH           where the code lives (BUNKCRAFT_DIR); default: this checkout, else /opt/bunkcraft
#   --repo URL           git repository to clone (BUNKCRAFT_REPO)
#   --branch NAME        branch to clone/follow (BUNKCRAFT_BRANCH, default main)
#   --no-firewall        do not touch ufw
#   --no-swap            do not create a swap file on small machines
#   --no-backups         do not install the daily backup timer
#   --no-start           prepare everything but do not build/start the containers
#   --dry-run            print what would happen, change nothing (works without root)
#   -h, --help
set -euo pipefail

DOMAIN="${DOMAIN:-}"
ADMIN_TOKEN_ARG="${ADMIN_TOKEN:-}"
DIR="${BUNKCRAFT_DIR:-}"
REPO="${BUNKCRAFT_REPO:-https://github.com/stijnvandepol/Bunkcraft.git}"
BRANCH="${BUNKCRAFT_BRANCH:-main}"
FIREWALL=1 SWAP=1 BACKUPS=1 START=1 DRY=0
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
    --no-firewall) FIREWALL=0; shift ;;
    --no-swap) SWAP=0; shift ;;
    --no-backups) BACKUPS=0; shift ;;
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

# The domain: argument, existing .env, or ask.
if [ -z "$DOMAIN" ] && [ -f "$DIR/.env" ]; then DOMAIN="$(sed -n 's/^DOMAIN=//p' "$DIR/.env" | tail -n1)"; fi
if [ -z "$DOMAIN" ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  printf 'Domain for BunkCraft (e.g. play.example.com): ' >/dev/tty
  read -r DOMAIN </dev/tty || true
fi
[ -n "$DOMAIN" ] || die "no domain: pass --domain play.example.com (an A/AAAA record must point at this server)."
case "$DOMAIN" in
  *[!A-Za-z0-9.:-]*) die "domain '$DOMAIN' contains invalid characters." ;;
esac

say "BunkCraft install: domain $DOMAIN, directory $DIR$([ "$DRY" = 1 ] && echo ' (dry run)')"

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

# ---------------------------------------------------------------- swap on small machines
# Building the image (TypeScript + Vite) needs more than 1 GB; the running server needs far less.
MEM_MB=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 2048)
if [ "$SWAP" = 1 ] && [ "$MEM_MB" -lt 1900 ] && [ "$(awk 'NR > 1' /proc/swaps 2>/dev/null | wc -l)" -eq 0 ]; then
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
set_env DOMAIN "$DOMAIN" 1
set_env ALLOWED_ORIGINS "https://$DOMAIN"
if [ -n "$ADMIN_TOKEN_ARG" ]; then set_env ADMIN_TOKEN "$ADMIN_TOKEN_ARG" 1; else set_env ADMIN_TOKEN "$(token)"; fi
set_env METRICS_TOKEN "$(token)"
set_env BUNKCRAFT_CPUS "$CPUS"
set_env BUNKCRAFT_MEMORY "${CONTAINER_MB}m"
set_env BUNKCRAFT_NODE_OPTIONS "--max-old-space-size=$HEAP_MB --max-semi-space-size=16"
say ".env ready ($ENV_FILE, mode 600): ${CPUS} CPU, ${CONTAINER_MB} MB for the game server"

# ---------------------------------------------------------------- firewall
if [ "$FIREWALL" = 1 ]; then
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
if have getent; then
  resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
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

# ---------------------------------------------------------------- build and start
if [ "$START" = 1 ]; then
  say "building and starting (first build takes a few minutes)"
  run docker compose --project-directory "$DIR" up -d --build --remove-orphans
  if [ "$DRY" = 0 ]; then
    ok=0
    for _ in $(seq 1 60); do
      if docker compose --project-directory "$DIR" exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
      sleep 2
    done
    [ "$ok" = 1 ] || die "the game server is not healthy: see 'bunkcraft logs'."
  fi
fi

if [ "$DRY" = 1 ]; then echo; say "dry run finished: nothing was changed"; exit 0; fi
cat <<EOF

BunkCraft is running.
  Play:      https://$DOMAIN   (the first visit can take ~30 s while Caddy gets the certificate)
  Admin:     https://$DOMAIN/admin   token: ADMIN_TOKEN in $ENV_FILE
  Metrics:   https://$DOMAIN/metrics with 'Authorization: Bearer <METRICS_TOKEN>'
  Commands:  bunkcraft status | logs | update | backup | restart
  Settings:  $ENV_FILE (docs/SERVER.md), then 'bunkcraft restart'
EOF

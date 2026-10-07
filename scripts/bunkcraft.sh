#!/usr/bin/env bash
# BunkCraft server helper (install.sh links it as /usr/local/bin/bunkcraft).
#
#   bunkcraft status       containers, image version, health (version, players, games, tick p99, memory)
#   bunkcraft logs         follow the game server log (Ctrl+C to stop)
#   bunkcraft update       pull the new image, backup, restart, roll back by itself if unhealthy
#                          (options: --tag TAG, --build, --pull, --force, --dry-run; see scripts/update.sh)
#   bunkcraft rollback     back to the image that ran before the last update
#   bunkcraft backup       backup now (scripts/backup.sh)
#   bunkcraft restart      restart after changing .env (worlds are saved first)
#   bunkcraft autoupdate   check for a new build of the channel and deploy it at a quiet moment
#                          (scripts/autoupdate.sh; the timer runs this every AUTOUPDATE_INTERVAL)
#   bunkcraft autoupdate on|off   turn the auto-update timer on or off (AUTOUPDATE in .env)
#   bunkcraft autoupdate status   setting, timer, whether an update is waiting, the deploy log
#   bunkcraft deploy       the auto-update flow now, also when AUTOUPDATE=off (push deploys over SSH)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
# shellcheck source=scripts/lib/deploy.sh
. scripts/lib/deploy.sh

UNIT=/etc/systemd/system/bunkcraft-autoupdate
CRON=/etc/cron.d/bunkcraft-autoupdate

autoupdate_on() {
  local interval minutes
  interval="$(setting AUTOUPDATE_INTERVAL 5min)"
  [[ "$interval" =~ ^[0-9]+(m|min|h)?$ ]] || { echo "AUTOUPDATE_INTERVAL '$interval' is not like 5min, 15m or 1h" >&2; exit 2; }
  case "$interval" in *h) minutes=$(( ${interval%h} * 60 )) ;; *) minutes="${interval%%[a-z]*}" ;; esac
  [ "$minutes" -ge 1 ] || { echo "AUTOUPDATE_INTERVAL must be at least a minute" >&2; exit 2; }
  dotenv_set AUTOUPDATE on
  if [ -d /run/systemd/system ]; then
    cat >"$UNIT.service" <<EOF
[Unit]
Description=BunkCraft auto-update (new build of the configured channel)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$(pwd)/scripts/autoupdate.sh
# It may wait up to AUTOUPDATE_MAX_WAIT_MIN for a quiet server, then update and run the checks.
TimeoutStartSec=3h
Nice=10
EOF
    cat >"$UNIT.timer" <<EOF
[Unit]
Description=BunkCraft auto-update every ${minutes} min

[Timer]
# Relative to the timer's start (boot, or 'autoupdate on'), then N minutes after each run ended.
OnActiveSec=2min
OnUnitInactiveSec=${minutes}min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now bunkcraft-autoupdate.timer >/dev/null
    echo "auto-update on: every ${minutes} min (systemd: bunkcraft-autoupdate.timer; logs: journalctl -u bunkcraft-autoupdate)"
  elif [ -d /etc/cron.d ]; then
    local log; log="$(setting BUNKCRAFT_DEPLOY_LOG /var/log/bunkcraft-deploy.log)"
    echo "*/${minutes} * * * * root $(pwd)/scripts/autoupdate.sh >>${log%.log}-run.log 2>&1" >"$CRON"
    echo "auto-update on: every ${minutes} min ($CRON)"
  else
    echo "no systemd and no cron: run '$(pwd)/scripts/autoupdate.sh' every few minutes yourself" >&2
  fi
}

autoupdate_off() {
  dotenv_set AUTOUPDATE off
  if [ -d /run/systemd/system ] && [ -f "$UNIT.timer" ]; then systemctl disable --now bunkcraft-autoupdate.timer >/dev/null 2>&1 || true; fi
  rm -f "$CRON"
  echo "auto-update off ('bunkcraft update' or 'bunkcraft deploy' still update by hand)"
}

autoupdate_status() {
  echo "AUTOUPDATE=$(setting AUTOUPDATE on), channel BUNKCRAFT_TAG=$(setting BUNKCRAFT_TAG latest), wait for a quiet server: $(setting AUTOUPDATE_WAIT_FOR_EMPTY 1) (at most $(setting AUTOUPDATE_MAX_WAIT_MIN 30) min)"
  if [ -d /run/systemd/system ] && [ -f "$UNIT.timer" ]; then
    systemctl list-timers --all --no-pager bunkcraft-autoupdate.timer | head -n 2
  elif [ -f "$CRON" ]; then
    echo "cron: $(cat "$CRON")"
  else
    echo "no timer installed ('bunkcraft autoupdate on')"
  fi
  local rc=0; ./scripts/autoupdate.sh --check || rc=$?
  [ "$rc" = 10 ] && echo "(the next timer run deploys it, or now: bunkcraft deploy)"
  local file; file="$(setting BUNKCRAFT_DEPLOY_LOG /var/log/bunkcraft-deploy.log)"
  if [ -f "$file" ]; then echo; echo "deploy log ($file):"; tail -n 10 "$file"; fi
}

case "${1:-status}" in
  status)
    docker compose ps
    echo
    ref="$(docker compose config --images bunkcraft)"
    cid="$(docker compose ps -q bunkcraft | head -n1)"
    if [ -n "$cid" ]; then
      id="$(docker inspect --format '{{.Image}}' "$cid")"
      digest="$(docker image inspect --format '{{join .RepoDigests " "}}' "$id" 2>/dev/null || true)"
      echo "image: $ref, id ${id:7:12}${digest:+, $digest}"
    fi
    docker compose exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health && echo
    ;;
  logs) docker compose logs -f --tail=100 bunkcraft ;;
  update) shift; exec ./scripts/update.sh "$@" ;;
  rollback) shift; exec ./scripts/update.sh --rollback "$@" ;;
  backup) shift; exec ./scripts/backup.sh "$@" ;;
  restart) docker compose up -d --force-recreate bunkcraft ;;
  autoupdate)
    shift
    case "${1:-run}" in
      on) autoupdate_on ;;
      off) autoupdate_off ;;
      status) autoupdate_status ;;
      run) shift || true; exec ./scripts/autoupdate.sh "$@" ;;
      *) exec ./scripts/autoupdate.sh "$@" ;;
    esac
    ;;
  # Push deploys (GitHub Actions over SSH, docs/SERVER.md) run exactly this, through a forced command.
  deploy) shift; exec ./scripts/autoupdate.sh --force --wait-lock "$@" ;;
  -h|--help|help) sed -n '2,/^set -euo/p' "$(readlink -f "$0")" | sed -e '$d' -e 's/^# \{0,1\}//' ;;
  *) echo "unknown command: $1 (bunkcraft help)" >&2; exit 2 ;;
esac

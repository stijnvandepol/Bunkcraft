#!/usr/bin/env bash
# BunkCraft server helper (install.sh links it as /usr/local/bin/bunkcraft).
#
#   bunkcraft status     containers, health (players, games, tick p99, memory)
#   bunkcraft logs       follow the game server log (Ctrl+C to stop)
#   bunkcraft update     backup, pull, rebuild, restart (scripts/update.sh)
#   bunkcraft backup     backup now (scripts/backup.sh)
#   bunkcraft restart    restart after changing .env (worlds are saved first)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

case "${1:-status}" in
  status)
    docker compose ps
    echo
    docker compose exec -T bunkcraft wget -qO- http://127.0.0.1:3000/health && echo
    ;;
  logs) docker compose logs -f --tail=100 bunkcraft ;;
  update) shift; exec ./scripts/update.sh "$@" ;;
  backup) shift; exec ./scripts/backup.sh "$@" ;;
  restart) docker compose up -d --force-recreate bunkcraft ;;
  -h|--help|help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "unknown command: $1 (bunkcraft help)" >&2; exit 2 ;;
esac

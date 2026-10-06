#!/usr/bin/env bash
# BunkCraft server helper (install.sh links it as /usr/local/bin/bunkcraft).
#
#   bunkcraft status     containers, image version, health (players, games, tick p99, memory)
#   bunkcraft logs       follow the game server log (Ctrl+C to stop)
#   bunkcraft update     pull the new image, backup, restart, roll back by itself if unhealthy
#                        (options: --tag TAG, --build, --pull, --force, --dry-run; see scripts/update.sh)
#   bunkcraft rollback   back to the image that ran before the last update
#   bunkcraft backup     backup now (scripts/backup.sh)
#   bunkcraft restart    restart after changing .env (worlds are saved first)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

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
  -h|--help|help) sed -n '2,/^set -euo/p' "$(readlink -f "$0")" | sed -e '$d' -e 's/^# \{0,1\}//' ;;
  *) echo "unknown command: $1 (bunkcraft help)" >&2; exit 2 ;;
esac

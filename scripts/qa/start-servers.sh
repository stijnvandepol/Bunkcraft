#!/usr/bin/env bash
# Starts a throwaway game server (fresh DATA_DIR) and a QA Vite dev server for the multiplayer QA scripts.
#   scripts/qa/start-servers.sh [serverPort=3471] [vitePort=5191] [dir=$(mktemp -d)]
# Logs: <dir>/server.log and <dir>/vite.log; PIDs in <dir>/pids (kill $(cat <dir>/pids) to stop).
set -euo pipefail
cd "$(dirname "$0")/../.."
SP=${1:-3471}; VP=${2:-5191}; DD=${3:-$(mktemp -d -t bunkqa)}
mkdir -p "$DD"
PORT=$SP DATA_DIR="$DD/data" ROOM_CREATE_LIMIT=1000 MAX_CONN_PER_IP=100 LOG_FORMAT=text \
  nohup npx tsx server/index.ts >"$DD/server.log" 2>&1 &
echo $! >"$DD/pids"
QA_SERVER_PORT=$SP nohup npx vite --config scripts/qa/vite.qa.config.ts --port "$VP" --strictPort >"$DD/vite.log" 2>&1 &
echo $! >>"$DD/pids"
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$SP/health" >/dev/null && curl -sf "http://localhost:$VP/" >/dev/null; then break; fi
  sleep 0.5
done
echo "server :$SP  vite :$VP  dir $DD"

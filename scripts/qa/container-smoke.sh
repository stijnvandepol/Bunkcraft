#!/usr/bin/env bash
# Real-Docker smoke test of MATCH_ISOLATION=container (docs/SERVER.md "Een container per lobby").
#
#   scripts/qa/container-smoke.sh            build the image, run the checks, clean up
#   SMOKE_BUILD=0 scripts/qa/container-smoke.sh   reuse bunkcraft-smoke:local
#
# Runs its own compose project (bcsmoke) on 127.0.0.1:$SMOKE_PORT with its own network (bcsmoke_match) and owner
# label (bcsmoke). It never touches other containers or port 3000. Steps:
#   1. stack up: control plane + Docker gate; a warm match runner appears
#   2. a TDM lobby with bots runs in a match container; join, binary frames, server-side ping through the proxy
#   3. the match container's hardening as Docker sees it; the Docker gate refuses what it must refuse (a privileged
#      create, any action on a container that is not ours, exec, images, volumes, path tricks, a wrong secret);
#      the gate itself runs non-root and read-only; a match container has no route to the internet
#   4. the control plane is recreated (an update): the match keeps running, the new control plane adopts it,
#      the player's seat is offered and taken back
#   5. baseline: the same lobby in-process (MATCH_ISOLATION=inprocess), same ping measurement
# Measurements go to stdout as JSON lines. If the Docker credential helper hangs, run with
# DOCKER_CONFIG=<dir with an empty config.json> (the script does that itself when SMOKE_DOCKER_CONFIG=1).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/../.."

PORT="${SMOKE_PORT:-38417}"
IMAGE="${SMOKE_IMAGE:-bunkcraft-smoke}"
TAG="${SMOKE_TAG:-local}"
STATE="$(mktemp -t bcsmoke.XXXXXX)"
if [ "${SMOKE_DOCKER_CONFIG:-0}" = 1 ]; then
  export DOCKER_CONFIG="$(mktemp -d -t bcsmoke-docker.XXXXXX)"
  plugins=/Applications/Docker.app/Contents/Resources/cli-plugins
  if [ -d "$plugins" ]; then echo "{\"cliPluginsExtraDirs\":[\"$plugins\"]}" > "$DOCKER_CONFIG/config.json"; else echo '{}' > "$DOCKER_CONFIG/config.json"; fi
fi

export COMPOSE_PROJECT_NAME=bcsmoke
export COMPOSE_FILE=docker-compose.yml:docker-compose.matches.yml:docker-compose.direct.yml
export BUNKCRAFT_IMAGE="$IMAGE" BUNKCRAFT_TAG="$TAG" BUNKCRAFT_PORT="$PORT" BIND_ADDR=127.0.0.1
export MATCH_NETWORK_NAME=bcsmoke_match MATCH_OWNER=bcsmoke MAIN_WORLD=off TRUST_PROXY=0
export ADMIN_TOKEN="smoke-$(openssl rand -hex 16)"
export DOCKER_GATE_SECRET="$(openssl rand -hex 24)"
export MATCH_WARM_POOL=1 MAX_MATCH_CONTAINERS=4 MATCH_IDLE_GRACE_SEC=30 MATCH_ISOLATION=container
[ "$PORT" = 3000 ] && { echo "SMOKE_PORT must not be 3000" >&2; exit 2; }

say() { printf '\n== %s\n' "$*"; }
ours() { docker ps -q --filter "label=nl.bunkhosting.bunkcraft.owner=bcsmoke" --filter "label=nl.bunkhosting.bunkcraft.role=match"; }
cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    say "FAILED ($status): last log lines"
    docker compose logs --tail=40 bunkcraft docker-gate 2>&1 || true
    for id in $(ours); do docker logs --tail=20 "$id" 2>&1 || true; done
  fi
  say "cleanup"
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  # Match containers are not compose services: stop exactly ours (AutoRemove deletes them).
  ids="$(ours)"; [ -z "$ids" ] || docker stop $ids >/dev/null 2>&1 || true
  docker network rm bcsmoke_match >/dev/null 2>&1 || true
  rm -f "$STATE"
}
trap cleanup EXIT

health() {
  for _ in $(seq 1 90); do
    curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker compose logs --tail=80 bunkcraft docker-gate >&2
  return 1
}
client() { node --import tsx scripts/qa/container-smoke.ts "http://127.0.0.1:$PORT" "$ADMIN_TOKEN" "$STATE" "$@"; }

if [ "${SMOKE_BUILD:-1}" = 1 ]; then
  say "build $IMAGE:$TAG"
  DOCKER_BUILDKIT=1 docker buildx build --load -t "$IMAGE:$TAG" . >/dev/null
fi

# The gate runs as uid 1000 plus the group that owns the Docker socket (install.sh reads it on a Linux host).
DOCKER_GID="$(docker run --rm --entrypoint stat -v /var/run/docker.sock:/s "$IMAGE:$TAG" -c %g /s)"
export DOCKER_GID
echo "{\"dockerGid\":$DOCKER_GID}"

say "1. stack up (control plane + Docker gate)"
t0=$(date +%s)
docker compose up -d >/dev/null
health
echo "{\"stackUpSec\":$(( $(date +%s) - t0 ))}"

say "2. a lobby in a match container"
client join

say "3. hardening of the match container"
cid="$(ours | head -n1)"
[ -n "$cid" ] || { echo "no match container" >&2; exit 1; }
docker inspect --format '{"user":"{{.Config.User}}","readonly":{{.HostConfig.ReadonlyRootfs}},"capDrop":"{{.HostConfig.CapDrop}}","privileged":{{.HostConfig.Privileged}},"network":"{{.HostConfig.NetworkMode}}","memory":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}},"pids":{{.HostConfig.PidsLimit}},"binds":"{{.HostConfig.Binds}}","ports":"{{.HostConfig.PortBindings}}","autoRemove":{{.HostConfig.AutoRemove}}}' "$cid"
[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.HostConfig.Privileged}}' "$cid")" = "true 1000:1000 false" ] || { echo "hardening check failed" >&2; exit 1; }
# The internal network has no route out.
if docker exec "$cid" wget -q -T 3 -O /dev/null http://1.1.1.1 2>/dev/null; then echo "match container reached the internet" >&2; exit 1; fi
echo '{"internet":"blocked"}'
# The Docker gate: our containers yes, everything else no. Asked from the control plane, the only one on that network.
probe() { # method path [body] [secret]
  docker compose exec -T -e P_METHOD="$1" -e P_PATH="$2" -e P_BODY="${3:-}" -e P_SECRET="${4:-$DOCKER_GATE_SECRET}" bunkcraft sh -c '
    set -- -q -O /dev/null -S --header "authorization: Bearer $P_SECRET"
    if [ "$P_METHOD" = POST ]; then set -- "$@" --header "content-type: application/json" --post-data "$P_BODY"; fi
    wget "$@" "http://docker-gate:2375$P_PATH"' 2>&1 | sed -n 's/^ *HTTP\/[0-9.]* \([0-9]*\).*/\1/p' | tail -n1 || true
}
cp_id="$(docker compose ps -q bunkcraft)"
g_list="$(probe GET /containers/json)"
g_ours="$(probe GET "/containers/$cid/json")"
g_images="$(probe GET /images/json)"
g_exec="$(probe POST "/containers/$cid/exec" '{"Cmd":["id"]}')"
g_volumes="$(probe GET /volumes)"
g_secret="$(probe GET /containers/json '' wrong-secret-wrong-secret-wrong-secret)"
g_privileged="$(probe POST /containers/create?name=bunkcraft-match-smokeprivileged '{"Image":"alpine","User":"0","HostConfig":{"Privileged":true,"Binds":["/:/host"],"NetworkMode":"host"}}')"
g_stop="$(probe POST "/containers/$cp_id/stop?t=1")"
g_kill="$(probe POST "/containers/$cp_id/kill")"
g_inspect="$(probe GET "/v1.44/containers/$cp_id/json")"
g_traversal="$(probe GET "/containers/$cid/../../images/json")"
echo "{\"gate\":{\"list\":\"$g_list\",\"ours\":\"$g_ours\",\"images\":\"$g_images\",\"exec\":\"$g_exec\",\"volumes\":\"$g_volumes\",\"wrongSecret\":\"$g_secret\",\"privilegedCreate\":\"$g_privileged\",\"foreignStop\":\"$g_stop\",\"foreignKill\":\"$g_kill\",\"foreignInspect\":\"$g_inspect\",\"traversal\":\"$g_traversal\"}}"
[ "$g_list" = 200 ] && [ "$g_ours" = 200 ] && [ "$g_images" = 403 ] && [ "$g_exec" = 403 ] && [ "$g_volumes" = 403 ] && [ "$g_secret" = 401 ] \
  && [ "$g_privileged" = 403 ] && [ "$g_stop" = 403 ] && [ "$g_kill" = 403 ] && [ "$g_inspect" = 403 ] && [ "$g_traversal" = 403 ] \
  || { echo "Docker gate allowlist check failed" >&2; exit 1; }
# Nothing was created, and the control plane (not ours to touch) still runs.
[ -z "$(docker ps -aq --filter name=bunkcraft-match-smokeprivileged)" ] || { echo "the privileged create reached Docker" >&2; exit 1; }
[ "$(docker inspect --format '{{.State.Running}}' "$cp_id")" = true ] || { echo "the control plane was stopped through the gate" >&2; exit 1; }
# The gate itself: non-root, read-only, not privileged, only on the internal docker-api network, no published port.
gate_id="$(docker compose ps -q docker-gate)"
docker inspect --format '{"gateUser":"{{.Config.User}}","readonly":{{.HostConfig.ReadonlyRootfs}},"capDrop":"{{.HostConfig.CapDrop}}","groups":"{{.HostConfig.GroupAdd}}","networks":"{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}","ports":"{{.HostConfig.PortBindings}}"}' "$gate_id"
[ "$(docker inspect --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}' "$gate_id")" = "1000:1000 true false" ] || { echo "gate hardening check failed" >&2; exit 1; }
[ "$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$gate_id")" = "bcsmoke_docker-api " ] || { echo "the gate is on more than the docker-api network" >&2; exit 1; }

say "4. control plane update: the match keeps running"
before="$(ours | sort | tr '\n' ' ')"
t0=$(date +%s)
docker compose up -d --force-recreate bunkcraft >/dev/null
health
echo "{\"controlPlaneRestartSec\":$(( $(date +%s) - t0 ))}"
client rejoin
after="$(ours | sort | tr '\n' ' ')"
# The lobby's container survives (the idle warm one of the old control plane is stopped by design, in random id order).
survived=0; for id in $before; do case " $after " in *" $id "*) survived=1 ;; esac; done
[ "$survived" = 1 ] || { echo "match container did not survive: before [$before] after [$after]" >&2; exit 1; }
docker stats --no-stream --format '{"container":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}"}' $(ours) "$(docker compose ps -q bunkcraft)"

say "5. baseline: the same lobby in-process"
export MATCH_ISOLATION=inprocess
docker compose up -d --force-recreate bunkcraft >/dev/null
health
client ping

say "container smoke test passed"

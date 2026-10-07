# BunkCraft: game + multiplayer server in one container (multi-stage, non-root).
#
# Pin the base image by digest for reproducible builds (docs/SECURITY.md):
#   docker buildx imagetools inspect node:24-alpine   ->  FROM node:24-alpine@sha256:...
# Node 24 is the current LTS; the server bundle targets Node 22+ (docs/research/SERVER-DEPLOY.md).
ARG NODE_IMAGE=node:24-alpine

# ---- build: all dependencies, type check, client bundle (dist/) and server bundle (dist-server/) ----
# Runs on the builder's own platform: the output is plain JS, identical for every target architecture, so a
# multi-arch build (CI: linux/amd64 + linux/arm64) builds once and needs no emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The commit being built (CI passes --build-arg GIT_SHA=<sha>): the title screen shows it (VITE_GIT_SHA).
# Declared after npm ci so a new commit does not invalidate the dependency layer.
ARG GIT_SHA=""
RUN VITE_GIT_SHA="$GIT_SHA" npm run build && mkdir -p /out/data

# ---- runtime: plain Node and two build outputs. No node_modules, no TypeScript at runtime. ----
# No RUN in this stage: nothing executes for the target architecture, so arm64 builds fine on amd64 without QEMU.
FROM ${NODE_IMAGE}
WORKDIR /app
# Heap limits fit the compose memory limit (docker-compose.yml); measured in docs/research/SERVER-DEPLOY.md.
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data \
    NODE_OPTIONS="--max-old-space-size=384 --max-semi-space-size=16"
# /health reports "<package version>+<short commit>" (server/App.ts), so 'bunkcraft status' shows what is live.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
# The server reads its version from package.json; dist-server/index.js bundles ws and the shared game code,
# dist-server/genWorker.js is the chunk generation thread (CHUNK_WORKERS).
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server/index.js /app/dist-server/genWorker.js ./dist-server/
# The world (edits, players, time) lives here; the unprivileged "node" user owns it. Mount a volume to keep it.
COPY --from=build --chown=node:node /out/data /app/data
VOLUME ["/app/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
# node (not npm) is PID 1 so SIGTERM reaches the server and it saves the worlds before exiting.
CMD ["node", "dist-server/index.js"]

# BunkCraft: game + multiplayer server in one container (multi-stage, non-root).
#
# Pin the base image by digest for reproducible builds (docs/SECURITY.md):
#   docker buildx imagetools inspect node:22-alpine   ->  FROM node:22-alpine@sha256:...
ARG NODE_IMAGE=node:22-alpine

# ---- build: all dependencies, type check and bundle the client ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production dependencies only (ws, fflate, tsx) and no build tools ----
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tsconfig.json ./
COPY server ./server
# The server shares the protocol, terrain and block code with the client.
COPY src ./src
# The world (edits, players, time) lives here; the unprivileged "node" user owns it. Mount a volume to keep it.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
# node (not npm) is PID 1 so SIGTERM reaches the server and it saves the worlds before exiting.
CMD ["node", "--import", "tsx", "server/index.ts"]

# BunkCraft: game + multiplayer server in one container.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
# The world (edits, players, time) is stored here; mount a volume to keep it.
VOLUME ["/app/data"]
CMD ["npm", "start"]

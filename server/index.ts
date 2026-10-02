/**
 * BunkCraft server: serves the built game (dist/) and hosts the multiplayer
 * WebSocket on the same port, so everything runs in one place.
 *
 *   npm run build && npm start
 *
 * Environment: PORT (3000), DATA_DIR (./data), WORLD_NAME, SEED, GAMEMODE
 * (survival|creative|hardcore|spectator), MOTD, MAX_PLAYERS (20).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { GameServer, parseGameMode } from './GameServer';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = resolve(process.env.STATIC_DIR ?? 'dist');
const env = process.env;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

const game = new GameServer({
  dataDir: resolve(env.DATA_DIR ?? 'data'),
  worldName: env.WORLD_NAME ?? 'BunkCraft Server',
  seed: env.SEED,
  gameMode: parseGameMode(env.GAMEMODE),
  motd: env.MOTD ?? 'Welcome to BunkCraft!',
  maxPlayers: Number(env.MAX_PLAYERS ?? 20),
});

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: game.playerCount }));
    return;
  }
  // Static files from dist/, guarded against path traversal.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let path = normalize(decoded).replace(/^([/\\])+/, '');
  let file = join(ROOT, path);
  // Require a separator after ROOT so a sibling like "dist-secret/" can't match.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    path = 'index.html';
    file = join(ROOT, path);
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Run "npm run build" first.');
    return;
  }
  const hashed = path.startsWith('assets/');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
});

// WebSocket on the same port at /ws.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
http.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => game.accept(ws));
});

http.listen(PORT, () => {
  console.log(`BunkCraft server on http://localhost:${PORT} (static: ${ROOT})`);
});

const stop = () => {
  console.log('Saving and shutting down...');
  game.shutdown();
  wss.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

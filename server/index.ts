/**
 * BunkCraft server: serves the built game (dist/) and hosts multiplayer on the same port.
 *
 *   npm run build && npm start
 *
 * Multiplayer: players create their own game (room) from the menu and share its code or
 * link; rooms live at /ws/<CODE>. /ws (no code) is the optional always-on main world.
 *
 * Environment: PORT (3000), DATA_DIR (./data), TRUST_PROXY (0|1, behind Caddy/nginx),
 * MAIN_WORLD (on|off), WORLD_NAME, SEED, GAMEMODE, MOTD, MAX_PLAYERS (main world, 20);
 * ROOMS (on|off), MAX_ROOMS (200), ROOM_MAX_PLAYERS (8), ROOM_EXPIRE_DAYS (60),
 * ROOM_CREATE_LIMIT (games one visitor may create per hour, 6).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { type WebSocket, WebSocketServer } from 'ws';
import { GameServer, parseGameMode } from './GameServer';
import { RateLimiter, Rooms } from './Rooms';
import { SECURITY_HEADERS } from './security';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = resolve(process.env.STATIC_DIR ?? 'dist');
const env = process.env;
const flag = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : !/^(0|off|false|no)$/i.test(v));
const TRUST_PROXY = flag(env.TRUST_PROXY, false);
const MAIN_WORLD = flag(env.MAIN_WORLD, true);
const ROOMS_ENABLED = flag(env.ROOMS, true);
const DATA_DIR = resolve(env.DATA_DIR ?? 'data');

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

const main = MAIN_WORLD
  ? new GameServer({
    dataDir: DATA_DIR,
    worldName: env.WORLD_NAME ?? 'BunkCraft Server',
    seed: env.SEED,
    gameMode: parseGameMode(env.GAMEMODE),
    motd: env.MOTD ?? 'Welcome to BunkCraft!',
    maxPlayers: Number(env.MAX_PLAYERS ?? 20),
  })
  : null;

const rooms = ROOMS_ENABLED
  ? new Rooms({
    dataDir: join(DATA_DIR, 'rooms'),
    maxRooms: Number(env.MAX_ROOMS ?? 200),
    maxPlayers: Number(env.ROOM_MAX_PLAYERS ?? 8),
    motd: env.MOTD ?? 'Welcome to BunkCraft! Share the game code with your friends.',
    idleUnloadMs: 5 * 60_000,
    expireDays: Number(env.ROOM_EXPIRE_DAYS ?? 60),
  })
  : null;

// Per client address: creating rooms and looking up codes (stops code guessing).
const createLimit = new RateLimiter(Number(env.ROOM_CREATE_LIMIT ?? 6), 3_600_000);
const lookupLimit = new RateLimiter(40, 60_000);
setInterval(() => { createLimit.prune(); lookupLimit.prune(); }, 600_000).unref();

/** Client address; X-Forwarded-For only when a trusted reverse proxy sets it. */
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

/** JSON API used by the menu: server capabilities, creating a room, looking one up. */
async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const ip = clientIp(req);
  if (path === '/api/server' && req.method === 'GET') {
    return json(res, 200, { rooms: ROOMS_ENABLED, main: MAIN_WORLD, players: (main?.playerCount ?? 0) + (rooms?.playerCount ?? 0) });
  }
  if (!rooms) return json(res, 404, { error: 'Games are disabled on this server' });
  if (path === '/api/rooms' && req.method === 'POST') {
    if (!createLimit.take(ip)) return json(res, 429, { error: 'Too many games created, try again later' });
    let body: { name?: unknown; gameMode?: unknown; seed?: unknown; gameType?: unknown; scoreLimit?: unknown; timeLimitSec?: unknown; mapId?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return json(res, 400, { error: 'Bad request' });
    }
    const code = rooms.create(String(body.name ?? ''), typeof body.gameMode === 'string' ? body.gameMode : undefined,
      typeof body.seed === 'string' ? body.seed : undefined, { gameType: body.gameType, scoreLimit: body.scoreLimit, timeLimitSec: body.timeLimitSec, mapId: body.mapId });
    return code ? json(res, 201, { code }) : json(res, 503, { error: 'This server has reached its game limit' });
  }
  const m = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (m && req.method === 'GET') {
    if (!lookupLimit.take(ip)) return json(res, 429, { error: 'Too many requests' });
    const info = rooms.info(m[1]);
    return info ? json(res, 200, info) : json(res, 404, { error: 'Game not found. Check the code.' });
  }
  return json(res, 404, { error: 'Not found' });
}

// connectionsCheckingInterval: Node only checks the timeouts below every 30 s by default.
const http = createServer({ maxHeaderSize: 16 * 1024, connectionsCheckingInterval: 5_000 }, (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !url.pathname.startsWith('/api/')) {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, players: (main?.playerCount ?? 0) + (rooms?.playerCount ?? 0), rooms: rooms?.count ?? 0 });
  }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url.pathname).catch(() => { if (!res.headersSent) json(res, 500, { error: 'Server error' }); });
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
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

// Slowloris and header floods: a request must arrive quickly and small; idle keep-alive sockets go early.
http.headersTimeout = 15_000;
http.requestTimeout = 30_000;
http.keepAliveTimeout = 5_000;
http.maxHeadersCount = 64;

// WebSocket on the same port: /ws (main world) and /ws/<CODE> (a room).
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
http.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  let target: GameServer | null = null;
  if (path === '/ws') {
    target = main;
  } else {
    const m = /^\/ws\/([^/]+)$/.exec(path);
    if (m && rooms && lookupLimit.take(clientIp(req))) target = rooms.get(m[1])?.server ?? null;
  }
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const server = target;
  wss.handleUpgrade(req, socket, head, (ws) => {
    // noServer mode does not emit 'connection' by itself: track liveness here.
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    server.accept(ws);
  });
});

// Proxies and mobile networks silently drop idle sockets: ping every 25 s, drop dead ones.
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
}, 25_000).unref();

http.listen(PORT, () => {
  console.log(`BunkCraft server on http://localhost:${PORT} (static: ${ROOT}; main world ${MAIN_WORLD ? 'on' : 'off'}, games ${ROOMS_ENABLED ? 'on' : 'off'})`);
});

const stop = () => {
  console.log('Saving and shutting down...');
  main?.shutdown();
  rooms?.shutdown();
  wss.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

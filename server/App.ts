import { SECURITY_HEADERS, clientAddress } from './HttpSecurity';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WebSocket, WebSocketServer } from 'ws';
import { IpBans, adminApi, authorizeAdmin, newAuthLimiter } from './Admin';
import { ADMIN_CSP, ADMIN_HTML } from './AdminPage';
import { backupAll } from './Backup';
import { type Config, backupDirOf } from './Config';
import { GameServer } from './GameServer';
import { log } from './Log';
import { type Gauges, metrics } from './Metrics';
import { Rooms } from './Rooms';
import { gameTypeDef, parseGameType } from '../src/modes/GameTypes';
import { parseListingKind } from '../src/modes/Realms';
import { RateLimiter, bearer, hashPassword, hashToken, newToken, safeEqual } from './Security';
import { ChunkGenPool } from './chunkgen/ChunkGenPool';
import { prewarmNavGraphs } from './bots/BotWorld';
import { ProfileService } from './progression/ProfileService';

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

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string };
    return `${pkg.version ?? '0.0.0'}${process.env.GIT_SHA ? `+${process.env.GIT_SHA.slice(0, 7)}` : ''}`;
  } catch {
    return '0.0.0';
  }
}

/**
 * WebSocket Origin check against ALLOWED_ORIGINS. Browsers always send Origin, so this stops other websites
 * from opening connections with a visitor's browser. Clients without an Origin header (bots, curl) pass:
 * they are not what the check protects against. `same-origin` in the list means "the host of this request".
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0 || !origin) return true;
  const o = origin.replace(/\/+$/, '').toLowerCase();
  if (allowed.includes('*') || allowed.includes(o)) return true;
  if (allowed.includes('same-origin')) {
    try {
      return new URL(o).host === host?.toLowerCase();
    } catch {
      return false;
    }
  }
  return false;
}

export interface RunningServer {
  port: number;
  main: GameServer | null;
  rooms: Rooms | null;
  /** Realms profiles (null when switched off or without games). */
  profiles: ProfileService | null;
  /** Saves everything, tells clients to reconnect after `reconnectMs` (when given), and stops listening. */
  close(reconnectMs?: number): Promise<void>;
}

export async function startServer(config: Config): Promise<RunningServer> {
  const version = serverVersion();
  const backupDir = backupDirOf(config);
  const failLimiter = new RateLimiter(config.passwordFailLimit, 600_000);
  // One pool of chunk generation threads for every game (docs/research/SERVER-DEPLOY.md, A); 0 = the main thread does it.
  const genPool = config.chunkWorkers > 0
    ? new ChunkGenPool({ size: config.chunkWorkers, onError: (message) => log.error('chunk generation', { error: message }) })
    : null;
  metrics.chunkGen = genPool ? () => genPool.getStats() : null;
  const guard = { inventoryGuard: config.inventoryGuard, binary: config.binary, genPool };

  const main = config.mainWorld
    ? new GameServer({
      dataDir: config.dataDir,
      worldName: config.worldName,
      seed: config.seed,
      gameMode: config.gameMode,
      motd: config.motd,
      maxPlayers: config.maxPlayers,
      label: 'main',
      ops: config.ops,
      moderated: config.ops.length > 0 || !!config.adminToken,
      adminToken: config.adminToken,
      failLimiter,
      backupDir: config.backupKeep > 0 ? join(backupDir, 'main') : undefined,
      ...guard,
    })
    : null;

  // Realms progression: one profile service for every game, so XP follows players from lobby to lobby.
  const profiles = config.roomsEnabled && config.profiles
    ? new ProfileService({ dataDir: config.dataDir, maxProfiles: config.maxProfiles, secret: config.profileSecret })
    : null;

  const rooms = config.roomsEnabled
    ? new Rooms({
      dataDir: join(config.dataDir, 'rooms'),
      maxRooms: config.maxRooms,
      maxPlayers: config.roomMaxPlayers,
      motd: config.motd === 'Welcome to BunkCraft!' ? 'Welcome to BunkCraft! Share the game code with your friends.' : config.motd,
      idleUnloadMs: config.roomIdleUnloadMin * 60_000,
      expireDays: config.roomExpireDays,
      adminToken: config.adminToken,
      failLimiter,
      backupDir: config.backupKeep > 0 ? backupDir : undefined,
      listMax: config.listMax,
      quickPlayBots: config.quickPlayBots,
      quickPlayBotDifficulty: config.quickPlayBotDifficulty,
      profiles,
      ...guard,
    })
    : null;

  // Per client address: creating rooms and looking up codes (stops code guessing).
  const createLimit = new RateLimiter(config.roomCreateLimit, 3_600_000);
  const lookupLimit = new RateLimiter(40, 60_000);
  // Listings are cheap (cached 5 s) and a household or LAN party shares one address: several players with the Realms
  // playlist open poll it together (QA round 3: three browsers behind one address got 429s and an error in Browse Lobbies).
  const listLimit = new RateLimiter(120, 60_000);
  // Realms quick play: asking is cheap (it mostly joins an existing lobby); opening a new lobby also takes from createLimit.
  const quickLimit = new RateLimiter(20, 60_000);
  // Profiles: reading and changing one is cheap; creating one writes a file, so it has its own hourly limit.
  const profileLimit = new RateLimiter(60, 60_000);
  const profileCreateLimit = new RateLimiter(config.profileCreateLimit, 3_600_000);
  const ipBans = new IpBans(config.dataDir);
  const adminFailures = newAuthLimiter();
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => { const t = setInterval(fn, ms); t.unref(); timers.push(t); };
  every(600_000, () => { createLimit.prune(); lookupLimit.prune(); listLimit.prune(); quickLimit.prune(); profileLimit.prune(); profileCreateLimit.prune(); failLimiter.prune(); adminFailures.prune(); });
  every(5000, () => metrics.rollWindow());
  // Bot navigation for every arena, built in the background before the first lobby needs it.
  if (rooms && config.botPrewarm) prewarmNavGraphs((ms, n) => log.info('bot nav graphs ready', { graphs: n, ms: Math.round(ms) }));
  if (config.backupKeep > 0) {
    const run = () => backupAll(config.dataDir, backupDir, config.backupKeep);
    setTimeout(run, 2000).unref();
    every(config.backupIntervalMin * 60_000, run);
  }

  let draining = false;
  const gauges = (): Gauges => ({
    players: (main?.playerCount ?? 0) + (rooms?.playerCount ?? 0),
    roomsLoaded: rooms?.loadedCount ?? 0,
    roomsTotal: rooms?.count ?? 0,
    connections: wss.clients.size,
  });

  /** Client address; X-Forwarded-For only when a trusted reverse proxy sets it. */
  function clientIp(req: IncomingMessage): string {
    // Only the last X-Forwarded-For entry (appended by our own proxy) can be trusted: see HttpSecurity.clientAddress.
    const ip = clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress, config.trustProxy);
    // IPv4 clients of a dual-stack socket show up as ::ffff:1.2.3.4; keep one spelling for limits and blocks.
    return ip.replace(/^::ffff:/i, '');
  }

  /** CORS for the JSON API, only for origins in ALLOWED_ORIGINS (without the list there are no CORS headers: same-origin only). */
  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin || config.allowedOrigins.length === 0 || !originAllowed(origin, req.headers.host, config.allowedOrigins)) return;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }

  function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
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

  /** JSON API used by the menu: server capabilities, creating a room, looking one up, the public list. */
  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const ip = clientIp(req);
    if (path === '/api/server' && req.method === 'GET') {
      return json(res, 200, {
        rooms: !!rooms, main: !!main, players: gauges().players,
        // Largest lobby a game may have (ROOM_MAX_PLAYERS): Realms only offers sizes up to it.
        ...(rooms ? { roomMaxPlayers: config.roomMaxPlayers } : {}),
        // What this server can do beyond the basics; clients hide features an older server lacks.
        features: { passwords: true, browse: !!rooms, binary: config.binary, realms: !!rooms, profiles: !!profiles },
      });
    }
    if (path === '/api/profile' || path.startsWith('/api/profile/')) return profileApi(req, res, path, ip);
    if (!rooms) return json(res, 404, { error: 'Games are disabled on this server' });
    if (path === '/api/rooms' && req.method === 'POST') {
      if (!createLimit.take(ip)) {
        metrics.rateLimited('room_create');
        return json(res, 429, { error: 'Too many games created, try again later' });
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: 'Bad request' });
      }
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length > 64) return json(res, 400, { error: 'The password can be at most 64 characters' });
      const ownerToken = newToken();
      const passwordHash = password ? await hashPassword(password) : undefined;
      const code = rooms.create(String(body.name ?? ''), typeof body.gameMode === 'string' ? body.gameMode : undefined,
        typeof body.seed === 'string' ? body.seed : undefined,
        {
          gameType: body.gameType, scoreLimit: body.scoreLimit, timeLimitSec: body.timeLimitSec, mapId: body.mapId, maxPlayers: body.maxPlayers,
          bots: body.bots, botDifficulty: body.botDifficulty,
        },
        { ownerHash: hashToken(ownerToken), passwordHash, listed: body.listed === true });
      // The owner token is shown exactly once: only its hash is stored.
      return code ? json(res, 201, { code, ownerToken, locked: !!passwordHash }) : json(res, 503, { error: 'This server has reached its game limit' });
    }
    if (path === '/api/rooms' && req.method === 'GET') {
      if (url.searchParams.get('public') !== '1') return json(res, 400, { error: 'Use ?public=1 for the server list' });
      if (!listLimit.take(ip)) {
        metrics.rateLimited('room_list');
        return json(res, 429, { error: 'Too many requests' });
      }
      return json(res, 200, { rooms: rooms.listPublic(parseListingKind(url.searchParams.get('kind'))) }, { 'cache-control': 'public, max-age=5' });
    }
    if (path === '/api/realms' && req.method === 'GET') {
      if (!listLimit.take(ip)) {
        metrics.rateLimited('room_list');
        return json(res, 429, { error: 'Too many requests' });
      }
      return json(res, 200, { modes: rooms.modeStats() }, { 'cache-control': 'no-store' });
    }
    if (path === '/api/quickplay' && req.method === 'POST') {
      if (!quickLimit.take(ip)) {
        metrics.rateLimited('quickplay');
        return json(res, 429, { error: 'Too many requests, try again in a minute' });
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: 'Bad request' });
      }
      const mode = parseGameType(body.gameType);
      if (!gameTypeDef(mode).arcade) return json(res, 400, { error: 'Quick play is for Realms game modes' });
      const result = rooms.quickPlay(mode, () => {
        if (createLimit.take(ip)) return true;
        metrics.rateLimited('room_create');
        return false;
      });
      if ('error' in result) {
        return result.error === 'limited'
          ? json(res, 429, { error: 'Too many games created, try again later' })
          : json(res, 503, { error: 'This server has reached its game limit' });
      }
      return json(res, result.created ? 201 : 200, result);
    }
    const m = /^\/api\/rooms\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      if (!lookupLimit.take(ip)) {
        metrics.rateLimited('room_lookup');
        return json(res, 429, { error: 'Too many requests' });
      }
      const info = rooms.info(m[1]);
      return info ? json(res, 200, info) : json(res, 404, { error: 'Game not found. Check the code.' });
    }
    return json(res, 404, { error: 'Not found' });
  }

  /**
   * Realms profiles. The token travels in the Authorization header (never in a URL):
   *   POST /api/profile          the profile of the token, or a new profile and its token (201) without a valid one
   *   GET  /api/profile          the profile of the token (401 without a valid one)
   *   POST /api/profile/equip    { title?, card?, camos?: { weapon: camo } } within the unlocks
   *   POST /api/profile/prestige next prestige at the level cap
   * XP is never accepted from a client: only finished matches grant it (MatchProgress).
   */
  async function profileApi(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    if (!profiles) return json(res, 404, { error: 'Profiles are disabled on this server' });
    if (!profileLimit.take(ip)) {
      metrics.rateLimited('profile');
      return json(res, 429, { error: 'Too many requests' });
    }
    const token = bearer(req.headers.authorization);
    const id = profiles.verify(token);
    const own = id ? profiles.get(id) : null;
    if (path === '/api/profile' && req.method === 'GET') {
      return own ? json(res, 200, { profile: own }) : json(res, 401, { error: 'Unknown profile' });
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad');
    } catch {
      return json(res, 400, { error: 'Bad request' });
    }
    if (path === '/api/profile') {
      if (own) return json(res, 200, { profile: own });
      if (!profileCreateLimit.take(ip)) {
        metrics.rateLimited('profile_create');
        return json(res, 429, { error: 'Too many profiles created, try again later' });
      }
      const made = profiles.create(body.name);
      // The token is shown exactly once; the browser keeps it.
      return made ? json(res, 201, made) : json(res, 503, { error: 'This server keeps no more profiles' });
    }
    if (!own) return json(res, 401, { error: 'Unknown profile' });
    if (path === '/api/profile/equip') {
      const r = profiles.equip(own.id, { title: body.title, card: body.card, camos: body.camos });
      return r!.ok ? json(res, 200, { profile: r!.profile }) : json(res, 409, { error: 'Not unlocked yet', profile: r!.profile });
    }
    if (path === '/api/profile/prestige') {
      const p = profiles.prestige(own.id);
      return p ? json(res, 200, { profile: p }) : json(res, 409, { error: 'Reach the maximum level first' });
    }
    return json(res, 404, { error: 'Not found' });
  }

  /** /metrics: bearer token when METRICS_TOKEN or ADMIN_TOKEN is set; otherwise only from this machine (not via a proxy). */
  function metricsAllowed(req: IncomingMessage): boolean {
    const tokens = [config.metricsToken, config.adminToken].filter((t): t is string => !!t);
    if (tokens.length > 0) {
      const given = bearer(req.headers.authorization);
      return !!given && tokens.some((t) => safeEqual(given, t));
    }
    const addr = req.socket.remoteAddress ?? '';
    return /^(127\.|::1$|::ffff:127\.)/.test(addr) && !req.headers['x-forwarded-for'];
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
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !url.pathname.startsWith('/api/')) {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (url.pathname === '/health') {
      return json(res, draining ? 503 : 200, {
        ok: !draining, version, uptime: Math.round((Date.now() - metrics.startedAt) / 1000),
        players: gauges().players, rooms: rooms?.count ?? 0,
        // Players a restart would interrupt now (Minecraft worlds, running matches): auto-update waits for 0.
        playersInPlay: (main?.playersInPlay ?? 0) + (rooms?.playersInPlay ?? 0),
        // Enough for an uptime check or a quick `curl` to tell a healthy server from an overloaded one.
        roomsLoaded: gauges().roomsLoaded, tickP99Ms: round2(metrics.tickWindow.p99),
        loopLagP99Ms: round2(metrics.loopLag.p99), rssMB: Math.round(process.memoryUsage.rss() / 1048576),
      });
    }
    if (url.pathname === '/metrics') {
      if (!metricsAllowed(req)) return json(res, 401, { error: 'Unauthorized' });
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      res.end(metrics.prometheus(gauges(), version));
      return;
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      if (!config.adminToken) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Admin is disabled (set ADMIN_TOKEN).');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': ADMIN_CSP,
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      });
      res.end(ADMIN_HTML);
      return;
    }
    if (url.pathname.startsWith('/api/admin/') || url.pathname === '/api/admin') {
      if (!config.adminToken) return json(res, 404, { error: 'Admin is disabled' });
      if (!authorizeAdmin({ token: config.adminToken, clientIp, json, failures: adminFailures }, req, res)) return;
      adminApi({
        token: config.adminToken, rooms, main, bans: ipBans, version, gauges, clientIp, readBody, json,
        dropIp: (ip) => { for (const c of wss.clients) if ((c as WebSocket & { ip?: string }).ip === ip) c.terminate(); },
      }, req, res, url.pathname).catch(() => { if (!res.headersSent) json(res, 500, { error: 'Server error' }); });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      api(req, res, url).catch(() => { if (!res.headersSent) json(res, 500, { error: 'Server error' }); });
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
    let file = join(config.staticDir, path);
    // Require a separator after the root so a sibling like "dist-secret/" can't match.
    if (file !== config.staticDir && !file.startsWith(config.staticDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      path = 'index.html';
      file = join(config.staticDir, path);
    }
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Run "npm run build" first.');
      return;
    }
    const hashed = path.startsWith('assets/');
    // `vite build` writes brotli and gzip copies of hashed text assets next to them (vite.config.ts).
    const accept = String(req.headers['accept-encoding'] ?? '');
    const encoding = !hashed ? null
      : /\bbr\b/.test(accept) && existsSync(`${file}.br`) ? 'br'
        : /\bgzip\b/.test(accept) && existsSync(`${file}.gz`) ? 'gzip' : null;
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(encoding ? { 'content-encoding': encoding, vary: 'Accept-Encoding' } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const body = encoding === 'br' ? `${file}.br` : encoding === 'gzip' ? `${file}.gz` : file;
    createReadStream(body).on('error', () => res.destroy()).pipe(res);
  });

  // Slowloris and header floods: a request must arrive quickly and small; idle keep-alive sockets go early.
  http.headersTimeout = 15_000;
  http.requestTimeout = 30_000;
  http.keepAliveTimeout = 5_000;
  http.maxHeadersCount = 64;

  // WebSocket on the same port: /ws (main world) and /ws/<CODE> (a room).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const perIp = new Map<string, number>();
  const alive = new WeakSet<WebSocket>();

  const refuse = (socket: import('node:stream').Duplex, status: string, why: string, ip: string) => {
    metrics.connectionsRefused++;
    log.info('connection refused', { why, ip });
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const ip = clientIp(req);
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (draining) return refuse(socket, '503 Service Unavailable', 'draining', ip);
    if (!originAllowed(req.headers.origin, req.headers.host, config.allowedOrigins)) return refuse(socket, '403 Forbidden', 'origin', ip);
    if (ipBans.has(ip)) return refuse(socket, '403 Forbidden', 'ip banned', ip);
    if (wss.clients.size >= config.maxConnections) return refuse(socket, '503 Service Unavailable', 'max connections', ip);
    if ((perIp.get(ip) ?? 0) >= config.maxConnPerIp) {
      metrics.rateLimited('conn_per_ip');
      return refuse(socket, '429 Too Many Requests', 'per-ip limit', ip);
    }
    let target: GameServer | null = null;
    if (path === '/ws') {
      target = main;
    } else {
      const m = /^\/ws\/([^/]+)$/.exec(path);
      try {
        if (m && rooms && lookupLimit.take(ip)) target = rooms.get(m[1])?.server ?? null;
      } catch (err) {
        // A room whose world file cannot be loaded must not take the whole server down.
        log.error('room load failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!target) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const server = target;
    // Counted only once the handshake completes: ws answers a bad handshake (400) without calling back,
    // and a slot taken before that would never be given back.
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      metrics.connectionsTotal++;
      (ws as WebSocket & { ip?: string }).ip = ip;
      // noServer mode does not emit 'connection' by itself: track liveness here.
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      ws.on('close', () => {
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      });
      server.accept(ws, { ip });
    });
  });

  // Proxies and mobile networks silently drop idle sockets: ping every 25 s, drop dead ones.
  every(25_000, () => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      ws.ping();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  log.info('server started', {
    version, port, static: config.staticDir, mainWorld: !!main, games: !!rooms, admin: !!config.adminToken,
    originCheck: config.allowedOrigins.length > 0, backups: config.backupKeep, inventoryGuard: config.inventoryGuard, binary: config.binary,
    chunkWorkers: genPool?.size ?? 0,
  });

  let closing: Promise<void> | null = null;
  return {
    port, main, rooms, profiles,
    close(reconnectMs) {
      closing ??= (async () => {
        draining = true;
        timers.forEach(clearInterval);
        // Saves every world and sends clients a kick with the reconnect hint.
        main?.shutdown(reconnectMs);
        rooms?.shutdown(reconnectMs);
        // After the games: a match that ended during shutdown has granted its XP.
        profiles?.close();
        await new Promise((r) => setTimeout(r, reconnectMs ? 300 : 20)); // let the close frames flush
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
        // The worlds are saved; the generation threads go last.
        await genPool?.close();
      })();
      return closing;
    },
  };
}

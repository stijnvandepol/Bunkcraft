import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { MatchOutcome, MatchTally, ProgressReport } from '../../src/modes/progression/Profile';
import { normalizeCode } from '../../src/net/protocol';
import { serverVersion } from '../App';
import type { Config } from '../Config';
import { GameServer, parseGameMode } from '../GameServer';
import { log } from '../Log';
import { metrics } from '../Metrics';
import type { ArenaSpec } from '../Rooms';
import type { ProfileBackend, SkinBackend } from '../RoomServer';
import { RateLimiter } from '../Security';
import { type Ident, type RunnerStatus, authByKey, authHeaders, callJson, decodeIdent, readJson, sendJson } from './Internal';

/**
 * ROLE=match: a match runner. Same image and bundle as the full server, started by the control plane (a container
 * per lobby, or a child process with MATCH_DRIVER=process) to run exactly one arena lobby: the Match, its bots, the
 * anti-cheat and hit registration. No static files, no profile or account store: who a player is comes from the
 * control plane with each connection (Ident), XP is granted by the control plane (`/internal/award`).
 *
 * Lifecycle: start → `ready` (warm, no lobby) → `assign` (one lobby) → the lobby empties or the control plane says
 * stop → shutdown (XP settled, world.json sent back) → exit. A runner whose control plane is gone for a while and
 * that has nobody connected exits by itself, so nothing lingers after `docker compose down`.
 */

const MAX_IDENTS = 2048;
const ORPHAN_MS = 5 * 60_000;

/** Profiles and skins as the control plane described them to this runner (see Ident); XP goes back over the API. */
export class RunnerProfiles implements ProfileBackend, SkinBackend {
  private readonly byToken = new Map<string, string>();
  private readonly known = new Map<string, { rank: number; skin: string }>();
  private readonly reservedNames = new Map<string, string | null>();
  private grantSeq = 0;
  readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly runnerId: string, private readonly call: (path: string, body: unknown) => Promise<Record<string, unknown>>) {}

  register(i: Ident): void {
    if (i.th && i.pid) {
      this.byToken.delete(i.th);
      this.byToken.set(i.th, i.pid);
      this.known.set(i.pid, { rank: Number(i.rank) || 0, skin: typeof i.skin === 'string' ? i.skin : '' });
    }
    if (typeof i.name === 'string') {
      this.reservedNames.delete(i.name.toLowerCase());
      this.reservedNames.set(i.name.toLowerCase(), typeof i.reserved === 'string' ? i.reserved : null);
    }
    for (const m of [this.byToken, this.reservedNames]) while (m.size > MAX_IDENTS) m.delete(m.keys().next().value!);
    while (this.known.size > MAX_IDENTS) this.known.delete(this.known.keys().next().value!);
  }

  verify(token: unknown): string | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
    return this.byToken.get(createHash('sha256').update(token).digest('hex')) ?? null;
  }

  reservedProfile(name: string): string | null {
    return this.reservedNames.get(name.toLowerCase()) ?? null;
  }

  get(id: string): object | null {
    return this.known.has(id) ? {} : null;
  }

  rank(id: string | undefined): number {
    return (id && this.known.get(id)?.rank) || 0;
  }

  seen(id: string, name: string): void {
    this.track(this.call('/internal/seen', { pid: id, name }));
  }

  award(id: string, tally: MatchTally, outcome: MatchOutcome): Promise<ProgressReport | null> {
    // One id per grant: a retry after a lost answer is recognised by the control plane and never pays twice.
    const grantId = `${this.runnerId}.${++this.grantSeq}`;
    const attempt = async (): Promise<ProgressReport | null> => {
      for (let i = 0; ; i++) {
        try {
          const r = await this.call('/internal/award', { grantId, pid: id, tally, outcome });
          const k = this.known.get(id);
          if (k && typeof r.rank === 'number') k.rank = r.rank;
          return (r.report as ProgressReport | null) ?? null;
        } catch (e) {
          if (i >= 4) { log.error('xp grant failed', { pid: id, error: String(e) }); return null; }
          await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        }
      }
    };
    return this.track(attempt());
  }

  effective(profileId: string | undefined): string {
    return (profileId && this.known.get(profileId)?.skin) || '';
  }

  report(hash: string, reporter: string, wearer: string): boolean {
    this.track(this.call('/internal/skin-report', { hash, reporter, wearer }));
    return true;
  }

  setSkin(pid: string, skin: string): void {
    const k = this.known.get(pid);
    if (k) k.skin = skin;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.catch(() => undefined);
    this.inflight.add(q);
    void q.then(() => this.inflight.delete(q));
    return p;
  }

  /** Waits (at most `ms`) for grants and notices still on their way. */
  async settle(ms: number): Promise<void> {
    await Promise.race([Promise.all([...this.inflight]), new Promise((r) => setTimeout(r, ms))]);
  }
}

export interface RunningRunner {
  port: number;
  /** Ends the lobby (XP settled, world sent back) and stops listening; the caller exits. */
  stop(reason?: string): Promise<void>;
}

export async function startMatchRunner(config: Config): Promise<RunningRunner> {
  const id = config.matchId;
  const key = config.matchToken;
  if (!/^[a-z0-9]{8,24}$/.test(id) || key.length < 16) throw new Error('ROLE=match needs MATCH_ID and MATCH_TOKEN (set by the control plane)');
  const version = serverVersion();
  const headers = authHeaders(id, key);
  const control = config.controlUrl.replace(/\/+$/, '');
  const call = (path: string, body: unknown, timeoutMs = 5000) => callJson(`${control}${path}`, headers, body, timeoutMs);
  const profiles = new RunnerProfiles(id, call);
  const baseDir = join(process.env.MATCH_TMP || tmpdir(), `bunkcraft-match-${id}`);

  let game: GameServer | null = null;
  let code: string | null = null;
  let dir = '';
  let stopping: Promise<void> | null = null;
  let lastWorldHash = '';
  let lastControl = Date.now();
  let cpuMark = { at: performance.now(), usage: process.cpuUsage() };

  const status = (): RunnerStatus => {
    const now = performance.now();
    const usage = process.cpuUsage();
    const cpu = (usage.user + usage.system - cpuMark.usage.user - cpuMark.usage.system) / 1000 / Math.max(1, now - cpuMark.at);
    cpuMark = { at: now, usage };
    const mem = process.memoryUsage();
    const g = game;
    return {
      id, version, room: code,
      players: g?.playerCount ?? 0, reservedSeats: g?.reservedSeats ?? 0, botCount: g?.botCount ?? 0, playersInPlay: g?.playersInPlay ?? 0,
      listed: g?.listed ?? false, locked: g?.locked ?? false, maxPlayers: g?.maxPlayers ?? 0,
      info: g?.info() ?? null, lobby: g?.lobbyStatus() ?? null, teams: g?.teamLoad() ?? null, holds: g?.holdKeys ?? [],
      playerList: g?.playerList() ?? [],
      tickP99Ms: metrics.tickWindow.p99, cpu: Math.round(cpu * 1000) / 1000, rssBytes: mem.rss, heapBytes: mem.heapUsed,
    };
  };

  /** Sends world.json back when it changed (the control plane keeps the file; this runner's disk is a tmpfs). */
  const pushWorld = async (force = false): Promise<void> => {
    if (!game || !code) return;
    try {
      game.save();
      const text = readFileSync(join(dir, 'world.json'), 'utf8');
      const hash = createHash('sha256').update(text).digest('hex');
      if (!force && hash === lastWorldHash) return;
      await call('/internal/save', { code, world: text }, 10_000);
      lastWorldHash = hash;
    } catch (e) {
      log.warn('world not sent back', { error: String(e) });
    }
  };

  const beat = async (): Promise<void> => {
    try {
      const r = await call('/internal/heartbeat', status(), 3000);
      lastControl = Date.now();
      if (r.stop === true) void stop('This match server was stopped');
    } catch {
      // Nobody connected and no control plane for minutes: this runner was left behind (compose down, a crash).
      if (Date.now() - lastControl > ORPHAN_MS && (game?.playerCount ?? 0) === 0) {
        log.warn('control plane gone, runner exits');
        void stop('orphaned').then(() => process.exit(0));
      }
    }
  };

  const assign = (body: Record<string, unknown>): void => {
    const c = normalizeCode(String(body.code ?? ''));
    if (!c) throw new Error('bad code');
    if (game) throw new Error('already assigned');
    code = c;
    dir = join(baseDir, c);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const common = {
      dataDir: dir, label: c, quiet: true,
      motd: typeof body.motd === 'string' ? body.motd.slice(0, 200) : 'Welcome to BunkCraft!',
      maxPlayers: Math.max(2, Math.min(64, Math.floor(Number(body.maxPlayers) || 12))),
      // The real admin token never leaves the control plane: its proxy swaps it for this runner's alias.
      adminToken: typeof body.adminAlias === 'string' && body.adminAlias.length >= 24 ? body.adminAlias : undefined,
      failLimiter: new RateLimiter(5, 600_000),
      inventoryGuard: config.inventoryGuard, binary: body.binary !== false, genPool: null,
      profiles: body.profiles === true ? profiles : null,
      skins: body.skins === true ? profiles : null,
      rejoinGraceSec: Math.max(0, Math.min(3600, Number(body.rejoinGraceSec) || 0)),
      onMetaChange: () => { void pushWorld(true); void beat(); },
    };
    if (typeof body.world === 'string') {
      writeFileSync(join(dir, 'world.json'), body.world);
      game = new GameServer({ ...common, worldName: 'BunkCraft Game', gameMode: 'survival' });
    } else {
      const spec = (body.spec ?? {}) as ArenaSpec;
      game = new GameServer({ ...spec, ...common, worldName: String(spec.worldName ?? 'BunkCraft Game').slice(0, 32), gameMode: parseGameMode(spec.gameMode) });
    }
    game.save();
    log.info('match runner assigned', { runner: id, code: c, type: game.info().gameType });
  };

  const op = (body: Record<string, unknown>): unknown => {
    const g = game;
    if (!g) return { ok: false };
    switch (body.op) {
      case 'reserve': return { hold: g.reserve(String(body.key), String(body.party), Number(body.size), Number(body.ttlMs)) };
      case 'release': g.release(String(body.key)); return { ok: true };
      case 'kick': return { ok: g.kickPlayer(String(body.name), String(body.reason ?? '')) };
      case 'announce': g.announce(String(body.text ?? '').slice(0, 500)); return { ok: true };
      case 'save': void pushWorld(true); return { ok: true };
      case 'skins': {
        const skins = body.skins && typeof body.skins === 'object' ? body.skins as Record<string, unknown> : {};
        for (const [pid, skin] of Object.entries(skins)) {
          profiles.setSkin(pid, typeof skin === 'string' ? skin : '');
          g.refreshSkins(pid);
        }
        return { ok: true };
      }
      case 'shutdown': void stop(typeof body.reason === 'string' ? body.reason : undefined); return { ok: true };
      default: return { ok: false };
    }
  };

  const http = createServer((req, res) => {
    if (!authByKey(req, id, key)) { sendJson(res, 403, { error: 'forbidden' }); return; }
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/internal/status') { sendJson(res, 200, status()); return; }
    if (req.method !== 'POST') { sendJson(res, 404, { error: 'not found' }); return; }
    readJson(req, 2 * 1024 * 1024).then(async (body) => {
      if (path === '/internal/assign') {
        assign(body);
        sendJson(res, 200, { status: status(), world: readFileSync(join(dir, 'world.json'), 'utf8') });
        lastWorldHash = '';
      } else if (path === '/internal/op') sendJson(res, 200, op(body) ?? {});
      else if (path === '/internal/rejoin') {
        const ident = decodeIdent(body.ident);
        if (ident) profiles.register(ident);
        sendJson(res, 200, game ? await game.rejoinStatus({ token: body.token, profile: body.profile }) : { state: 'none', secondsLeft: 0 });
      } else sendJson(res, 404, { error: 'not found' });
    }).catch((e: unknown) => sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }));
  });
  http.headersTimeout = 10_000;
  http.requestTimeout = 30_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!authByKey(req, id, key) || !game || stopping) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = typeof req.headers['x-bc-ip'] === 'string' ? req.headers['x-bc-ip'].slice(0, 64) : 'unknown';
    const ident = decodeIdent(req.headers['x-bc-ident']);
    if (ident) profiles.register(ident);
    const g = game;
    wss.handleUpgrade(req, socket, head, (ws) => g.accept(ws, { ip }));
  });

  const timers = [
    setInterval(() => void beat(), 1000),
    setInterval(() => metrics.rollWindow(), 5000),
    setInterval(() => void pushWorld(), 15_000),
  ];
  for (const t of timers) t.unref();

  const stop = (reason?: string): Promise<void> => {
    stopping ??= (async () => {
      timers.forEach(clearInterval);
      if (game) {
        // Settles every open XP tally (grants go to the control plane) and saves world.json.
        game.shutdown(undefined, reason ?? 'This match has ended');
        await profiles.settle(8000);
        await pushWorld(true);
      }
      try { await call('/internal/stopping', { code, reason: reason ?? '' }, 3000); } catch { /* the control plane may be gone */ }
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => { http.close(() => r()); http.closeAllConnections(); });
      rmSync(baseDir, { recursive: true, force: true });
      log.info('match runner stopped', { runner: id, code, reason });
    })();
    return stopping;
  };

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.matchPort, process.env.MATCH_HOST || '0.0.0.0', () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  // Tells the control plane this runner is up (and where): with retries, the control plane may still be starting.
  for (let i = 0; ; i++) {
    try {
      await call('/internal/ready', { port, version, pid: process.pid }, 3000);
      lastControl = Date.now();
      break;
    } catch (e) {
      if (i >= 40) throw new Error(`control plane not reachable: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  log.info('match runner ready', { runner: id, port, version });
  return { port, stop };
}

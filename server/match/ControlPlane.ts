import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { normalizeCode } from '../../src/net/protocol';
import { type GameType, gameTypeDef, parseGameType } from '../../src/modes/GameTypes';
import { type MatchOutcome, type MatchTally, emptyTally, emptyWeaponTally } from '../../src/modes/progression/XpRules';
import { parseGameMode } from '../GameServer';
import type { GameServer } from '../GameServer';
import { log } from '../Log';
import type { ProfileService } from '../progression/ProfileService';
import { loadSecret } from '../progression/ProfileTokens';
import type { ArenaSpec, RemoteRooms, Rooms } from '../Rooms';
import type { RoomServer } from '../RoomServer';
import { type RateLimiter, passwordFailKey, safeEqual } from '../Security';
import type { SkinService } from '../skins/SkinService';
import { MATCH_PORT, containerName } from './ContainerSpec';
import { DockerApi, DockerDriver, type LogLine, type MatchDriver, ProcessDriver } from './Drivers';
import { type Ident, RUNNER_ID, type RunnerStatus, authHeaders, authRunner, callJson, readJson, runnerKey, sendJson } from './Internal';
import { AdmissionLedger, GrantLedger } from './Ledgers';
import { MatchPool, type Runner } from './MatchPool';
import { type RemoteHost, RemoteRoom } from './RemoteRoom';

/**
 * MATCH_ISOLATION=container, the control plane side: the pool of match runners, the internal API they call
 * (ready, heartbeat, XP grants, world saves, stopping), and the factory Rooms uses for arena lobbies.
 *
 * Trust: a runner is our own image, but it runs the code that parses player input, so it is treated as a semi-trusted
 * peer. It can only speak for itself (its own key), only about its own lobby, and only grant XP to profiles that the
 * control plane itself let into that lobby; tallies are clamped before they reach the profile store.
 */

export interface ControlPlaneOptions {
  dataDir: string;
  roomsDir: string;
  secret?: string;
  warm: number;
  max: number;
  internalPort: number;
  internalHost: string;
  idleGraceSec: number;
  roomMaxPlayers: number;
  motd: string;
  binary: boolean;
  rejoinGraceSec: number;
  adminToken?: string;
  version: string;
  profiles: ProfileService | null;
  skins: SkinService | null;
  /** Wrong game passwords per game and address: the one App counts with, so runners and in-process games share it. */
  failLimiter?: RateLimiter;
  /** The driver (docker or process); built from the config by `driverFromConfig`. */
  driver: MatchDriver;
  startTimeoutMs?: number;
  beatTimeoutMs?: number;
}

const MAX_WORLD_BYTES = 2 * 1024 * 1024;
const GRANT_MEMORY = 20_000;
/** No player gets more than this of anything in one match (a tally above it is clamped). */
const TALLY_CAP = 10_000;

export class ControlPlane implements RemoteRooms, RemoteHost {
  readonly pool: MatchPool;
  private readonly secret: Buffer;
  private readonly lobbies = new Map<string, { room: RemoteRoom; dir: string; gameType: GameType }>();
  /** Answers of recent grants (a retry gets the same answer) and, on disk, every grant paid (a retry after a restart pays nothing). */
  private readonly grants = new Map<string, unknown>();
  private readonly paid: GrantLedger;
  /** The profiles this control plane let into each lobby (DATA_DIR/match-admitted.json): an adopted lobby keeps them. */
  private readonly admitted: AdmissionLedger;
  private rooms: Rooms | null = null;
  private internal: Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private available = false;
  /** Lobbies that ran in-process because the cap was reached or the driver was not available. */
  fallbacks = 0;
  /** Runners an admin stopped whose match is still winding down (XP settled, world sent back). */
  private readonly draining = new Set<string>();
  internalPort = 0;

  /** Runner id → the lobby this control plane assigned to it (DATA_DIR/match-runners.json; read back after a restart). */
  private assignments: Record<string, string> = Object.create(null) as Record<string, string>;
  private readonly assignmentsFile: string;

  constructor(private readonly o: ControlPlaneOptions) {
    this.secret = loadSecret(join(o.dataDir, 'match-secret.key'), o.secret);
    this.assignmentsFile = join(o.dataDir, 'match-runners.json');
    this.paid = new GrantLedger(join(o.dataDir, 'match-grants.json'));
    this.admitted = new AdmissionLedger(join(o.dataDir, 'match-admitted.json'));
    try {
      const raw = JSON.parse(readFileSync(this.assignmentsFile, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, code] of Object.entries(raw)) if (RUNNER_ID.test(id) && typeof code === 'string' && normalizeCode(code) === code) this.assignments[id] = code;
      }
    } catch { /* first start, or no records */ }
    this.pool = new MatchPool({
      driver: o.driver, secret: this.secret, warm: o.warm, max: o.max,
      startTimeoutMs: o.startTimeoutMs, beatTimeoutMs: o.beatTimeoutMs,
      onDead: (r) => { const l = this.lobbyOf(r.id); if (l) this.gone(l.room); },
    });
  }

  /** Starts the internal API and the driver. A driver that cannot work leaves every lobby in-process (logged). */
  async start(): Promise<void> {
    this.internal = createServer((req, res) => void this.handle(req, res));
    this.internal.headersTimeout = 10_000;
    this.internal.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      this.internal!.once('error', reject);
      this.internal!.listen(this.o.internalPort, this.o.internalHost, () => resolve());
    });
    this.internalPort = (this.internal.address() as AddressInfo).port;
    // Child processes reach this API on loopback, at the port it really got.
    if (this.o.driver instanceof ProcessDriver) this.o.driver.controlUrl = `http://127.0.0.1:${this.internalPort}`;
    await this.tryInit();
    const every = (ms: number, fn: () => void) => { const t = setInterval(fn, ms); t.unref(); this.timers.push(t); };
    every(2000, () => { if (this.available) this.pool.sweep(); });
    every(10_000, () => { if (this.available) void this.pool.pollStats(); });
    // The Docker gate may come up after us (compose starts both at once): keep trying, lobbies run in-process meanwhile.
    every(5000, () => { if (!this.available) void this.tryInit().then(() => { if (this.available && this.rooms) void this.attach(this.rooms); }); });
    log.info('match isolation: container', {
      driver: this.o.driver.kind, image: this.o.driver.image, warm: this.o.warm, max: this.o.max, internalPort: this.internalPort, available: this.available,
    });
  }

  private initFailures = 0;

  private async tryInit(): Promise<void> {
    try {
      await this.o.driver.init();
      this.available = true;
      if (this.initFailures > 0) log.info('match containers available', { driver: this.o.driver.kind, image: this.o.driver.image });
    } catch (e) {
      if (this.initFailures++ === 0) {
        log.error('match containers unavailable: arena lobbies run in this process until the driver works', { driver: this.o.driver.kind, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** Hooks into Rooms: adopts the lobbies runners still run (a control plane update), then fills the warm pool. */
  async attach(rooms: Rooms): Promise<void> {
    this.rooms = rooms;
    if (!this.available) return;
    let found: Awaited<ReturnType<MatchDriver['list']>> = [];
    try {
      found = await this.o.driver.list();
    } catch (e) {
      log.warn('could not list match containers', { error: String(e) });
    }
    const taken = new Set<string>();
    for (const h of found) {
      const url = this.o.driver.urlFor(h, MATCH_PORT);
      const key = runnerKey(this.secret, h.id);
      let status: RunnerStatus | null = null;
      try {
        status = await callJson<RunnerStatus>(`${url}/internal/status`, authHeaders(h.id, key), undefined, 3000);
      } catch (e) {
        log.warn('match container did not answer', { runner: h.id, error: String(e) });
      }
      // Only the lobby this control plane itself gave the runner (recorded at assign time), never what the runner says.
      const code = status ? adoptableCode(this.assignments[h.id], status.room, this.o.roomsDir, taken, (c) => rooms.isLoaded(c)) : null;
      // The game type comes from the world file this control plane wrote, never from the runner.
      const gameType = code ? savedArcadeType(join(this.o.roomsDir, code)) : null;
      if (!status || !code || !gameType) {
        // A warm runner of the previous control plane (maybe an older image), one we cannot talk to, or one whose story
        // does not match our records.
        if (status?.room && status.room !== this.assignments[h.id]) log.warn('match container claims a lobby it was not given', { runner: h.id });
        delete this.assignments[h.id];
        await this.o.driver.stop(h).catch(() => undefined);
        continue;
      }
      taken.add(code);
      const runner = this.pool.adopt(h, url, { ...status, room: code });
      const dir = join(this.o.roomsDir, code);
      const room = RemoteRoom.adopted(code, this, runner, gameType, () => this.rooms?.metaChanged(code));
      // The players this control plane let in before its restart may still be granted XP (its own records, not the runner's).
      for (const pid of this.admitted.admitted(code)) room.pids.add(pid);
      room.apply(status);
      this.lobbies.set(code, { room, dir, gameType });
      rooms.adopt(code, room);
    }
    // Records of runners that are gone.
    for (const id of Object.keys(this.assignments)) if (!this.pool.runners.has(id)) delete this.assignments[id];
    this.saveAssignments();
    this.admitted.retain([...taken, ...this.lobbies.keys()]);
    this.pool.ensureWarm();
  }

  // ------------------------------------------------------------------------------------------ RemoteRooms (Rooms)

  create(code: string, spec: ArenaSpec, dir: string, onMeta: () => void): RoomServer | null {
    const type = parseGameType(spec.gameType);
    return this.open(code, dir, onMeta, { spec }, {
      name: spec.worldName, gameMode: parseGameMode(spec.gameMode), players: 0,
      maxPlayers: Math.min(spec.lobbySize ?? this.o.roomMaxPlayers, this.o.roomMaxPlayers), gameType: type,
      scoreLimit: spec.scoreLimit ?? 0, timeLimitSec: spec.timeLimitSec ?? 0, locked: !!spec.passwordHash, ...(spec.mapId ? { map: spec.mapId } : {}),
    });
  }

  load(code: string, world: string, dir: string, onMeta: () => void): RoomServer | null {
    let w: Record<string, unknown>;
    try {
      w = JSON.parse(world) as Record<string, unknown>;
    } catch {
      return null;
    }
    const type: GameType = parseGameType(w.gameType);
    if (!gameTypeDef(type).arcade) return null;
    return this.open(code, dir, onMeta, { world }, {
      name: String(w.name ?? 'BunkCraft Game'), gameMode: parseGameMode(String(w.gameMode ?? 'survival')), players: 0,
      maxPlayers: typeof w.maxPlayers === 'number' ? Math.min(w.maxPlayers, this.o.roomMaxPlayers) : this.o.roomMaxPlayers,
      gameType: type, scoreLimit: Number(w.scoreLimit) || 0, timeLimitSec: Number(w.timeLimitSec) || 0, locked: !!w.passwordHash,
      ...(typeof w.mapId === 'string' ? { map: w.mapId as never } : {}),
    });
  }

  private open(code: string, dir: string, onMeta: () => void, payload: { spec?: ArenaSpec; world?: string }, fallback: ReturnType<GameServer['info']>): RoomServer | null {
    if (!this.available) { this.fallbacks++; return null; }
    const lease = this.pool.lease();
    if (!lease) {
      // Every runner is busy (MAX_MATCH_CONTAINERS): the lobby runs in this process, as without isolation.
      this.fallbacks++;
      log.warn('match container cap reached: lobby runs in-process', { code, max: this.o.max });
      return null;
    }
    const gameType = fallback.gameType;
    const room = new RemoteRoom(code, this, lease, (r) => this.assign(r, code, dir, gameType, payload), fallback, onMeta);
    this.lobbies.set(code, { room, dir, gameType });
    return room;
  }

  private saveAssignments(): void {
    try {
      writeFileSync(`${this.assignmentsFile}.tmp`, JSON.stringify(this.assignments));
      renameSync(`${this.assignmentsFile}.tmp`, this.assignmentsFile);
    } catch (e) {
      log.warn('match runner records not saved', { error: String(e) });
    }
  }

  private async assign(r: Runner, code: string, dir: string, gameType: GameType, payload: { spec?: ArenaSpec; world?: string }): Promise<RunnerStatus> {
    this.assignments[r.id] = code;
    this.saveAssignments();
    const res = await callJson<{ status: RunnerStatus; world: string }>(`${r.url}/internal/assign`, authHeaders(r.id, r.key), {
      code, ...payload,
      maxPlayers: this.o.roomMaxPlayers, motd: this.o.motd, binary: this.o.binary, rejoinGraceSec: this.o.rejoinGraceSec,
      profiles: !!this.o.profiles, skins: !!this.o.skins, adminAlias: this.adminAlias(r.id),
    }, 10_000);
    this.writeWorld(dir, res.world, gameType);
    return res.status;
  }

  // ------------------------------------------------------------------------------------------ RemoteHost (RemoteRoom)

  /** The admin token never goes to a runner: each runner knows an alias, and the proxy swaps the token for it. */
  private adminAlias(id: string): string {
    return createHmac('sha256', this.secret).update(`admin:${id}`).digest('base64url');
  }

  private identFor(room: RemoteRoom, token: unknown, name?: string): Ident {
    const p = this.o.profiles;
    const ident: Ident = {};
    if (name !== undefined) {
      ident.name = name;
      ident.reserved = p?.reservedProfile(name) ?? null;
    }
    const pid = p && typeof token === 'string' ? p.verify(token) : null;
    if (pid && p!.get(pid)) {
      ident.th = hashHex(token as string);
      ident.pid = pid;
      ident.rank = p!.rank(pid);
      ident.skin = this.o.skins?.effective(pid) ?? '';
      room.pids.add(pid);
      this.admitted.admit(room.code, pid);
    }
    return ident;
  }

  identify(room: RemoteRoom, runner: Runner, first: string): { ident: Ident; first?: string } {
    let hello: Record<string, unknown>;
    try {
      hello = JSON.parse(first) as Record<string, unknown>;
    } catch {
      return { ident: {} };
    }
    if (!hello || typeof hello !== 'object' || hello.t !== 'hello') return { ident: {} };
    const ident = this.identFor(room, hello.profile, typeof hello.name === 'string' ? hello.name.slice(0, 32) : '');
    const admin = this.o.adminToken;
    if (admin && typeof hello.owner === 'string' && safeEqual(hello.owner, admin)) {
      return { ident, first: JSON.stringify({ ...hello, owner: this.adminAlias(runner.id) }) };
    }
    return { ident };
  }

  passwordBlocked(room: RemoteRoom, ip: string): boolean {
    return !!this.o.failLimiter && !this.o.failLimiter.allowed(passwordFailKey(room.code, ip));
  }

  identOf(room: RemoteRoom, profileToken: unknown): Ident {
    return this.identFor(room, profileToken);
  }

  skinsFor(room: RemoteRoom, profileId?: string): Record<string, string> {
    const out: Record<string, string> = {};
    const skins = this.o.skins;
    if (!skins) return out;
    for (const pid of profileId ? [profileId] : room.pids) if (room.pids.has(pid)) out[pid] = skins.effective(pid);
    return out;
  }

  gone(room: RemoteRoom): void {
    const l = this.lobbies.get(room.code);
    if (l?.room === room) {
      this.lobbies.delete(room.code);
      this.admitted.forget(room.code);
    }
    if (room.runner) this.draining.delete(room.runner.id);
    room.ended();
    this.rooms?.forget(room.code, room);
    if (room.runner) {
      delete this.assignments[room.runner.id];
      this.saveAssignments();
      void this.pool.release(room.runner.id, 'lobby over');
    }
  }

  private lobbyOf(runnerId: string): { room: RemoteRoom; dir: string; gameType: GameType } | null {
    for (const l of this.lobbies.values()) if (l.room.runner?.id === runnerId) return l;
    return null;
  }

  /** A runner's save. Its game type must stay the lobby's: a runner must not turn a lobby into a sandbox world that
   *  the control plane would then load in-process after a restart. */
  private writeWorld(dir: string, world: unknown, gameType: GameType): void {
    if (typeof world !== 'string' || world.length > MAX_WORLD_BYTES) throw new Error('bad world');
    const w = JSON.parse(world) as unknown;
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error('bad world');
    if ((w as Record<string, unknown>).gameType !== gameType) throw new Error('bad world: game type changed');
    const file = join(dir, 'world.json');
    writeFileSync(`${file}.tmp`, world);
    renameSync(`${file}.tmp`, file);
  }

  // ------------------------------------------------------------------------------------------ internal API

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const id = authRunner(req, this.secret);
    if (!id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'POST') { sendJson(res, 404, { error: 'not found' }); return; }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, path === '/internal/save' ? MAX_WORLD_BYTES + 4096 : 256 * 1024);
    } catch {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    try {
      switch (path) {
        case '/internal/ready': {
          const port = Math.floor(Number(body.port));
          const r = port > 0 && port < 65536 ? this.pool.ready(id, port, typeof body.version === 'string' ? body.version.slice(0, 64) : '') : null;
          sendJson(res, r ? 200 : 404, r ? { ok: true } : { error: 'unknown runner' });
          return;
        }
        case '/internal/heartbeat': {
          const r = this.pool.beat(id, body as unknown as RunnerStatus);
          const l = this.lobbyOf(id);
          if (l && r) l.room.apply(body as unknown as RunnerStatus);
          // A runner nobody knows (a leftover) is told to stop.
          sendJson(res, 200, { stop: !r });
          return;
        }
        case '/internal/award': return sendJson(res, ...this.award(id, body));
        case '/internal/seen': {
          const l = this.lobbyOf(id);
          const pid = String(body.pid ?? '');
          if (l?.room.pids.has(pid) && typeof body.name === 'string') this.o.profiles?.seen(pid, body.name.slice(0, 16));
          sendJson(res, 200, { ok: true });
          return;
        }
        case '/internal/password-fail': {
          // Counted under the lobby this control plane gave the runner, never one the runner names.
          const l = this.lobbyOf(id);
          const ip = typeof body.ip === 'string' && body.ip.length > 0 && body.ip.length <= 64 ? body.ip : null;
          if (l && ip) this.o.failLimiter?.record(passwordFailKey(l.room.code, ip));
          sendJson(res, 200, { ok: !!(l && ip) });
          return;
        }
        case '/internal/skin-report': {
          const ok = !!this.lobbyOf(id) && !!this.o.skins?.report(String(body.hash ?? ''), String(body.reporter ?? '').slice(0, 64), String(body.wearer ?? '').slice(0, 16));
          sendJson(res, 200, { ok });
          return;
        }
        case '/internal/save': {
          const l = this.lobbyOf(id);
          if (!l || body.code !== l.room.code) { sendJson(res, 403, { error: 'not your lobby' }); return; }
          this.writeWorld(l.dir, body.world, l.gameType);
          sendJson(res, 200, { ok: true });
          return;
        }
        case '/internal/stopping': {
          const l = this.lobbyOf(id);
          if (l) this.gone(l.room);
          else void this.pool.release(id, 'runner stops');
          sendJson(res, 200, { ok: true });
          return;
        }
        default: sendJson(res, 404, { error: 'not found' });
      }
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** XP for a profile, decided by the runner's match and granted here, once per grant id. */
  private award(id: string, body: Record<string, unknown>): [number, unknown] {
    const grantId = String(body.grantId ?? '');
    if (!grantId.startsWith(`${id}.`) || grantId.length > 64) return [400, { error: 'bad grant id' }];
    const earlier = this.grants.get(grantId);
    if (earlier) return [200, earlier];
    const l = this.lobbyOf(id);
    const pid = String(body.pid ?? '');
    const profiles = this.o.profiles;
    if (!profiles || !l || !l.room.pids.has(pid)) return [403, { error: 'not a player of this lobby' }];
    // Paid before this control plane restarted (the answer was lost on the way): nothing more, no report to show again.
    if (this.paid.has(grantId)) return [200, { report: null, rank: profiles.rank(pid) }];
    const report = profiles.award(pid, cleanTally(body.tally), cleanOutcome(body.outcome, l.room));
    this.paid.record(grantId);
    const answer = { report, rank: profiles.rank(pid) };
    this.grants.set(grantId, answer);
    if (this.grants.size > GRANT_MEMORY) this.grants.delete(this.grants.keys().next().value!);
    return [200, answer];
  }

  // ------------------------------------------------------------------------------------------ ops dashboard

  /** Whether the driver works (false: every lobby runs in-process until it does). */
  get driverAvailable(): boolean {
    return this.available;
  }

  /** Settings the ops dashboard changes at run time; they apply to lobbies opened from now on. */
  tune(t: { motd?: string; roomMaxPlayers?: number; idleGraceSec?: number }): void {
    if (t.motd !== undefined) this.o.motd = t.motd;
    if (t.roomMaxPlayers !== undefined) this.o.roomMaxPlayers = t.roomMaxPlayers;
    if (t.idleGraceSec !== undefined) this.o.idleGraceSec = t.idleGraceSec;
  }

  /**
   * Stops one runner from the ops dashboard. A warm one just goes. One with a lobby ends its match the graceful way:
   * XP is settled, the world goes back to disk, and its players are told to reconnect in a few seconds; by then the
   * lobby is forgotten here, so their reconnect opens it again in a fresh runner (the same code, the rejoin path).
   */
  stopRunner(id: string, reconnectMs = 4000): 'stopped' | 'draining' | null {
    const r = this.pool.runners.get(id);
    if (!r || r.state === 'stopping') return null;
    const l = this.lobbyOf(id);
    if (!l) {
      void this.pool.release(id, 'stopped by an admin');
      return 'stopped';
    }
    this.draining.add(id);
    l.room.shutdown(reconnectMs, 'The match server is restarting: reconnecting');
    this.rooms?.forget(l.room.code, l.room);
    // A runner that does not wind down by itself is stopped hard after a while.
    setTimeout(() => {
      if (this.pool.runners.get(id) === r) {
        const left = this.lobbyOf(id);
        if (left?.room === l.room) this.gone(l.room);
        else void this.pool.release(id, 'stop timed out');
      }
      this.draining.delete(id);
    }, 20_000).unref();
    return 'draining';
  }

  /** The last log lines of one runner (owned runners only: the pool knows no others). */
  async runnerLogs(id: string, tail: number): Promise<LogLine[] | null> {
    const r = this.pool.runners.get(id);
    if (!r?.handle) return null;
    return this.o.driver.logs(r.handle, tail);
  }

  // ------------------------------------------------------------------------------------------ status

  /** Runners for /admin, /ops and /metrics. */
  runners(): {
    id: string; name: string; state: string; room: string | null; version: string; image: string; adopted: boolean; players: number; maxPlayers: number;
    bots: number; gameType: string | null; map: string | null; phase: string | null; tickP99Ms: number;
    cpu: number; memBytes: number; memLimitBytes: number; uptimeSec: number;
  }[] {
    const now = Date.now();
    return [...this.pool.runners.values()].map((r) => {
      const l = this.lobbyOf(r.id);
      const lobby = (r.status?.lobby ?? null) as { phase?: string; map?: string } | null;
      return {
      id: r.id, name: this.o.driver.kind === 'docker' ? containerName(r.id) : `process ${r.handle?.ref ?? ''}`.trim(),
      // Warm runners are "warm", a stopped one still finishing its match is "draining".
      state: this.draining.has(r.id) && r.state !== 'stopping' ? 'draining' : r.state === 'idle' ? 'warm' : r.state,
      room: r.room, version: r.version, image: r.handle?.image ?? this.o.driver.image, adopted: r.adopted,
      players: r.status?.players ?? 0, maxPlayers: r.status?.maxPlayers ?? 0, bots: r.status?.botCount ?? 0,
      gameType: l?.gameType ?? null, map: lobby?.map ?? null, phase: lobby?.phase ?? null,
      tickP99Ms: r.status?.tickP99Ms ?? 0,
      // Docker stats when there are (the container as the kernel sees it), else the runner's own numbers.
      cpu: r.stats?.cpu ?? r.status?.cpu ?? 0,
      memBytes: r.stats?.memBytes ?? r.status?.rssBytes ?? 0,
      memLimitBytes: r.stats?.memLimitBytes ?? 0,
      uptimeSec: Math.round((now - r.startedAt) / 1000),
      };
    });
  }

  prometheus(): string[] {
    const c = this.pool.counters;
    const avgStart = c.startMs.length ? c.startMs.reduce((a, b) => a + b, 0) / c.startMs.length : 0;
    const lines = [
      '# HELP bunkcraft_match_runners Match runners (containers) by state.',
      '# TYPE bunkcraft_match_runners gauge',
      ...(['starting', 'idle', 'assigned', 'stopping'] as const).map((s) => `bunkcraft_match_runners{state="${s}"} ${this.pool.count(s)}`),
      '# TYPE bunkcraft_match_runner_starts_total counter',
      `bunkcraft_match_runner_starts_total ${c.starts}`,
      '# TYPE bunkcraft_match_runner_start_failures_total counter',
      `bunkcraft_match_runner_start_failures_total ${c.startFailures}`,
      '# TYPE bunkcraft_match_runner_deaths_total counter',
      `bunkcraft_match_runner_deaths_total ${c.deaths}`,
      '# HELP bunkcraft_match_inprocess_fallback_total Arena lobbies that ran in-process (cap reached or no driver).',
      '# TYPE bunkcraft_match_inprocess_fallback_total counter',
      `bunkcraft_match_inprocess_fallback_total ${this.fallbacks}`,
      '# HELP bunkcraft_match_runner_start_seconds Mean start-to-ready time of the last runners.',
      '# TYPE bunkcraft_match_runner_start_seconds gauge',
      `bunkcraft_match_runner_start_seconds ${(avgStart / 1000).toFixed(3)}`,
      '# HELP bunkcraft_match_tick_p99_seconds Tick p99 of the last window, per lobby.',
      '# TYPE bunkcraft_match_tick_p99_seconds gauge',
      '# HELP bunkcraft_match_cpu_cores CPU use per lobby (1 = one core).',
      '# TYPE bunkcraft_match_cpu_cores gauge',
      '# HELP bunkcraft_match_memory_bytes Memory per lobby.',
      '# TYPE bunkcraft_match_memory_bytes gauge',
      '# TYPE bunkcraft_match_players gauge',
    ];
    for (const r of this.runners()) {
      if ((r.state !== 'assigned' && r.state !== 'draining') || !r.room) continue;
      const l = `{room="${r.room}",runner="${r.id}"}`;
      lines.push(
        `bunkcraft_match_tick_p99_seconds${l} ${(r.tickP99Ms / 1000).toFixed(4)}`,
        `bunkcraft_match_cpu_cores${l} ${r.cpu.toFixed(3)}`,
        `bunkcraft_match_memory_bytes${l} ${r.memBytes}`,
        `bunkcraft_match_players${l} ${r.players}`,
      );
    }
    return lines;
  }

  /** The control plane stops (update or restart): lobbies keep running in their containers for the next one. */
  async close(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.pool.close();
    if (this.o.driver instanceof ProcessDriver) this.o.driver.killAll();
    await new Promise<void>((r) => { if (!this.internal) r(); else { this.internal.close(() => r()); this.internal.closeAllConnections(); } });
  }
}

function hashHex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * The lobby a runner found at start-up may be adopted for: exactly the code this control plane assigned to it, in
 * canonical form, inside the rooms directory, with a world on disk, and not already taken by another runner or a
 * loaded game. Null otherwise (the runner is stopped).
 */
export function adoptableCode(assigned: string | undefined, reported: string | null, roomsDir: string, taken: Set<string>, loaded: (code: string) => boolean): string | null {
  if (!assigned || reported !== assigned || normalizeCode(assigned) !== assigned) return null;
  if (taken.has(assigned) || loaded(assigned)) return null;
  const root = resolve(roomsDir);
  const dir = resolve(root, assigned);
  if (!dir.startsWith(root + sep) || !existsSync(join(dir, 'world.json'))) return null;
  return assigned;
}

const clampCount = (v: unknown): number => Math.max(0, Math.min(TALLY_CAP, Math.floor(Number(v) || 0)));

/** The tally as the runner sent it, reduced to the known fields and clamped. */
export function cleanTally(raw: unknown): MatchTally {
  const t = emptyTally();
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  for (const k of Object.keys(t) as (keyof MatchTally)[]) {
    if (k === 'weapons') continue;
    (t as unknown as Record<string, number>)[k] = k === 'killXp' ? Math.max(0, Math.min(TALLY_CAP * 100, Number(src[k]) || 0)) : clampCount(src[k]);
  }
  const weapons = src.weapons && typeof src.weapons === 'object' ? src.weapons as Record<string, unknown> : {};
  for (const [w, v] of Object.entries(weapons).slice(0, 32)) {
    if (!/^[a-z0-9_]{1,24}$/.test(w) || !v || typeof v !== 'object') continue;
    const wt = emptyWeaponTally();
    for (const k of Object.keys(wt) as (keyof typeof wt)[]) wt[k] = clampCount((v as Record<string, unknown>)[k]);
    t.weapons[w] = wt;
  }
  return t;
}

/** The outcome, with the mode taken from the lobby itself (a runner cannot claim another mode's challenges). */
function cleanOutcome(raw: unknown, room: RemoteRoom): MatchOutcome {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const result = o.result === 'win' || o.result === 'loss' || o.result === 'draw' ? o.result : 'loss';
  return {
    mode: room.info().gameType,
    map: typeof o.map === 'string' ? o.map.slice(0, 32) : '',
    result,
    completed: o.completed === true,
    ...(typeof o.humans === 'number' ? { humans: Math.max(0, Math.min(64, Math.floor(o.humans))) } : {}),
  };
}

/** The driver MATCH_DRIVER asks for. */
export function driverFromConfig(c: {
  matchDriver: 'docker' | 'process'; dockerHost: string; dockerGateSecret?: string; matchImage: string; matchNetwork: string; controlUrl: string; matchOwner: string;
  matchCpus: number; matchMemoryMb: number; matchPids: number;
}, version: string, logLevel: string): MatchDriver {
  if (c.matchDriver === 'process') return new ProcessDriver({ command: ProcessDriver.defaultCommand(), controlUrl: c.controlUrl, logLevel });
  return new DockerDriver({
    api: new DockerApi(c.dockerHost, c.dockerGateSecret), image: c.matchImage, network: c.matchNetwork, controlUrl: c.controlUrl, owner: c.matchOwner,
    cpus: c.matchCpus, memoryMb: c.matchMemoryMb, pids: c.matchPids, logLevel, version: version.replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 64) || 'dev',
  });
}

/** The arena game type in a lobby's saved world, or null (missing, unreadable or not an arena type). */
export function savedArcadeType(dir: string): GameType | null {
  try {
    const w = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as Record<string, unknown>;
    if (typeof w.gameType !== 'string') return null;
    const type = parseGameType(w.gameType);
    return type === w.gameType && gameTypeDef(type).arcade ? type : null;
  } catch {
    return null;
  }
}

import { WebSocket } from 'ws';
import type { GameServer } from '../GameServer';
import { log } from '../Log';
import type { RejoinStatus, RoomServer } from '../RoomServer';
import { type RunnerStatus, authHeaders, callJson, encodeIdent, type Ident } from './Internal';
import type { Runner } from './MatchPool';
import { bridge } from './WsProxy';

type Info = ReturnType<GameServer['info']>;

/** What a RemoteRoom needs from the control plane. */
export interface RemoteHost {
  /** Who the player of this hello is, and the hello to forward (the admin token swapped for the runner's alias). */
  identify(room: RemoteRoom, runner: Runner, first: string, ip?: string): { ident: Ident; first?: string };
  /** The ident for a profile token alone (rejoin checks). */
  identOf(room: RemoteRoom, profileToken: unknown): Ident;
  /** What the players of this room (or only this profile) wear now: profile id → skin hash ('' = none). */
  skinsFor(room: RemoteRoom, profileId?: string): Record<string, string>;
  /** Whether this address used up its wrong passwords for this lobby (the control plane counts them for all runners). */
  passwordBlocked(room: RemoteRoom, ip: string): boolean;
  /** The runner of this room ended or died: forget the room. */
  gone(room: RemoteRoom): void;
}

/** A party hold the runner has not confirmed yet (counted as taken meanwhile). */
interface PendingHold { size: number; expires: number; team: 'red' | 'blue' | '' }

/**
 * A lobby whose match runs in a match runner (MATCH_ISOLATION=container), as Rooms and the HTTP API see it.
 *
 * Reads answer from the runner's last heartbeat (once a second) plus what this side did since: party holds not yet
 * confirmed count as taken, a player who just connected counts as present. Changes (holds, kicks, announcements)
 * go to the runner in order, and a player's connection only opens after the changes queued before it arrived: a party
 * member with a fresh ticket never reaches the runner before the hold does.
 */
export class RemoteRoom implements RoomServer {
  runner: Runner | null = null;
  /** Profiles that played here (from the proxy): only they may be granted XP by this runner. */
  readonly pids = new Set<string>();
  private st: RunnerStatus | null = null;
  private readonly holds = new Map<string, PendingHold>();
  private chain: Promise<unknown>;
  private readonly clients = new Set<WebSocket>();
  private joinedSinceBeat = 0;
  private closed = false;
  private failed = false;
  readonly ready: Promise<Runner>;

  constructor(
    readonly code: string,
    private readonly host: RemoteHost,
    lease: Promise<Runner>,
    private readonly assign: (r: Runner) => Promise<RunnerStatus>,
    private readonly fallback: Info,
    private readonly onMeta: () => void,
  ) {
    this.ready = lease.then(async (r) => {
      this.runner = r;
      r.room = code;
      this.apply(await this.assign(r));
      return r;
    });
    this.ready.catch((e: unknown) => {
      this.failed = true;
      log.error('match runner for lobby failed', { code, error: e instanceof Error ? e.message : String(e) });
      this.host.gone(this);
    });
    this.chain = this.ready.catch(() => undefined);
  }

  /** A room adopted from a runner that already runs it. */
  static adopted(code: string, host: RemoteHost, runner: Runner, gameType: Info['gameType'], onMeta: () => void): RemoteRoom {
    const room = new RemoteRoom(code, host, Promise.resolve(runner), async () => runner.status!, { ...(runner.status?.info as Info), gameType }, onMeta);
    return room;
  }

  get status(): RunnerStatus | null {
    return this.st;
  }

  /** A heartbeat (or an answer) of the runner. */
  apply(st: RunnerStatus): void {
    const before = this.st;
    this.st = st;
    this.joinedSinceBeat = 0;
    const now = Date.now();
    for (const [k, h] of this.holds) if (h.expires <= now || st.holds.includes(k)) this.holds.delete(k);
    const i = st.info as Info | null;
    const bi = before?.info as Info | null | undefined;
    if (!before || before.listed !== st.listed || before.locked !== st.locked || bi?.name !== i?.name || bi?.map !== i?.map) this.onMeta();
  }

  private call<T = Record<string, unknown>>(path: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    const r = this.runner;
    if (!r) return Promise.reject(new Error('no runner'));
    return callJson<T>(`${r.url}${path}`, authHeaders(r.id, r.key), body, timeoutMs);
  }

  /** Queues a change for the runner (in order, after the assignment). */
  private op(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const p = this.chain.then(() => (this.failed ? null : this.call('/internal/op', body)), () => null)
      .catch((e: unknown) => { log.warn('match runner op failed', { code: this.code, op: body.op, error: String(e) }); return null; });
    this.chain = p;
    return p;
  }

  private pendingSeats(): number {
    const now = Date.now();
    let n = 0;
    for (const h of this.holds.values()) if (h.expires > now) n += h.size;
    return n;
  }

  get playerCount(): number { return (this.st?.players ?? 0) + this.joinedSinceBeat; }
  get reservedSeats(): number { return (this.st?.reservedSeats ?? 0) + this.pendingSeats(); }
  get botCount(): number { return this.st?.botCount ?? 0; }
  get playersInPlay(): number { return this.st?.playersInPlay ?? 0; }
  get listed(): boolean { return this.st?.listed ?? false; }
  get locked(): boolean { return this.st?.locked ?? !!this.fallback?.locked; }
  get maxPlayers(): number { return this.st?.maxPlayers || this.fallback?.maxPlayers || 0; }
  /** The game type is the control plane's (set at create/load), never what the runner reports. */
  info(): Info { return { ...((this.st?.info as Info | null) ?? this.fallback), gameType: this.fallback.gameType, players: this.playerCount }; }
  lobbyStatus(): ReturnType<GameServer['lobbyStatus']> { return (this.st?.lobby as ReturnType<GameServer['lobbyStatus']>) ?? null; }

  teamLoad(): ReturnType<GameServer['teamLoad']> {
    const t = this.st?.teams as { red: number; blue: number } | null | undefined;
    if (!t) return null;
    const load = { ...t };
    for (const h of this.holds.values()) if (h.team) load[h.team] += h.size;
    return load;
  }

  async rejoinStatus(proof: { token?: unknown; profile?: unknown }): Promise<RejoinStatus> {
    if (this.closed || this.failed) return { state: 'none', secondsLeft: 0 };
    try {
      const runner = await this.ready;
      await this.chain;
      return await this.call<RejoinStatus>('/internal/rejoin', {
        token: proof.token, profile: proof.profile, ident: encodeIdent(this.host.identOf(this, proof.profile)),
      }, 3000).then((r) => (runner === this.runner ? r : { state: 'none', secondsLeft: 0 }));
    } catch {
      return { state: 'none', secondsLeft: 0 };
    }
  }

  reserve(key: string, party: string, size: number, ttlMs: number): ReturnType<GameServer['reserve']> {
    if (this.closed || this.failed || size < 1) return null;
    if (this.playerCount + this.reservedSeats + size > this.maxPlayers) return null;
    const hold: PendingHold = { size, expires: Date.now() + ttlMs, team: '' };
    this.holds.set(key, hold);
    void this.op({ op: 'reserve', key, party, size, ttlMs }).then((r) => {
      const got = r?.hold as { team: 'red' | 'blue' | '' } | null | undefined;
      if (!got) this.holds.delete(key);
      else hold.team = got.team;
    });
    return { team: '' };
  }

  release(key: string): void {
    this.holds.delete(key);
    void this.op({ op: 'release', key });
  }

  playerList(): ReturnType<GameServer['playerList']> {
    return (this.st?.playerList ?? []) as ReturnType<GameServer['playerList']>;
  }

  kickPlayer(name: string, reason: string): boolean {
    const online = this.playerList().some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (online) void this.op({ op: 'kick', name, reason });
    return online;
  }

  private pushSkins(skins: Record<string, string>): void {
    if (Object.keys(skins).length) void this.op({ op: 'skins', skins });
  }

  /** A profile's skin changed (or hashes were banned: no id): the runner gets what its players wear now. */
  refreshSkins(profileId?: string): void {
    this.pushSkins(this.host.skinsFor(this, profileId));
  }

  announce(text: string): void {
    void this.op({ op: 'announce', text });
  }

  save(): void {
    void this.op({ op: 'save' });
  }

  shutdown(reconnectMs?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    // The runner settles XP, sends world.json back and reports `stopping`; then the pool stops its container.
    // With `reconnectMs` its players are told to come back (an admin restarted the runner: the lobby reopens).
    void this.op({ op: 'shutdown', ...(reason ? { reason } : {}), ...(reconnectMs ? { reconnectMs } : {}) });
  }

  detach(reconnectMs?: number): void {
    this.closed = true;
    for (const ws of this.clients) {
      try {
        ws.send(JSON.stringify({ t: 'kick', reason: 'Server restarting', ...(reconnectMs ? { reconnect: reconnectMs } : {}) }));
        ws.close(1012, 'Server restarting');
      } catch { ws.terminate(); }
    }
  }

  /** The runner stopped (or died): every player here is disconnected. */
  ended(): void {
    this.closed = true;
    for (const ws of this.clients) ws.close(1001, 'Match ended');
  }

  accept(ws: WebSocket, meta: { ip?: string } = {}): void {
    if (this.closed || this.failed) { ws.close(1001, 'Match ended'); return; }
    this.clients.add(ws);
    bridge(ws, {
      connect: async (first) => {
        const runner = await withTimeout(this.ready, 20_000, 'match server did not start');
        await withTimeout(this.chain, 5000, 'match server busy');
        const ip = meta.ip ?? 'unknown';
        const { ident, first: rewritten } = this.host.identify(this, runner, first, ip);
        const upstream = new WebSocket(`${runner.url.replace(/^http/, 'ws')}/ws`, {
          headers: {
            ...authHeaders(runner.id, runner.key), 'x-bc-ip': ip, 'x-bc-ident': encodeIdent(ident),
            'x-bc-pw': this.host.passwordBlocked(this, ip) ? 'blocked' : 'ok',
          },
          autoPong: false, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 5000,
        });
        await new Promise<void>((resolve, reject) => {
          upstream.once('open', () => resolve());
          upstream.once('error', reject);
          upstream.once('unexpected-response', (_req, res) => reject(new Error(`match server answered ${res.statusCode}`)));
        });
        this.joinedSinceBeat++;
        return { upstream, first: rewritten };
      },
      onClose: () => { this.clients.delete(ws); },
    });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(why)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

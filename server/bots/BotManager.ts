import type { BlockGetter } from '../../src/player/Collision';
import type { Team } from '../../src/modes/GameTypes';
import type { ClientMessage, ServerMessage } from '../../src/net/protocol';
import type { Match } from '../Match';
import { Bot, type BotEnv } from './Bot';
import { type BotDifficulty, botName, skillFor } from './BotSkill';
import type { NavGraph } from './NavGraph';

/**
 * Bots of one lobby. Quick play lobbies `fill` up to a lobby size (bots leave as people join); a private
 * lobby's host picks a fixed `count`. Either way bots never take a seat a person wants: a joining player
 * pushes a bot out first.
 */
export interface BotSettings {
  /** Fill the lobby with bots up to this many players (0 = no filling). */
  fill?: number;
  /** A fixed number of bots (private lobbies); ignored when `fill` is set. */
  count?: number;
  difficulty?: BotDifficulty;
}

/** Valid settings from anything (a request body, world.json), clamped to the lobby size. */
export function parseBotSettings(raw: unknown, maxPlayers: number): BotSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(maxPlayers, Math.round(v))) : 0);
  const fill = int(r.fill), count = Math.min(maxPlayers - 1, int(r.count));
  const difficulty = (['easy', 'normal', 'hard', 'veteran'] as const).find((d) => d === r.difficulty) ?? 'normal';
  if (fill <= 0 && count <= 0) return undefined;
  return fill > 0 ? { fill, difficulty } : { count, difficulty };
}

/** What the manager needs from the game server (GameServer implements it; tests can fake it). */
export interface BotHost {
  readonly match: Match;
  /** Server tick rate (Hz): bots report their position at most at the client's rate. */
  readonly tickHz: number;
  /** Clock in seconds (the server's: Date.now based). */
  now(): number;
  graph(): NavGraph;
  getBlock: BlockGetter;
  getMeta?: BlockGetter;
  /** Connected people (bots excluded). */
  humans(): number;
  /** Seats in the lobby (people and bots). */
  capacity(): number;
  /** Seats held for parties that are on their way in (bots keep clear of them). */
  reserved?(): number;
  /** Lower-case names in use. */
  names(): Set<string>;
  /** Adds a bot player; `sink(id)` returns its message handler. Null when there is no seat. */
  addBot(name: string, sink: (id: number) => (msg: ServerMessage) => void): number | null;
  removeBot(id: number): void;
  /** A message from a bot, handled like one from a socket (rate limits, validation and all). */
  deliver(id: number, msg: ClientMessage): void;
  random(): number;
}

/** Thinking budget per tick for all bots of a lobby (ms); movement and aim run regardless. */
export const THINK_BUDGET_MS = 1.5;
/** Path searches per tick per lobby. */
export const PATHS_PER_TICK = 3;
/** Bots added per adjustment (once a second): a lobby fills within a few seconds without a spike. */
const ADD_PER_STEP = 4;

export class BotManager {
  readonly bots = new Map<number, Bot>();
  /** The bots in a reused array for the tick loop. */
  private readonly list: Bot[] = [];
  settings: BotSettings | undefined;
  readonly env: BotEnv;
  private nextAdjust = 0;
  private modeAt = 0;
  private graphKey = '';
  private lastShot: ServerMessage | null = null;
  private rotate = 0;
  private added = 0;
  /** Perf counters: ticks, total and worst tick time of the bots (ms). */
  readonly perf = { ticks: 0, totalMs: 0, maxMs: 0, thinks: 0, skippedThinks: 0 };

  constructor(private readonly host: BotHost, settings: BotSettings | undefined) {
    this.settings = settings;
    const h = host;
    this.env = {
      match: host.match,
      graph: null as unknown as NavGraph,
      blocks: { getBlock: (x, y, z) => h.getBlock(x, y, z) },
      getBlock: (x, y, z) => h.getBlock(x, y, z),
      getMeta: host.getMeta ? (x, y, z) => h.getMeta!(x, y, z) : undefined,
      rng: () => h.random(),
      send: (id, msg) => h.deliver(id, msg),
      mode: null,
      pathTokens: PATHS_PER_TICK,
      heard: [],
    };
  }

  get count(): number {
    return this.bots.size;
  }

  isBot(id: number): boolean {
    return this.bots.has(id);
  }

  /** How many bots the lobby wants right now. */
  desired(): number {
    const s = this.settings;
    const humans = this.host.humans();
    if (!s || humans === 0) return 0;
    const seats = Math.max(0, this.host.capacity() - humans - (this.host.reserved?.() ?? 0));
    const want = s.fill ? s.fill - humans : s.count ?? 0;
    return Math.max(0, Math.min(seats, want));
  }

  /** The number of wanted bots changed (a party reserved seats): applied at the next adjustment. */
  refresh(): void {
    this.nextAdjust = 0;
  }

  /** Settings changed (host): applied at the next adjustment. */
  configure(settings: BotSettings | undefined): void {
    this.settings = settings;
    this.nextAdjust = 0;
  }

  /** A person is about to join a full lobby: a bot leaves (from `team` when given). Returns whether a seat was freed. */
  makeRoom(team?: Team): boolean {
    const victim = this.pickLeaver(team);
    if (victim === null) return false;
    this.remove(victim);
    return true;
  }

  removeAll(): void {
    for (const id of [...this.bots.keys()]) this.remove(id);
  }

  private remove(id: number): void {
    const bot = this.bots.get(id);
    this.bots.delete(id);
    if (bot) this.list.splice(this.list.indexOf(bot), 1);
    this.host.removeBot(id);
  }

  /** Which bot leaves: from the bigger team (team modes), a dead one first, never a flag carrier if avoidable. */
  private pickLeaver(team?: Team): number | null {
    const m = this.host.match;
    let from: Team | '' = team ?? '';
    if (!from && m.teams) {
      const red = m.teamSize('red'), blue = m.teamSize('blue');
      from = red > blue ? 'red' : blue > red ? 'blue' : '';
    }
    let best: number | null = null, bestScore = -Infinity;
    for (const id of this.bots.keys()) {
      const p = m.players.get(id);
      if (!p) return id;
      let score = 0;
      if (from && p.team === from) score += 100;
      if (!p.alive) score += 10;
      if (this.carries(id)) score -= 50;
      score -= p.kills * 0.1;
      if (score > bestScore) { bestScore = score; best = id; }
    }
    return best;
  }

  private carries(id: number): boolean {
    const mode = this.env.mode;
    return mode?.kind === 'ctf' && mode.flags.some((f) => f.status === 'carried' && f.carrier === id);
  }

  /** Adds or removes bots towards the wanted number and keeps the teams even (bots move, people stay). */
  private adjust(): void {
    const want = this.desired();
    while (this.bots.size > want) {
      const id = this.pickLeaver();
      if (id === null) break;
      this.remove(id);
    }
    let added = 0;
    while (this.bots.size < want && added < ADD_PER_STEP) {
      if (!this.add()) break;
      added++;
    }
    const m = this.host.match;
    if (m.teams && added === 0) {
      // Uneven by two or more and the bigger team has a bot: it leaves, and the next step adds one to the smaller team.
      const red = m.teamSize('red'), blue = m.teamSize('blue');
      if (Math.abs(red - blue) >= 2) {
        const big: Team = red > blue ? 'red' : 'blue';
        for (const id of this.bots.keys()) {
          if (m.players.get(id)?.team === big && !this.carries(id)) { this.remove(id); break; }
        }
      }
    }
  }

  private add(): boolean {
    const s = this.settings;
    const name = botName(this.host.names(), () => this.host.random());
    const skill = skillFor(s?.difficulty ?? 'normal', () => this.host.random());
    const index = this.added++;
    const posInterval = 1 / Math.min(this.host.tickHz, 30);
    let bot: Bot | null = null;
    const id = this.host.addBot(name, (newId) => {
      bot = new Bot(newId, name, skill, this.env, index, posInterval);
      this.bots.set(newId, bot);
      this.list.push(bot);
      return (msg) => this.deliver(newId, msg);
    });
    if (id === null) {
      if (bot) { this.bots.delete((bot as Bot).id); this.list.splice(this.list.indexOf(bot), 1); }
      return false;
    }
    return true;
  }

  /** Server → bot: gunfire is recorded once for everybody, the rest goes to the bot. */
  private deliver(id: number, msg: ServerMessage): void {
    if (msg.t === 'shot') {
      if (msg !== this.lastShot) {
        this.lastShot = msg;
        this.env.heard.push({ id: msg.id, x: msg.ox, y: msg.oy, z: msg.oz, t: this.host.now(), quiet: msg.sup === 1 });
      }
      return;
    }
    if (msg.t === 'snap' || msg.t === 'roster' || msg.t === 'match' || msg.t === 'holds' || msg.t === 'ammo' || msg.t === 'chat') return;
    this.bots.get(id)?.onMessage(msg, this.host.now());
  }

  /** Every server tick, before the match ticks: movement, aim and fire for every bot; thinking within the budget. */
  tick(): void {
    const host = this.host;
    const now = host.now();
    if (host.humans() === 0) {
      if (this.bots.size) this.removeAll();
      return;
    }
    if (now >= this.nextAdjust) {
      this.nextAdjust = now + 1;
      this.adjust();
    }
    if (this.bots.size === 0) return;
    const t0 = performance.now();
    const key = host.match.map.id;
    if (key !== this.graphKey) {
      this.graphKey = key;
      this.env.graph = host.graph();
      for (const b of this.bots.values()) b.mover.clearRoute();
    }
    if (now >= this.modeAt) {
      this.modeAt = now + 0.25;
      this.env.mode = host.match.logic.modeState?.(host.match) ?? null;
    }
    const heard = this.env.heard;
    let drop = 0;
    while (drop < heard.length && now - heard[drop].t > 2) drop++;
    if (drop) heard.splice(0, drop);
    this.env.pathTokens = PATHS_PER_TICK;
    // Rotating start: under budget pressure every bot still gets its turn to think.
    const list = this.list;
    const n = list.length;
    this.rotate = (this.rotate + 1) % Math.max(1, n);
    for (let i = 0; i < n; i++) {
      const b = list[(i + this.rotate) % n];
      const wants = b.wantsThink(now);
      const may = performance.now() - t0 < THINK_BUDGET_MS;
      if (wants) { if (may) this.perf.thinks++; else this.perf.skippedThinks++; }
      b.tick(now, may);
    }
    const ms = performance.now() - t0;
    this.perf.ticks++;
    this.perf.totalMs += ms;
    if (ms > this.perf.maxMs) this.perf.maxMs = ms;
  }
}

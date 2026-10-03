import { type ArenaMap, DEFAULT_MAP, type Spawn, getMap } from '../src/modes/maps';
import type { Team } from '../src/modes/GameTypes';
import {
  DEFAULT_PRIMARY, PLAYER_MAX_HEALTH, PRIMARY_WEAPONS, REGEN_DELAY, REGEN_PER_SECOND, RESPAWN_SECONDS,
  type WeaponDef, damageAt, fireInterval, weaponDef,
} from '../src/modes/Weapons';
import type {
  ClientMessage, MatchInfo, MatchPhase, RosterEntry, ServerMessage,
} from '../src/net/protocol';
import { type BlockQuery, rayPlayer, spreadDirection, traceBlocks } from './Combat';
import { PEEK_LIMIT, bodyVisible, rewindWindow } from './anticheat/LagComp';

/** Seconds of warm-up once at least two players are in the game. */
export const WARMUP_SECONDS = 10;
/** The result stays on screen this long before the next match. */
export const ENDED_SECONDS = 12;
export const SPAWN_PROTECTION = 2;
export const SWITCH_DELAY = 0.25;
export const EYE_HEIGHT = 1.62;
/**
 * A client-reported shot origin further than this from the server's eye is replaced by the server's.
 * Backstop only: GameServer already checks the origin against the extrapolated eye within 0.6 blocks
 * (see anticheat/AimCheck.ts) and replaces it before the shot gets here.
 */
export const MAX_ORIGIN_DRIFT = 1.6;
/** Lag compensation: history kept per player; the rewind limits live in anticheat/LagComp.ts. */
export const HISTORY_SECONDS = 1;
export { DEFAULT_REWIND, MAX_REWIND } from './anticheat/LagComp';
/** Fire messages may arrive this much (s) earlier than the weapon's cadence allows (network jitter). */
const FIRE_SLACK = 0.04;
const HISTORY_SIZE = 24;

export interface MatchHost {
  /** Monotonic clock in seconds. */
  now(): number;
  send(id: number, msg: ServerMessage): void;
  broadcast(msg: ServerMessage, except?: number): void;
  /** What bullets collide with. */
  blocks: BlockQuery;
  /** The server puts a player somewhere (spawn); the connection layer must stop trusting the old position. */
  moveTo(id: number, x: number, y: number, z: number): void;
  random(): number;
  /** Round-trip time in ms, 0 when unknown. */
  ping(id: number): number;
  /** Seconds the clients draw other players in the past (2 snapshot intervals); default 0.1. */
  interpDelay?: number;
  /** Every resolved shot, for the anti-cheat statistics (see anticheat/Suspicion.ts). */
  onShot?(shot: ShotReport): void;
  /**
   * A new match is about to start on `current`: returns the map to play next (the host swaps its
   * bullet world), or null to keep the map.
   */
  nextMap?(current: string): string | null;
}

export interface ShotReport {
  shooter: number;
  weapon: string;
  /** Normalised aim direction and origin as used by the server. */
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  /** Players hit by this shot (any pellet), with the distance and whether a pellet hit the head. */
  hits: { victim: number; dist: number; head: boolean }[];
}

interface Slot {
  def: WeaponDef;
  mag: number;
  nextFireAt: number;
  /** 0 when not reloading. */
  reloadDoneAt: number;
}

interface Sample { t: number; x: number; y: number; z: number }

export interface MatchPlayer {
  id: number;
  name: string;
  team: Team | '';
  kills: number;
  deaths: number;
  /** Order of joining (higher = joined later); decides who moves when the teams get uneven. */
  joinSeq: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  alive: boolean;
  health: number;
  lastDamageAt: number;
  lastHpSent: number;
  respawnAt: number;
  protectedUntil: number;
  /** Primary weapon of this life and the one chosen for the next. */
  primary: string;
  nextPrimary: string;
  slots: [Slot, Slot, Slot];
  slot: 0 | 1 | 2;
  switchReadyAt: number;
  history: Sample[];
  historyHead: number;
  historyCount: number;
}

const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/**
 * One arcade match (team deathmatch or free for all): teams, phases, scores, spawns, health,
 * weapons and the server-authoritative hitscan. Knows nothing about sockets: everything goes
 * through the MatchHost, which makes it testable with a fake clock.
 */
export class Match {
  phase: MatchPhase = 'warmup';
  readonly players = new Map<number, MatchPlayer>();
  private readonly scores = { red: 0, blue: 0 };
  private warmupEnd = 0;
  private liveEnd = 0;
  private restartAt = 0;
  private lastTick = 0;
  private nextMatchMsg = 0;
  private nextRoster = 0;
  private joinCounter = 0;
  /** Player who changes team at their next respawn because the other team lost players (0 = nobody). */
  private moveId = 0;
  private readonly tmpDir: [number, number, number] = [0, 0, 0];
  private readonly tmpPos: [number, number, number] = [0, 0, 0];
  private readonly targets: { o: MatchPlayer; x: number; y: number; z: number }[] = [];

  /** The arena this match is played on. */
  map: ArenaMap;

  constructor(private readonly host: MatchHost, readonly info: MatchInfo) {
    this.lastTick = host.now();
    this.map = getMap(info.map ?? DEFAULT_MAP);
    info.map = this.map.id;
  }

  setMap(id: string): void {
    this.map = getMap(id);
    this.info.map = this.map.id;
  }

  get teams(): boolean {
    return this.info.type === 'tdm';
  }

  teamScore(team: Team): number {
    return this.scores[team];
  }

  // ---------------------------------------------------------------- players

  /**
   * Adds a player: picks the team and a spawn and returns them so the welcome message can carry
   * them. Nothing is sent yet; call `ready` once the player is in the game.
   */
  join(id: number, name: string): MatchPlayer {
    const now = this.host.now();
    let team: Team | '' = '';
    if (this.teams) {
      let red = 0, blue = 0;
      for (const p of this.players.values()) if (p.team === 'red') red++; else if (p.team === 'blue') blue++;
      // The smaller team; when they are the same size, the one that is behind on points.
      team = red !== blue ? (red < blue ? 'red' : 'blue') : this.scores.red <= this.scores.blue ? 'red' : 'blue';
    }
    const p: MatchPlayer = {
      id, name, team, kills: 0, deaths: 0, joinSeq: ++this.joinCounter, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, health: PLAYER_MAX_HEALTH,
      lastDamageAt: -1e9, lastHpSent: PLAYER_MAX_HEALTH, respawnAt: 0, protectedUntil: 0,
      primary: DEFAULT_PRIMARY, nextPrimary: DEFAULT_PRIMARY, slots: [newSlot(DEFAULT_PRIMARY), newSlot('pistol'), newSlot('knife')], slot: 0,
      switchReadyAt: 0, history: Array.from({ length: HISTORY_SIZE }, () => ({ t: 0, x: 0, y: 0, z: 0 })), historyHead: 0, historyCount: 0,
    };
    this.players.set(id, p);
    this.resetLife(p, now);
    return p;
  }

  /** The player's connection is up: tell them and everyone else. */
  ready(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    this.sendSpawn(p);
    this.host.send(id, this.matchMessage());
    for (const o of this.players.values()) {
      if (o.id !== id) this.host.send(id, { t: 'holds', id: o.id, weapon: o.slots[o.slot].def.id });
    }
    this.host.broadcast({ t: 'holds', id, weapon: p.slots[p.slot].def.id });
    this.broadcastRoster();
  }

  leave(id: number): void {
    if (!this.players.delete(id)) return;
    if (this.teams) this.planBalance();
    this.broadcastRoster();
    if (this.players.size === 0) this.reset();
  }

  /** Fresh match with nobody in it (the room emptied). */
  reset(): void {
    this.phase = 'warmup';
    this.warmupEnd = 0;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; }
  }

  setPosition(id: number, x: number, y: number, z: number, yaw = 0, pitch = 0): void {
    const p = this.players.get(id);
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.pitch = pitch;
  }

  setLoadout(id: number, primary: string): void {
    const p = this.players.get(id);
    if (p && PRIMARY_WEAPONS.includes(primary)) p.nextPrimary = primary;
  }

  // ---------------------------------------------------------------- weapons

  switchWeapon(id: number, slot: number): void {
    const p = this.players.get(id);
    if (!p || !p.alive || !isSlot(slot) || slot === p.slot) return;
    const now = this.host.now();
    // Switching cancels a reload in progress.
    for (let i = 0; i < 3; i++) {
      const s = p.slots[i];
      if (s.reloadDoneAt > 0) {
        s.reloadDoneAt = 0;
        this.host.send(id, { t: 'ammo', slot: i as 0 | 1 | 2, mag: s.mag, reloading: false });
      }
    }
    p.slot = slot;
    p.switchReadyAt = now + SWITCH_DELAY;
    this.host.broadcast({ t: 'holds', id, weapon: p.slots[slot].def.id });
  }

  reload(id: number, slot: number): void {
    const p = this.players.get(id);
    if (!p || !p.alive || !isSlot(slot)) return;
    if (slot !== p.slot) return;
    this.startReload(p, this.host.now());
  }

  private startReload(p: MatchPlayer, now: number): void {
    const s = p.slots[p.slot];
    if (s.def.magazine <= 0 || s.mag >= s.def.magazine || s.reloadDoneAt > 0 || now < p.switchReadyAt) return;
    s.reloadDoneAt = now + s.def.reloadSec;
    this.host.send(p.id, { t: 'ammo', slot: p.slot, mag: s.mag, reloading: true });
  }

  /** A `fire` request: validates and resolves the whole hitscan shot. Returns whether a shot was fired. */
  fire(id: number, m: Extract<ClientMessage, { t: 'fire' }>): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase === 'ended' || !isSlot(m.slot)) return false;
    const nums = [m.ox, m.oy, m.oz, m.dx, m.dy, m.dz];
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false;
    const len = Math.hypot(m.dx, m.dy, m.dz);
    if (len < 1e-3) return false;
    const now = this.host.now();
    if (m.slot !== p.slot) this.switchWeapon(id, m.slot); // the client switched without telling us
    const s = p.slots[p.slot];
    const w = s.def;
    if (now < p.switchReadyAt || s.reloadDoneAt > 0) return false;
    if (now < s.nextFireAt - FIRE_SLACK) return false;
    if (w.magazine > 0 && s.mag <= 0) {
      this.startReload(p, now); // clicking an empty weapon reloads it
      return false;
    }
    s.nextFireAt = Math.max(s.nextFireAt, now - FIRE_SLACK) + fireInterval(w);
    if (w.magazine > 0) {
      s.mag--;
      this.host.send(id, { t: 'ammo', slot: p.slot, mag: s.mag, reloading: false });
    }

    const ex = p.x, ey = p.y + EYE_HEIGHT, ez = p.z;
    const trusted = Math.hypot(m.ox - ex, m.oy - ey, m.oz - ez) <= MAX_ORIGIN_DRIFT;
    const ox = trusted ? m.ox : ex, oy = trusted ? m.oy : ey, oz = trusted ? m.oz : ez;
    const dx = m.dx / len, dy = m.dy / len, dz = m.dz / len;
    const spread = m.ads && w.slot !== 'melee' ? w.adsSpread : w.spread;

    // Lag compensation: targets are tested where this shooter saw them.
    const rewind = rewindWindow(this.host.ping(id), this.host.interpDelay);
    const at = now - rewind;
    const damaging = this.phase === 'live';
    // Where each target is tested. Peeker's advantage limit: a target that was already behind cover
    // PEEK_LIMIT seconds ago (as seen from this shot's origin) is not rewound further back into the open.
    const targets = this.targets;
    targets.length = 0;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      if (this.teams && o.team === p.team) continue; // no friendly fire
      const t = { o, x: 0, y: 0, z: 0 };
      this.positionAt(o, at, now, this.tmpPos);
      t.x = this.tmpPos[0]; t.y = this.tmpPos[1]; t.z = this.tmpPos[2];
      if (rewind > PEEK_LIMIT) {
        this.positionAt(o, now - PEEK_LIMIT, now, this.tmpPos);
        if (!bodyVisible(this.host.blocks, ox, oy, oz, this.tmpPos[0], this.tmpPos[1], this.tmpPos[2])) {
          t.x = this.tmpPos[0]; t.y = this.tmpPos[1]; t.z = this.tmpPos[2];
        }
      }
      targets.push(t);
    }

    const dealt = new Map<number, { damage: number; head: boolean }>();
    let tracer: [number, number, number] | null = null;
    const dir = this.tmpDir;
    const hitList: ShotReport['hits'] = [];
    for (let k = 0; k < w.pellets; k++) {
      spreadDirection(dx, dy, dz, spread, this.host.random(), this.host.random(), dir);
      let tEnd = traceBlocks(this.host.blocks, ox, oy, oz, dir[0], dir[1], dir[2], w.maxRange);
      let victim: MatchPlayer | null = null;
      let hitHead = false;
      for (const t of targets) {
        const hit = rayPlayer(ox, oy, oz, dir[0], dir[1], dir[2], t.x, t.y, t.z);
        if (hit && hit.t < tEnd) { tEnd = hit.t; victim = t.o; hitHead = hit.head; }
      }
      if (victim) {
        const prevHit = hitList.find((h) => h.victim === victim!.id);
        if (prevHit) prevHit.head ||= hitHead; else hitList.push({ victim: victim.id, dist: tEnd, head: hitHead });
      }
      if (!tracer) tracer = [ox + dir[0] * tEnd, oy + dir[1] * tEnd, oz + dir[2] * tEnd];
      if (victim && damaging && now >= victim.protectedUntil) {
        const dmg = damageAt(w, tEnd) * (hitHead ? w.headshot : 1);
        const prev = dealt.get(victim.id);
        if (prev) { prev.damage += dmg; prev.head ||= hitHead; } else dealt.set(victim.id, { damage: dmg, head: hitHead });
      }
    }
    if (w.slot !== 'melee') {
      const [tx, ty, tz] = tracer!;
      this.host.broadcast({ t: 'shot', id, weapon: w.id, ox: r2(ox), oy: r2(oy), oz: r2(oz), ex: r2(tx), ey: r2(ty), ez: r2(tz) });
    }
    for (const [vid, d] of dealt) this.applyDamage(p, this.players.get(vid)!, Math.max(1, Math.round(d.damage)), w, d.head, now);
    this.host.onShot?.({ shooter: id, weapon: w.id, ox, oy, oz, dx, dy, dz, hits: hitList });
    return true;
  }

  private applyDamage(killer: MatchPlayer, victim: MatchPlayer, amount: number, w: WeaponDef, head: boolean, now: number): void {
    victim.health = Math.max(0, victim.health - amount);
    victim.lastDamageAt = now;
    const killed = victim.health <= 0;
    this.host.send(killer.id, { t: 'hit', victim: victim.id, damage: amount, head, killed });
    const hx = killer.x - victim.x, hz = killer.z - victim.z, hl = Math.hypot(hx, hz) || 1;
    this.host.send(victim.id, { t: 'damaged', from: killer.id, damage: amount, dx: r2(hx / hl), dz: r2(hz / hl) });
    if (!killed) {
      this.sendHp(victim, true);
      return;
    }
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = now + RESPAWN_SECONDS;
    victim.historyCount = 0;
    killer.kills++;
    if (this.teams && killer.team) this.scores[killer.team]++;
    this.sendHp(victim, true);
    this.host.broadcast({ t: 'kill', killer: killer.id, victim: victim.id, weapon: w.id, head });
    this.broadcastRoster();
    this.broadcastMatch();
    this.checkScoreLimit(now);
  }

  // ---------------------------------------------------------------- lag compensation

  /** Where a player was at time `t` (seconds): interpolated between recorded ticks. */
  private positionAt(p: MatchPlayer, t: number, now: number, out: [number, number, number]): void {
    // Newest sample is the live position at `now`.
    let nx = p.x, ny = p.y, nz = p.z, nt = now;
    for (let i = 0; i < p.historyCount; i++) {
      const s = p.history[(p.historyHead - 1 - i + HISTORY_SIZE * 2) % HISTORY_SIZE];
      if (s.t <= t) {
        const span = nt - s.t;
        const f = span > 1e-6 ? (t - s.t) / span : 0;
        out[0] = s.x + (nx - s.x) * f; out[1] = s.y + (ny - s.y) * f; out[2] = s.z + (nz - s.z) * f;
        return;
      }
      nx = s.x; ny = s.y; nz = s.z; nt = s.t;
    }
    // Older than anything recorded: the oldest known position.
    out[0] = nx; out[1] = ny; out[2] = nz;
  }

  private record(p: MatchPlayer, now: number): void {
    const s = p.history[p.historyHead];
    s.t = now; s.x = p.x; s.y = p.y; s.z = p.z;
    p.historyHead = (p.historyHead + 1) % HISTORY_SIZE;
    if (p.historyCount < HISTORY_SIZE) p.historyCount++;
  }

  // ---------------------------------------------------------------- phases and ticking

  tick(): void {
    const now = this.host.now();
    const dt = Math.min(0.25, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    if (this.players.size === 0) return;
    for (const p of this.players.values()) if (p.alive) this.record(p, now);

    if (this.phase === 'warmup') {
      if (this.players.size < 2) this.warmupEnd = 0;
      else if (this.warmupEnd === 0) { this.warmupEnd = now + WARMUP_SECONDS; this.broadcastMatch(); }
      else if (now >= this.warmupEnd) this.startLive(now);
    } else if (this.phase === 'live') {
      if (this.info.timeLimitSec > 0 && now >= this.liveEnd) this.endMatch(now);
    } else if (now >= this.restartAt) {
      this.restart(now);
    }

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.phase !== 'ended' && now >= p.respawnAt) this.respawn(p, now);
        continue;
      }
      for (let i = 0; i < 3; i++) {
        const s = p.slots[i];
        if (s.reloadDoneAt > 0 && now >= s.reloadDoneAt) {
          s.reloadDoneAt = 0;
          s.mag = s.def.magazine;
          this.host.send(p.id, { t: 'ammo', slot: i as 0 | 1 | 2, mag: s.mag, reloading: false });
        }
      }
      if (p.health < PLAYER_MAX_HEALTH && now - p.lastDamageAt >= REGEN_DELAY) {
        p.health = Math.min(PLAYER_MAX_HEALTH, p.health + REGEN_PER_SECOND * dt);
        this.sendHp(p, p.health >= PLAYER_MAX_HEALTH);
      }
    }

    if (now >= this.nextMatchMsg) this.broadcastMatch();
    if (now >= this.nextRoster) this.broadcastRoster();
  }

  private startLive(now: number): void {
    this.phase = 'live';
    this.liveEnd = now + this.info.timeLimitSec;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; }
    this.respawnAll(now);
    this.broadcastMatch();
    this.broadcastRoster();
  }

  private checkScoreLimit(now: number): void {
    if (this.phase !== 'live' || this.info.scoreLimit <= 0) return;
    const limit = this.info.scoreLimit;
    const reached = this.teams
      ? this.scores.red >= limit || this.scores.blue >= limit
      : [...this.players.values()].some((p) => p.kills >= limit);
    if (reached) this.endMatch(now);
  }

  private endMatch(now: number): void {
    this.phase = 'ended';
    this.restartAt = now + ENDED_SECONDS;
    let winnerTeam: Team | '' = '';
    let winnerId = 0;
    if (this.teams) {
      if (this.scores.red > this.scores.blue) winnerTeam = 'red';
      else if (this.scores.blue > this.scores.red) winnerTeam = 'blue';
    } else {
      let best = 0, tie = false;
      for (const p of this.players.values()) {
        if (p.kills > best) { best = p.kills; winnerId = p.id; tie = false; } else if (p.kills === best && best > 0) tie = true;
      }
      if (tie) winnerId = 0;
    }
    this.host.broadcast({ t: 'matchend', winnerTeam, winnerId, restartIn: ENDED_SECONDS });
    this.broadcastMatch();
    this.broadcastRoster();
  }

  /** Next match: scores reset, teams rebalanced, everyone respawns into a new warm-up. */
  private restart(now: number): void {
    const next = this.host.nextMap?.(this.map.id);
    if (next && next !== this.map.id) this.setMap(next);
    this.phase = 'warmup';
    this.warmupEnd = 0;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; }
    if (this.teams) this.rebalance();
    this.respawnAll(now);
    this.broadcastMatch();
    this.broadcastRoster();
  }

  /** Number of players on a team. */
  private teamSize(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  /**
   * After somebody left: when the teams differ by two or more, the player who joined last on the
   * larger team switches at their next respawn (never in the middle of a life).
   */
  private planBalance(): void {
    this.moveId = 0;
    const red = this.teamSize('red'), blue = this.teamSize('blue');
    if (Math.abs(red - blue) < 2) return;
    const larger: Team = red > blue ? 'red' : 'blue';
    let latest: MatchPlayer | null = null;
    for (const p of this.players.values()) if (p.team === larger && (!latest || p.joinSeq > latest.joinSeq)) latest = p;
    if (latest) this.moveId = latest.id;
  }

  /** At a respawn: carries out a planned team switch if the teams are still uneven. */
  private applyBalance(p: MatchPlayer): void {
    if (p.id !== this.moveId) return;
    this.moveId = 0;
    if (!p.team) return;
    const own = this.teamSize(p.team), other = this.teamSize(p.team === 'red' ? 'blue' : 'red');
    if (own - other < 2) return;
    p.team = p.team === 'red' ? 'blue' : 'red';
    this.host.broadcast({ t: 'chat', from: '', text: `${p.name} moved to the ${p.team} team to even the teams`, system: true });
    this.broadcastRoster();
  }

  private rebalance(): void {
    for (;;) {
      const red = [...this.players.values()].filter((p) => p.team === 'red');
      const blue = [...this.players.values()].filter((p) => p.team === 'blue');
      if (Math.abs(red.length - blue.length) <= 1) return;
      const [from, to]: [MatchPlayer[], Team] = red.length > blue.length ? [red, 'blue'] : [blue, 'red'];
      from[from.length - 1].team = to; // the latest joiner moves
    }
  }

  // ---------------------------------------------------------------- spawning

  private respawnAll(now: number): void {
    for (const p of this.players.values()) this.respawn(p, now);
  }

  private respawn(p: MatchPlayer, now: number): void {
    if (this.teams) this.applyBalance(p);
    this.resetLife(p, now);
    this.sendSpawn(p);
    this.host.broadcast({ t: 'holds', id: p.id, weapon: p.primary }, p.id);
  }

  /** Full health, full magazines, the chosen primary, a fresh spawn point and brief protection. */
  private resetLife(p: MatchPlayer, now: number): void {
    p.alive = true;
    p.health = PLAYER_MAX_HEALTH;
    p.lastHpSent = PLAYER_MAX_HEALTH;
    p.lastDamageAt = -1e9;
    p.protectedUntil = now + SPAWN_PROTECTION;
    p.primary = p.nextPrimary;
    p.slots = [newSlot(p.primary), newSlot('pistol'), newSlot('knife')];
    p.slot = 0;
    p.switchReadyAt = 0;
    const s = this.pickSpawn(p);
    p.x = s.x; p.y = s.y; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    p.historyCount = 0;
  }

  private sendSpawn(p: MatchPlayer): void {
    this.host.moveTo(p.id, p.x, p.y, p.z);
    this.host.send(p.id, { t: 'spawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team, primary: p.primary, health: p.health });
    for (let i = 0; i < 3; i++) this.host.send(p.id, { t: 'ammo', slot: i as 0 | 1 | 2, mag: p.slots[i].mag, reloading: false });
  }

  /**
   * The team's spawn (tdm) or any spawn (ffa) that is furthest from the living opponents, with a
   * little randomness so the same point is not used every time.
   */
  pickSpawn(p: MatchPlayer): Spawn {
    const list: Spawn[] = this.teams && p.team ? this.map.spawns[p.team] : this.map.spawns.ffa;
    let best = list[0], bestScore = -Infinity;
    for (const s of list) {
      let nearest = 1000;
      for (const o of this.players.values()) {
        if (o === p || !o.alive || (this.teams && o.team === p.team)) continue;
        nearest = Math.min(nearest, dist2(s.x, s.z, o.x, o.z));
      }
      const score = nearest + this.host.random() * 5;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /** Whether a position lies inside the walkable part of the arena (the wall ring is out). */
  inBounds(x: number, z: number): boolean {
    return this.map.inBounds(x, z);
  }

  // ---------------------------------------------------------------- messages out

  private sendHp(p: MatchPlayer, force: boolean): void {
    const hp = Math.max(0, Math.ceil(p.health));
    if (hp === p.lastHpSent && !force) return;
    if (!force && Math.abs(hp - p.lastHpSent) < 5 && hp < PLAYER_MAX_HEALTH) return;
    p.lastHpSent = hp;
    this.host.send(p.id, { t: 'hp', health: hp });
  }

  timeLeft(): number {
    const now = this.host.now();
    if (this.phase === 'warmup') return this.warmupEnd > 0 ? Math.max(0, Math.ceil(this.warmupEnd - now)) : WARMUP_SECONDS;
    if (this.phase === 'live') return Math.max(0, Math.ceil(this.liveEnd - now));
    return Math.max(0, Math.ceil(this.restartAt - now));
  }

  private matchMessage(): ServerMessage {
    return {
      t: 'match', phase: this.phase, timeLeft: this.timeLeft(),
      scores: this.teams ? { red: this.scores.red, blue: this.scores.blue } : { red: 0, blue: 0 }, info: this.info,
    };
  }

  private broadcastMatch(): void {
    this.nextMatchMsg = this.host.now() + 1;
    this.host.broadcast(this.matchMessage());
  }

  roster(): RosterEntry[] {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, ping: Math.round(this.host.ping(p.id)),
    }));
  }

  private broadcastRoster(): void {
    this.nextRoster = this.host.now() + 3;
    this.host.broadcast({ t: 'roster', players: this.roster() });
  }
}

function newSlot(id: string): Slot {
  const def = weaponDef(id) ?? weaponDef(DEFAULT_PRIMARY)!;
  return { def, mag: def.magazine, nextFireAt: 0, reloadDoneAt: 0 };
}

function isSlot(v: unknown): v is 0 | 1 | 2 {
  return v === 0 || v === 1 || v === 2;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

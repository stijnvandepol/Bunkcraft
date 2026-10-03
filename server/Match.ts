import { type ArenaMap, DEFAULT_MAP, type Spawn, getMap, mapFor, parseMapId } from '../src/modes/maps';
import { type GameTypeDef, type Team, gameTypeDef } from '../src/modes/GameTypes';
import {
  DEFAULT_PRIMARY, DEFAULT_SECONDARY, PLAYER_MAX_HEALTH, PRIMARY_WEAPONS, REGEN_DELAY, REGEN_PER_SECOND, SECONDARY_WEAPONS,
  type WeaponDef, damageAt, fireInterval, weaponDef,
} from '../src/modes/Weapons';
import type {
  ClientMessage, MatchInfo, MatchPhase, ModeEventKind, RosterEntry, ServerMessage,
} from '../src/net/protocol';
import { type BlockQuery, rayPlayer, spreadDirection, traceBlocks } from './Combat';
import { type MatchResult, type ModeLogic } from './modes/ModeLogic';
import { createLogic } from './modes';

/** Seconds of warm-up once at least two players are in the game. */
export const WARMUP_SECONDS = 10;
/** The result stays on screen this long before the next match. */
export const ENDED_SECONDS = 12;
export const SPAWN_PROTECTION = 2;
export const SWITCH_DELAY = 0.25;
export const EYE_HEIGHT = 1.62;
/** A client-reported shot origin further than this from the server's eye is replaced by the server's. */
export const MAX_ORIGIN_DRIFT = 1.6;
/** Lag compensation: history kept per player, and the furthest we rewind. */
export const HISTORY_SECONDS = 1;
export const MAX_REWIND = 0.35;
export const DEFAULT_REWIND = 0.1;
/** Fire messages may arrive this much (s) earlier than the weapon's cadence allows (network jitter). */
const FIRE_SLACK = 0.04;
const HISTORY_SIZE = 24;
/** The mode state (zones, flags) is re-sent at least this often. */
const MODE_INTERVAL = 0.25;

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
  /**
   * A new match is about to start on `current`: returns the map to play next (the host swaps its
   * bullet world), or null to keep the map. `requires` is the map data the game type needs.
   */
  nextMap?(current: string, requires?: readonly ('zones' | 'flags')[]): string | null;
}

interface Slot {
  def: WeaponDef;
  mag: number;
  nextFireAt: number;
  /** 0 when not reloading. */
  reloadDoneAt: number;
  /** Burst weapons: shots fired in the current burst and when it started. */
  burstShots: number;
  burstStart: number;
}

interface Sample { t: number; x: number; y: number; z: number }

export interface MatchPlayer {
  id: number;
  name: string;
  team: Team | '';
  kills: number;
  deaths: number;
  /** Objective score of the mode (gun game level, flag captures). */
  pts: number;
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
  /** Weapons of this life and the ones chosen for the next. */
  primary: string;
  nextPrimary: string;
  secondary: string;
  nextSecondary: string;
  slots: [Slot, Slot, Slot];
  slot: 0 | 1 | 2;
  switchReadyAt: number;
  history: Sample[];
  historyHead: number;
  historyCount: number;
}

const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/**
 * One arcade match: teams, phases, scores, spawns, health, weapons and the server-authoritative
 * hitscan. The rules of the game type (what scores, rounds, objectives, when it ends) live in a
 * `ModeLogic` (server/modes/*), chosen by the type's `GameTypeDef`. Knows nothing about sockets:
 * everything goes through the MatchHost, which makes it testable with a fake clock.
 */
export class Match {
  phase: MatchPhase = 'warmup';
  readonly players = new Map<number, MatchPlayer>();
  /** Team points: kills (tdm), round wins (elimination), points (hardpoint), captures (ctf). Zero without teams. */
  readonly scores = { red: 0, blue: 0 };
  readonly def: GameTypeDef;
  readonly logic: ModeLogic;
  private warmupEnd = 0;
  /** When the current phase (not warm-up) ends; Infinity = never. */
  private phaseEnd = Infinity;
  private lastTick = 0;
  private nextMatchMsg = 0;
  private nextRoster = 0;
  private nextModeMsg = 0;
  private readonly sentScores = { red: 0, blue: 0 };
  private modeDirty = false;
  private joinCounter = 0;
  /** Player who changes team at their next respawn because the other team lost players (0 = nobody). */
  private moveId = 0;
  private readonly tmpDir: [number, number, number] = [0, 0, 0];
  private readonly tmpPos: [number, number, number] = [0, 0, 0];

  /** The arena this match is played on. */
  map: ArenaMap;

  constructor(private readonly host: MatchHost, readonly info: MatchInfo) {
    this.lastTick = host.now();
    this.def = gameTypeDef(info.type);
    this.logic = createLogic(this.def);
    this.map = getMap(mapFor(parseMapId(info.map) ?? DEFAULT_MAP, this.def.requires));
    info.map = this.map.id;
  }

  setMap(id: string): void {
    this.map = getMap(id);
    this.info.map = this.map.id;
  }

  get teams(): boolean {
    return this.def.teams;
  }

  teamScore(team: Team): number {
    return this.scores[team];
  }

  now(): number {
    return this.host.now();
  }

  random(): number {
    return this.host.random();
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
      id, name, team, kills: 0, deaths: 0, pts: 0, joinSeq: ++this.joinCounter, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, health: PLAYER_MAX_HEALTH,
      lastDamageAt: -1e9, lastHpSent: PLAYER_MAX_HEALTH, respawnAt: 0, protectedUntil: 0,
      primary: DEFAULT_PRIMARY, nextPrimary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY, nextSecondary: DEFAULT_SECONDARY,
      slots: [newSlot(DEFAULT_PRIMARY), newSlot(DEFAULT_SECONDARY), newSlot('knife')], slot: 0,
      switchReadyAt: 0, history: Array.from({ length: HISTORY_SIZE }, () => ({ t: 0, x: 0, y: 0, z: 0 })), historyHead: 0, historyCount: 0,
    };
    this.players.set(id, p);
    this.resetLife(p, now);
    this.logic.onJoin?.(this, p, now);
    return p;
  }

  /** The player's connection is up: tell them and everyone else. */
  ready(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    if (p.alive) this.sendSpawn(p);
    else this.host.send(id, { t: 'hp', health: 0 }); // joined between lives of a round: spectate until the next one
    this.host.send(id, this.matchMessage());
    this.sendMode(id);
    for (const o of this.players.values()) {
      if (o.id !== id) this.host.send(id, { t: 'holds', id: o.id, weapon: o.slots[o.slot].def.id });
    }
    this.host.broadcast({ t: 'holds', id, weapon: p.slots[p.slot].def.id });
    this.broadcastRoster();
  }

  leave(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.logic.onLeave?.(this, p, this.host.now());
    if (this.teams) this.planBalance();
    this.broadcastRoster();
    if (this.players.size === 0) this.reset();
  }

  /** Fresh match with nobody in it (the room emptied). */
  reset(): void {
    this.phase = 'warmup';
    this.warmupEnd = 0;
    this.phaseEnd = Infinity;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.pts = 0; }
    this.logic.onReset?.(this);
  }

  setPosition(id: number, x: number, y: number, z: number, yaw = 0, pitch = 0): void {
    const p = this.players.get(id);
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.pitch = pitch;
  }

  /** The weapons for the next life: a primary and optionally a secondary (unknown ids are ignored). */
  setLoadout(id: number, primary: string, secondary?: string): void {
    const p = this.players.get(id);
    if (!p) return;
    if (PRIMARY_WEAPONS.includes(primary)) p.nextPrimary = primary;
    if (secondary !== undefined && SECONDARY_WEAPONS.includes(secondary)) p.nextSecondary = secondary;
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

  /**
   * Changes the weapons of a living player on the spot (gun game level up): new slots with full
   * magazines, the primary slot in hand, and the player and everyone else are told.
   */
  giveGear(p: MatchPlayer, primary: string, secondary?: string, melee?: string): void {
    p.primary = primary;
    if (secondary) p.secondary = secondary;
    p.slots = [newSlot(primary), newSlot(secondary ?? p.secondary), newSlot(melee ?? 'knife')];
    p.slot = 0;
    p.switchReadyAt = this.host.now() + SWITCH_DELAY;
    this.host.send(p.id, { t: 'gear', primary, secondary: p.secondary });
    for (let i = 0; i < 3; i++) this.host.send(p.id, { t: 'ammo', slot: i as 0 | 1 | 2, mag: p.slots[i].mag, reloading: false });
    this.host.broadcast({ t: 'holds', id: p.id, weapon: primary }, p.id);
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
    const shotAt = Math.max(s.nextFireAt, now - FIRE_SLACK);
    if (w.burst && w.burstCycleSec) {
      // Burst weapons: `burst` shots `fireInterval` apart, then the cycle time from the first shot.
      if (s.burstShots === 0 || shotAt - s.burstStart > w.burstCycleSec) { s.burstShots = 1; s.burstStart = shotAt; } else s.burstShots++;
      if (s.burstShots >= w.burst) {
        s.nextFireAt = Math.max(shotAt + fireInterval(w), s.burstStart + w.burstCycleSec);
        s.burstShots = 0;
      } else s.nextFireAt = shotAt + fireInterval(w);
    } else s.nextFireAt = shotAt + fireInterval(w);
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
    const ping = this.host.ping(id);
    const rewind = Math.min(MAX_REWIND, ping > 0 ? ping / 1000 + DEFAULT_REWIND : DEFAULT_REWIND);
    const at = now - rewind;
    const damaging = this.phase === 'live';

    const dealt = new Map<number, { damage: number; head: boolean }>();
    let tracer: [number, number, number] | null = null;
    const dir = this.tmpDir, pos = this.tmpPos;
    for (let k = 0; k < w.pellets; k++) {
      spreadDirection(dx, dy, dz, spread, this.host.random(), this.host.random(), dir);
      let tEnd = traceBlocks(this.host.blocks, ox, oy, oz, dir[0], dir[1], dir[2], w.maxRange);
      let victim: MatchPlayer | null = null;
      let hitHead = false;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        if (this.teams && o.team === p.team) continue; // no friendly fire
        this.positionAt(o, at, now, pos);
        const hit = rayPlayer(ox, oy, oz, dir[0], dir[1], dir[2], pos[0], pos[1], pos[2]);
        if (hit && hit.t < tEnd) { tEnd = hit.t; victim = o; hitHead = hit.head; }
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
    this.kill(killer, victim, w, head, now);
  }

  /** Takes a life: counters, respawn timer, kill feed, then the mode decides what it is worth. */
  private kill(killer: MatchPlayer | null, victim: MatchPlayer, w: WeaponDef, head: boolean, now: number): void {
    victim.alive = false;
    victim.deaths++;
    const delay = this.logic.respawnDelay(this, victim);
    victim.respawnAt = delay < 0 ? Infinity : now + delay;
    victim.historyCount = 0;
    if (killer) killer.kills++;
    this.logic.onKill(this, killer, victim, w, head, now);
    this.sendHp(victim, true);
    this.host.broadcast({ t: 'kill', killer: killer?.id ?? 0, victim: victim.id, weapon: w.id, head });
    this.broadcastRoster();
    this.broadcastMatch();
    this.checkEnd(now);
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
      if (!this.logic.canStart(this)) this.warmupEnd = 0;
      else if (this.warmupEnd === 0) { this.warmupEnd = now + WARMUP_SECONDS; this.broadcastMatch(); }
      else if (now >= this.warmupEnd) this.beginMatch(now);
    } else if (now >= this.phaseEnd) {
      if (this.phase === 'ended') this.restart(now);
      else this.logic.onPhaseEnd(this, this.phase, now);
    }
    if (this.phase !== 'warmup' && this.phase !== 'ended') {
      this.logic.onTick?.(this, dt, now);
      this.checkEnd(now);
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

    // Objective points (zones, captures) show up at once, not only with the once-a-second update.
    if (now >= this.nextMatchMsg || this.scores.red !== this.sentScores.red || this.scores.blue !== this.sentScores.blue) this.broadcastMatch();
    if (now >= this.nextRoster) this.broadcastRoster();
    if (this.modeDirty || now >= this.nextModeMsg) this.broadcastMode();
  }

  /** Warm-up is over: zero everything and hand over to the mode. */
  private beginMatch(now: number): void {
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.pts = 0; }
    this.logic.onStart(this, now);
    this.broadcastMatch();
    this.broadcastRoster();
  }

  /** Enters a phase that lasts `seconds` (0 or less = until the mode ends it) and tells everybody. */
  setPhase(phase: MatchPhase, seconds: number): void {
    this.phase = phase;
    this.phaseEnd = seconds > 0 ? this.host.now() + seconds : Infinity;
    this.modeDirty = true;
    this.broadcastMatch();
  }

  /** The plain "go": everybody respawns and the clock of the match (the time limit) starts. */
  startLive(): void {
    this.respawnAll(this.host.now());
    this.setPhase('live', this.info.timeLimitSec);
    this.broadcastRoster();
  }

  private checkEnd(now: number): void {
    if (this.phase !== 'live') return;
    const result = this.logic.checkEnd(this);
    if (result) this.endMatch(now, result);
  }

  /** Ends the match: the given result, or the mode's winner by the current standings. */
  endMatch(now: number = this.host.now(), result?: MatchResult): void {
    if (this.phase === 'ended') return;
    const r = result ?? this.logic.winner(this);
    this.phase = 'ended';
    this.phaseEnd = now + ENDED_SECONDS;
    this.host.broadcast({ t: 'matchend', winnerTeam: r.winnerTeam, winnerId: r.winnerId, restartIn: ENDED_SECONDS });
    this.broadcastMatch();
    this.broadcastRoster();
    this.broadcastMode();
  }

  /** Next match: scores reset, teams rebalanced, everyone respawns into a new warm-up. */
  private restart(now: number): void {
    const next = this.host.nextMap?.(this.map.id, this.def.requires);
    if (next && next !== this.map.id) this.setMap(next);
    this.phase = 'warmup';
    this.warmupEnd = 0;
    this.phaseEnd = Infinity;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.pts = 0; }
    this.logic.onReset?.(this);
    if (this.teams) this.rebalance();
    this.respawnAll(now);
    this.broadcastMatch();
    this.broadcastRoster();
    this.broadcastMode();
  }

  /** Back to the warm-up (the mode cannot go on, for example one team is empty). */
  returnToWarmup(): void {
    this.phase = 'warmup';
    this.warmupEnd = 0;
    this.phaseEnd = Infinity;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.pts = 0; }
    this.logic.onReset?.(this);
    this.respawnAll(this.host.now());
    this.broadcastMatch();
    this.broadcastRoster();
    this.broadcastMode();
  }

  /** Number of players on a team. */
  teamSize(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  /** Number of living players on a team. */
  aliveCount(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team && p.alive) n++;
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
    this.say(`${p.name} moved to the ${p.team} team to even the teams`);
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

  respawnAll(now: number): void {
    for (const p of this.players.values()) this.respawn(p, now);
  }

  respawn(p: MatchPlayer, now: number): void {
    if (this.teams) this.applyBalance(p);
    this.resetLife(p, now);
    this.sendSpawn(p);
    this.host.broadcast({ t: 'holds', id: p.id, weapon: p.slots[0].def.id }, p.id);
  }

  /** Full health, full magazines, the chosen (or the mode's) weapons, a fresh spawn point and brief protection. */
  private resetLife(p: MatchPlayer, now: number): void {
    p.alive = true;
    p.health = PLAYER_MAX_HEALTH;
    p.lastHpSent = PLAYER_MAX_HEALTH;
    p.lastDamageAt = -1e9;
    p.protectedUntil = now + (this.def.respawn?.protectionSec ?? SPAWN_PROTECTION);
    const kit = this.logic.loadoutFor?.(this, p) ?? { primary: p.nextPrimary, secondary: p.nextSecondary };
    p.primary = kit.primary;
    p.secondary = kit.secondary ?? DEFAULT_SECONDARY;
    p.slots = [newSlot(p.primary), newSlot(p.secondary), newSlot(kit.melee ?? 'knife')];
    p.slot = 0;
    p.switchReadyAt = 0;
    const s = this.logic.pickSpawn?.(this, p) ?? this.pickSpawn(p);
    p.x = s.x; p.y = s.y; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    p.historyCount = 0;
    p.respawnAt = 0;
    this.logic.onSpawn?.(this, p, now);
  }

  private sendSpawn(p: MatchPlayer): void {
    this.host.moveTo(p.id, p.x, p.y, p.z);
    this.host.send(p.id, { t: 'spawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team, primary: p.primary, secondary: p.secondary, health: p.health });
    for (let i = 0; i < 3; i++) this.host.send(p.id, { t: 'ammo', slot: i as 0 | 1 | 2, mag: p.slots[i].mag, reloading: false });
  }

  /**
   * The team's spawn (team modes) or any spawn (ffa) that is furthest from the living opponents, with a
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
    return Number.isFinite(this.phaseEnd) ? Math.max(0, Math.ceil(this.phaseEnd - now)) : 0;
  }

  private matchMessage(): ServerMessage {
    return {
      t: 'match', phase: this.phase, timeLeft: this.timeLeft(),
      scores: this.teams ? { red: this.scores.red, blue: this.scores.blue } : { red: 0, blue: 0 }, info: this.info,
      text: this.logic.scoreText(this),
    };
  }

  private broadcastMatch(): void {
    this.nextMatchMsg = this.host.now() + 1;
    this.sentScores.red = this.scores.red;
    this.sentScores.blue = this.scores.blue;
    this.host.broadcast(this.matchMessage());
  }

  /** The mode's HUD state to everybody (zones, flags, rounds); nothing for plain deathmatch. */
  private broadcastMode(): void {
    this.nextModeMsg = this.host.now() + MODE_INTERVAL;
    this.modeDirty = false;
    const state = this.logic.modeState?.(this);
    if (state) this.host.broadcast({ t: 'mode', state });
  }

  private sendMode(id: number): void {
    const state = this.logic.modeState?.(this);
    if (state) this.host.send(id, { t: 'mode', state });
  }

  /** Marks the mode state as changed: it goes out at the end of this tick. */
  markModeDirty(): void {
    this.modeDirty = true;
  }

  /** A one-off happening for the clients (banner and sound). */
  event(kind: ModeEventKind, team: Team | '' = '', id = 0, text = ''): void {
    this.host.broadcast({ t: 'event', kind, ...(team ? { team } : {}), ...(id ? { id } : {}), ...(text ? { text } : {}) });
  }

  /** A system line in the chat. */
  say(text: string): void {
    this.host.broadcast({ t: 'chat', from: '', text, system: true });
  }

  roster(): RosterEntry[] {
    const withPts = !!this.def.scoreColumn;
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, ping: Math.round(this.host.ping(p.id)),
      ...(withPts ? { pts: p.pts } : {}),
    }));
  }

  broadcastRoster(): void {
    this.nextRoster = this.host.now() + 3;
    this.host.broadcast({ t: 'roster', players: this.roster() });
  }
}

function newSlot(id: string): Slot {
  const def = weaponDef(id) ?? weaponDef(DEFAULT_PRIMARY)!;
  return { def, mag: def.magazine, nextFireAt: 0, reloadDoneAt: 0, burstShots: 0, burstStart: 0 };
}

function isSlot(v: unknown): v is 0 | 1 | 2 {
  return v === 0 || v === 1 || v === 2;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

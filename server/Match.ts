import { type ArenaMap, DEFAULT_MAP, type Spawn, getMap, mapFor, parseMapId } from '../src/modes/maps';
import { type GameTypeDef, type MapFeature, type Team, gameTypeDef } from '../src/modes/GameTypes';
import {
  DEFAULT_PRIMARY, DEFAULT_SECONDARY, type OpticId, PLAYER_MAX_HEALTH, type PerkId, REGEN_DELAY, REGEN_PER_SECOND,
  HITBOX, type WeaponDef, damageAt, fireInterval, magazineFor, opticFor, rangeMulFor, reloadTimeFor, switchDelayFor, weaponDef,
} from '../src/modes/Weapons';
import { CLASS_SWAP_WINDOW, type ClassSpec, DEFAULT_CLASS, calmPhase, validateClass } from '../src/modes/Loadouts';
import type {
  ClientMessage, MatchInfo, MatchPhase, ModeEventKind, RosterEntry, ServerMessage,
} from '../src/net/protocol';
import { type BlockQuery, createBulletTrace, rayPlayer, shotRandom, shotSpread, spreadDirection, traceBullet } from './Combat';
import { PEEK_LIMIT, bodyVisible, rewindLimit, rewindWindow } from './anticheat/LagComp';
import { type MatchResult, type ModeLogic } from './modes/ModeLogic';
import { createLogic } from './modes';

/** Seconds of warm-up once at least two players are in the game. */
export const WARMUP_SECONDS = 10;
/** The result stays on screen this long before the next match. */
export const ENDED_SECONDS = 12;
/** Extra seconds between matches when the players vote on the next map (rotating lobbies). */
export const VOTE_SECONDS = 10;
/** Maps offered in the vote. */
export const VOTE_OPTIONS = 3;
export const SPAWN_PROTECTION = 2;
export const SWITCH_DELAY = 0.25;
/** A class picked this soon after spawning (and before the first shot) applies at once instead of next life. */
export { CLASS_SWAP_WINDOW };
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
/**
 * A shot this close before the reload ends finishes the reload. The client ends its reload animation on its own clock,
 * which started when it asked (half a round trip before the server); its next shot travels the same half trip, so it
 * arrives about when the server's reload is done. The slack covers the jitter, so no shot is lost after the animation.
 */
const RELOAD_SLACK = 0.1;
const HISTORY_SIZE = 24;
/** Server ticks whose time is remembered, so a shot's render tick (`rk`) maps back to a moment. */
const TICK_RING = 64;
/** Killstreak: every this many kills in one life sends a radar sweep, shown this long. */
export const RADAR_STREAK = 5;
export const RADAR_SECONDS = 4;
/** Spawn choice: shots remembered, how long and how near they count, and the distance beyond which a spawn is safe. */
const FIGHT_MEMORY = 32;
export const SPAWN_FIGHT_SECONDS = 3;
export const SPAWN_FIGHT_RADIUS = 14;
/** An opponent this close that can see a spawn makes it a bad one. */
export const SPAWN_SIGHT_RANGE = 35;
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
  /** Seconds the clients draw other players in the past (2 snapshot intervals); default 0.1. */
  interpDelay?: number;
  /** Every resolved shot, for the anti-cheat statistics (see anticheat/Suspicion.ts). */
  onShot?(shot: ShotReport): void;
  /** QA: report the tested target positions with every shot (ARCADE_SHOT_DEBUG=1). */
  debugShots?: boolean;
  /**
   * A new match is about to start on `current`: returns the map to play next (the host swaps its
   * bullet world), or null to keep the map. `requires` is the map data the game type needs.
   */
  nextMap?(current: string, requires?: readonly MapFeature[], preferred?: string): string | null;
  /**
   * The match ended: the maps the players may vote on for the next one (the first is the rotation's own pick,
   * which wins a tie), or null when this game does not vote (a fixed map).
   */
  voteMaps?(current: string, requires?: readonly MapFeature[]): string[] | null;
  /** Progression hooks (server/progression/MatchRecorder.ts): all optional, called only while it matters. */
  /** Warm-up is over and the match goes live. */
  onMatchStart?(): void;
  /** `attacker` hurt `victim` (live phase only). */
  onDamage?(attacker: number, victim: number, amount: number, weapon: string, head: boolean): void;
  /** `victim` died; `killer` is 0 for deaths without one. */
  onKill?(killer: number, victim: number, weapon: string, head: boolean): void;
  /** A player did an objective (flag captured or returned, zone captured, `amount` seconds in a hill). */
  onObjective?(id: number, kind: 'flag-captured' | 'flag-returned' | 'zone-captured' | 'hill', amount: number): void;
  /** The match ended with this result (after the `matchend` message went out). */
  onMatchEnd?(result: MatchResult): void;
}

export interface ShotReport {
  shooter: number;
  weapon: string;
  /** Normalised aim direction and origin as used by the server. */
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  /** Players hit by this shot (any pellet), with the distance and whether a pellet hit the head. */
  hits: { victim: number; dist: number; head: boolean }[];
  /** Seconds the targets were rewound for this shot. */
  rewind: number;
  /** The client's shot counter and claimed render tick (−1 when absent), the server tick, and where each target was tested. */
  seq: number;
  rk: number;
  tick: number;
  targets: number[][];
}

interface Slot {
  def: WeaponDef;
  mag: number;
  /** Magazine size of this slot (the perk may enlarge it). */
  cap: number;
  /** Falloff distance multiplier (suppressor). */
  rangeMul: number;
  nextFireAt: number;
  /** 0 when not reloading. */
  reloadDoneAt: number;
  /** Burst weapons: shots fired in the current burst and when it started. */
  burstShots: number;
  burstStart: number;
}

/** A lag compensation sample: position, view and hitbox height (the pose) at time t. */
interface Sample { t: number; x: number; y: number; z: number; yaw: number; pitch: number; h: number }

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
  /** A server-side bot (server/bots): marked in the roster, otherwise a player like any other. */
  bot?: boolean;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  /** Hitbox height of the current pose (standing, crouching, sliding), as the connection layer accepted it. */
  height: number;
  alive: boolean;
  health: number;
  lastDamageAt: number;
  lastHpSent: number;
  respawnAt: number;
  protectedUntil: number;
  /** Weapons of this life (primary with its optic, secondary, perk) and the class chosen for the next. */
  primary: string;
  secondary: string;
  optic: OpticId;
  perk: PerkId;
  next: ClassSpec;
  /** When this life began and whether a shot went out in it (early class swap). */
  spawnedAt: number;
  firedThisLife: boolean;
  /** Kills since the last death (killstreak rewards). */
  streak: number;
  slots: [Slot, Slot, Slot];
  slot: 0 | 1 | 2;
  /** Realms rank for the roster (prestige * 100 + level, see progression/Levels.ts); 0 or absent = none. */
  rank?: number;
  switchReadyAt: number;
  history: Sample[];
  historyHead: number;
  historyCount: number;
  /** Spread seed (dealt at the join, sent with every spawn) and the index of the next shot: the client derives the same spread. */
  spreadSeed: number;
  shotN: number;
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
  private readonly tmpPos: Sample = { t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, h: HITBOX.height };
  private readonly tmpRand: [number, number] = [0, 0];
  private readonly trace = createBulletTrace();
  private readonly targets: { o: MatchPlayer; x: number; y: number; z: number; yaw: number; pitch: number; h: number }[] = [];
  /** Server tick counter (snapshots carry it as `k`) and the time of the last TICK_RING ticks. */
  tickNo = 0;
  private readonly tickTimes = new Float64Array(TICK_RING);
  /** Recent shots (where and when), for the spawn choice. */
  private readonly fightX = new Float64Array(FIGHT_MEMORY);
  private readonly fightZ = new Float64Array(FIGHT_MEMORY);
  private readonly fightT = new Float64Array(FIGHT_MEMORY).fill(-1e9);
  private fightHead = 0;

  /** The arena this match is played on. */
  map: ArenaMap;
  /** Map vote between two matches: the offered maps and each voter's choice (index); null when there is none. */
  vote: { options: string[]; votes: Map<number, number> } | null = null;

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
  join(id: number, name: string, bot = false): MatchPlayer {
    const now = this.host.now();
    let team: Team | '' = this.teams ? this.logic.teamFor?.(this) ?? '' : '';
    if (this.teams && !team) {
      let red = 0, blue = 0;
      for (const p of this.players.values()) if (p.team === 'red') red++; else if (p.team === 'blue') blue++;
      // The smaller team; when they are the same size, the one that is behind on points.
      team = red !== blue ? (red < blue ? 'red' : 'blue') : this.scores.red <= this.scores.blue ? 'red' : 'blue';
    }
    const p: MatchPlayer = {
      id, name, team, kills: 0, deaths: 0, pts: 0, joinSeq: ++this.joinCounter, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, health: PLAYER_MAX_HEALTH,
      lastDamageAt: -1e9, lastHpSent: PLAYER_MAX_HEALTH, respawnAt: 0, protectedUntil: 0,
      primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY, optic: 'iron', perk: 'none', next: { ...DEFAULT_CLASS }, spawnedAt: now, firedThisLife: false, streak: 0,
      slots: [newSlot(DEFAULT_PRIMARY, 'none'), newSlot(DEFAULT_SECONDARY, 'none'), newSlot('knife', 'none')], slot: 0,
      switchReadyAt: 0, history: Array.from({ length: HISTORY_SIZE }, () => ({ t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, h: HITBOX.height })), historyHead: 0, historyCount: 0,
      spreadSeed: Math.floor(this.host.random() * 0x100000000) >>> 0, shotN: 0,
      height: HITBOX.height,
      ...(bot ? { bot: true } : {}),
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
    if (this.vote) this.host.send(id, this.voteMessage(id));
    this.sendMode(id);
    for (const o of this.players.values()) {
      if (o.id !== id) this.host.send(id, this.holds(o));
    }
    this.host.broadcast(this.holds(p));
    this.broadcastRoster();
  }

  leave(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.vote?.votes.delete(id)) this.broadcastVote();
    this.logic.onLeave?.(this, p, this.host.now());
    if (this.teams && !this.logic.keepTeams) this.planBalance();
    this.broadcastRoster();
    if (this.players.size === 0) this.reset();
  }

  /** Fresh match with nobody in it (the room emptied). */
  reset(): void {
    this.phase = 'warmup';
    this.warmupEnd = 0;
    this.phaseEnd = Infinity;
    this.vote = null;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.pts = 0; }
    this.logic.onReset?.(this);
  }

  /** `height`: hitbox height of the pose the connection layer accepted (see GameServer.poseHeight); standing by default. */
  setPosition(id: number, x: number, y: number, z: number, yaw = 0, pitch = 0, height: number = HITBOX.height): void {
    const p = this.players.get(id);
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.pitch = pitch; p.height = height;
  }

  /**
   * The class for the next life (Create-a-Class). Every field is validated: an unknown or disallowed one
   * becomes the default (a missing secondary/optic/perk keeps the current choice, for older clients).
   * Outside a live round, or within CLASS_SWAP_WINDOW seconds of spawning and before the first shot, it applies at once.
   */
  setLoadout(id: number, primary: string, secondary?: string, optic?: string, perk?: string): void {
    const p = this.players.get(id);
    if (!p) return;
    const keepOptic = optic === undefined && primary === p.next.primary;
    p.next = validateClass({
      primary, secondary: secondary ?? p.next.secondary, optic: keepOptic ? p.next.optic : optic, perk: perk ?? p.next.perk,
    });
    const now = this.host.now();
    // Outside a live round nobody fights (warm-up, waiting for players, countdown, between rounds): any
    // change applies at once. In a live round only right after spawning and before the first shot.
    const calm = calmPhase(this.phase);
    const fresh = !p.firedThisLife && now - p.spawnedAt <= CLASS_SWAP_WINDOW;
    if (p.alive && (calm || fresh) && this.phase !== 'ended' && !this.logic.loadoutFor?.(this, p)) {
      this.equip(p, p.next.primary, p.next.secondary, 'knife', p.next.optic, p.next.perk);
      p.switchReadyAt = now + SWITCH_DELAY;
      this.sendGear(p);
    }
  }

  /** What other players see of a player's hands: the weapon, its optic and suppressor, and the Ninja perk. */
  holds(p: MatchPlayer): Extract<ServerMessage, { t: 'holds' }> {
    const w = p.slots[p.slot].def;
    const msg: Extract<ServerMessage, { t: 'holds' }> = { t: 'holds', id: p.id, weapon: w.id };
    if (p.slot === 0 && p.optic !== 'iron') msg.optic = p.optic;
    if (p.perk === 'suppressor' && w.slot !== 'melee') msg.sup = 1;
    if (p.perk === 'ninja') msg.quiet = 1;
    return msg;
  }

  /** New weapon slots (full magazines) for a class; the primary in hand. */
  private equip(p: MatchPlayer, primary: string, secondary: string, melee: string, optic: string | undefined, perk: PerkId): void {
    p.primary = primary;
    p.secondary = secondary;
    p.optic = opticFor(weaponDef(primary) ?? weaponDef(DEFAULT_PRIMARY)!, optic);
    p.perk = perk;
    p.slots = [newSlot(primary, perk), newSlot(secondary, perk), newSlot(melee, perk)];
    p.slot = 0;
  }

  /** Tells the player and everyone else about new gear mid-life. */
  private sendGear(p: MatchPlayer): void {
    this.host.send(p.id, { t: 'gear', primary: p.primary, secondary: p.secondary, optic: p.optic, perk: p.perk });
    for (let i = 0; i < 3; i++) this.host.send(p.id, { t: 'ammo', slot: i as 0 | 1 | 2, mag: p.slots[i].mag, reloading: false });
    this.host.broadcast(this.holds(p), p.id);
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
    p.switchReadyAt = now + switchDelayFor(p.perk, SWITCH_DELAY);
    this.host.broadcast(this.holds(p));
  }

  reload(id: number, slot: number): void {
    const p = this.players.get(id);
    if (!p || !p.alive || !isSlot(slot)) return;
    if (slot !== p.slot) return;
    this.startReload(p, this.host.now());
  }

  /** A reload is done: full magazine, and the client is told. */
  private finishReload(p: MatchPlayer, slot: number): void {
    const s = p.slots[slot];
    s.reloadDoneAt = 0;
    s.mag = s.cap;
    this.host.send(p.id, { t: 'ammo', slot: slot as 0 | 1 | 2, mag: s.mag, reloading: false });
  }

  private startReload(p: MatchPlayer, now: number): void {
    const s = p.slots[p.slot];
    if (s.cap <= 0 || s.mag >= s.cap || s.reloadDoneAt > 0 || now < p.switchReadyAt) return;
    s.reloadDoneAt = now + reloadTimeFor(s.def, s.mag);
    this.host.send(p.id, { t: 'ammo', slot: p.slot, mag: s.mag, reloading: true });
  }

  /**
   * Changes the weapons of a living player on the spot (gun game level up): new slots with full
   * magazines, the primary slot in hand, and the player and everyone else are told.
   */
  giveGear(p: MatchPlayer, primary: string, secondary?: string, melee?: string): void {
    // Mode gear (gun game): the weapon's default optic and no perk.
    this.equip(p, primary, secondary ?? p.secondary, melee ?? 'knife', undefined, 'none');
    p.switchReadyAt = this.host.now() + SWITCH_DELAY;
    this.sendGear(p);
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
    if (s.reloadDoneAt > 0 && now >= s.reloadDoneAt - RELOAD_SLACK) this.finishReload(p, p.slot);
    if (now < p.switchReadyAt || s.reloadDoneAt > 0) return false;
    if (now < s.nextFireAt - FIRE_SLACK) return false;
    if (s.cap > 0 && s.mag <= 0) {
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
    p.firedThisLife = true;
    // Spread: the next index of this player's seeded sequence (the client predicts the same one and is corrected by `ammo`).
    const n = p.shotN++;
    const seq = seqOf(m);
    // Spawn protection ends with the first shot (no shooting from behind a shield).
    if (p.protectedUntil > now) p.protectedUntil = now;
    this.noteFight(p.x, p.z, now);
    if (s.cap > 0) {
      s.mag--;
      this.host.send(id, { t: 'ammo', slot: p.slot, mag: s.mag, reloading: false, sn: p.shotN, ...(seq >= 0 ? { seq } : {}) });
    }

    const ex = p.x, ey = p.y + EYE_HEIGHT, ez = p.z;
    const trusted = Math.hypot(m.ox - ex, m.oy - ey, m.oz - ez) <= MAX_ORIGIN_DRIFT;
    const ox = trusted ? m.ox : ex, oy = trusted ? m.oy : ey, oz = trusted ? m.oz : ez;
    const dx = m.dx / len, dy = m.dy / len, dz = m.dz / len;
    const spread = shotSpread(w, m.ads === true, m.mv === true, m.air === true);

    // Lag compensation: targets are tested where this shooter saw them. The client says which server tick its
    // screen showed (`rk`); without it (older clients) the round trip plus the interpolation delay estimates it.
    const ping = this.host.ping(id);
    const interp = this.host.interpDelay ?? 0.1;
    const shown = typeof m.rk === 'number' ? this.tickTime(m.rk, now) : NaN;
    const at = Number.isFinite(shown) ? Math.min(now, Math.max(now - rewindLimit(ping, interp), shown)) : now - rewindWindow(ping, interp);
    const rewind = now - at;
    const damaging = this.phase === 'live';
    // Where each target is tested. Peeker's advantage limit: a target that was already behind cover
    // PEEK_LIMIT seconds ago (as seen from this shot's origin) is not rewound further back into the open.
    const targets = this.targets;
    targets.length = 0;
    const pos = this.tmpPos;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      if (this.teams && o.team === p.team) continue; // no friendly fire
      this.positionAt(o, at, now, pos);
      if (rewind > PEEK_LIMIT) {
        const x = pos.x, y = pos.y, z = pos.z, yaw = pos.yaw, pitch = pos.pitch, h = pos.h;
        this.positionAt(o, now - PEEK_LIMIT, now, pos);
        if (bodyVisible(this.host.blocks, ox, oy, oz, pos.x, pos.y, pos.z, pos.h)) { pos.x = x; pos.y = y; pos.z = z; pos.yaw = yaw; pos.pitch = pitch; pos.h = h; }
      }
      targets.push({ o, x: pos.x, y: pos.y, z: pos.z, yaw: pos.yaw, pitch: pos.pitch, h: pos.h });
    }

    const dealt = new Map<number, { damage: number; head: boolean }>();
    let tracer: [number, number, number] | null = null;
    const dir = this.tmpDir;
    const rand = this.tmpRand;
    const trace = this.trace;
    const hitList: ShotReport['hits'] = [];
    for (let k = 0; k < w.pellets; k++) {
      shotRandom(p.spreadSeed, n, k, w.pellets, rand);
      spreadDirection(dx, dy, dz, spread, rand[0], rand[1], dir);
      traceBullet(this.host.blocks, ox, oy, oz, dir[0], dir[1], dir[2], w.maxRange, trace);
      let tEnd = trace.t;
      let victim: MatchPlayer | null = null;
      let hitHead = false;
      for (const t of targets) {
        const hit = rayPlayer(ox, oy, oz, dir[0], dir[1], dir[2], t.x, t.y, t.z, t.yaw, t.pitch, t.h / HITBOX.height);
        if (hit && hit.t < tEnd) { tEnd = hit.t; victim = t.o; hitHead = hit.part === 'head'; }
      }
      if (victim) {
        const prevHit = hitList.find((h) => h.victim === victim!.id);
        if (prevHit) prevHit.head ||= hitHead; else hitList.push({ victim: victim.id, dist: tEnd, head: hitHead });
      }
      if (!tracer) tracer = [ox + dir[0] * tEnd, oy + dir[1] * tEnd, oz + dir[2] * tEnd];
      if (victim && damaging && now >= victim.protectedUntil) {
        // See-through blocks (a window, a hedge) on the way to the victim cost damage.
        let keep = 1;
        for (let i = 0; i < trace.thin; i++) if (trace.thinT[i] < tEnd) keep *= trace.thinMul[i];
        const dmg = damageAt(w, tEnd, s.rangeMul) * (hitHead ? w.headshot : 1) * keep * (this.logic.damageMul?.(this, p, victim, w) ?? 1);
        const prev = dealt.get(victim.id);
        if (prev) { prev.damage += dmg; prev.head ||= hitHead; } else dealt.set(victim.id, { damage: dmg, head: hitHead });
      }
    }
    if (w.slot !== 'melee') {
      const [tx, ty, tz] = tracer!;
      const shot: Extract<ServerMessage, { t: 'shot' }> = { t: 'shot', id, weapon: w.id, ox: r2(ox), oy: r2(oy), oz: r2(oz), ex: r2(tx), ey: r2(ty), ez: r2(tz) };
      if (p.perk === 'suppressor') shot.sup = 1;
      this.host.broadcast(shot);
    }
    for (const [vid, d] of dealt) this.applyDamage(p, this.players.get(vid)!, Math.max(1, Math.round(d.damage)), w, d.head, now, seq);
    this.host.onShot?.({
      shooter: id, weapon: w.id, ox, oy, oz, dx, dy, dz, hits: hitList, rewind, seq, rk: typeof m.rk === 'number' ? m.rk : -1, tick: this.tickNo,
      targets: this.host.debugShots ? targets.map((t) => [t.o.id, r2(t.x), r2(t.y), r2(t.z), r2(t.yaw), r2(t.pitch)]) : [],
    });
    return true;
  }

  /** The server time of a (fractional) tick number from a client's `rk`; NaN when it is not a recent tick. */
  tickTime(rk: number, now: number): number {
    if (!Number.isFinite(rk) || this.tickNo === 0) return NaN;
    const k0 = Math.floor(rk), f = rk - k0;
    if (k0 > this.tickNo || k0 <= this.tickNo - TICK_RING + 1 || k0 < 1) return NaN;
    const t0 = this.tickTimes[k0 % TICK_RING];
    if (k0 === this.tickNo) {
      // Past the newest tick (the client extrapolates a late packet for a moment): one tick interval further.
      const prev = k0 > 1 ? this.tickTimes[(k0 - 1) % TICK_RING] : t0;
      return Math.min(now, t0 + f * Math.max(0, t0 - prev));
    }
    const t1 = this.tickTimes[(k0 + 1) % TICK_RING];
    return t0 + (t1 - t0) * f;
  }

  private applyDamage(killer: MatchPlayer, victim: MatchPlayer, amount: number, w: WeaponDef, head: boolean, now: number, seq = -1): void {
    victim.health = Math.max(0, victim.health - amount);
    victim.lastDamageAt = now;
    const killed = victim.health <= 0;
    this.host.send(killer.id, { t: 'hit', victim: victim.id, damage: amount, head, killed, ...(seq >= 0 ? { seq } : {}) });
    this.host.onDamage?.(killer.id, victim.id, amount, w.id, head);
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
    victim.streak = 0;
    this.logic.onKill(this, killer, victim, w, head, now);
    if (killer && killer !== victim && ++killer.streak % RADAR_STREAK === 0) this.radar(killer);
    this.host.onKill?.(killer?.id ?? 0, victim.id, w.id, head);
    this.sendHp(victim, true);
    this.host.broadcast({ t: 'kill', killer: killer?.id ?? 0, victim: victim.id, weapon: w.id, head });
    this.broadcastRoster();
    this.broadcastMatch();
    this.checkEnd(now);
  }

  /** Killstreak reward: one radar sweep of the opponents' positions for the killer (and its team). */
  private radar(by: MatchPlayer): void {
    const pts: number[] = [];
    for (const o of this.players.values()) {
      if (o === by || !o.alive || (this.teams && o.team === by.team)) continue;
      pts.push(r2(o.x), r2(o.z));
    }
    const msg: ServerMessage = { t: 'radar', by: by.id, pts, sec: RADAR_SECONDS };
    for (const o of this.players.values()) if (o === by || (this.teams && o.team === by.team)) this.host.send(o.id, msg);
  }

  // ---------------------------------------------------------------- lag compensation

  /**
   * Where a player was at time `t` (seconds), where they looked, and the hitbox height then (the taller of the two
   * samples around `t`: a pose change is never in the shooter's disfavour): interpolated between recorded ticks.
   */
  private positionAt(p: MatchPlayer, t: number, now: number, out: Sample): void {
    // Newest sample is the live position at `now`.
    let nx = p.x, ny = p.y, nz = p.z, nyaw = p.yaw, npitch = p.pitch, nh = p.height, nt = now;
    for (let i = 0; i < p.historyCount; i++) {
      const s = p.history[(p.historyHead - 1 - i + HISTORY_SIZE * 2) % HISTORY_SIZE];
      if (s.t <= t) {
        const span = nt - s.t;
        const f = span > 1e-6 ? (t - s.t) / span : 0;
        out.x = s.x + (nx - s.x) * f; out.y = s.y + (ny - s.y) * f; out.z = s.z + (nz - s.z) * f;
        // Shortest way round, like the client's interpolation.
        let dyaw = nyaw - s.yaw;
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        out.yaw = s.yaw + dyaw * f;
        out.pitch = s.pitch + (npitch - s.pitch) * f;
        out.h = Math.max(s.h, nh);
        return;
      }
      nx = s.x; ny = s.y; nz = s.z; nyaw = s.yaw; npitch = s.pitch; nh = s.h; nt = s.t;
    }
    // Older than anything recorded: the oldest known position.
    out.x = nx; out.y = ny; out.z = nz; out.yaw = nyaw; out.pitch = npitch; out.h = nh;
  }

  private record(p: MatchPlayer, now: number): void {
    const s = p.history[p.historyHead];
    s.t = now; s.x = p.x; s.y = p.y; s.z = p.z; s.yaw = p.yaw; s.pitch = p.pitch; s.h = p.height;
    p.historyHead = (p.historyHead + 1) % HISTORY_SIZE;
    if (p.historyCount < HISTORY_SIZE) p.historyCount++;
  }

  // ---------------------------------------------------------------- phases and ticking

  tick(): void {
    const now = this.host.now();
    const dt = Math.min(0.25, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    this.tickNo++;
    this.tickTimes[this.tickNo % TICK_RING] = now;
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
        if (s.reloadDoneAt > 0 && now >= s.reloadDoneAt) this.finishReload(p, i);
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
    this.host.onMatchStart?.();
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
    const options = this.host.voteMaps?.(this.map.id, this.def.requires) ?? null;
    this.vote = options && options.length >= 2 ? { options: options.slice(0, VOTE_OPTIONS), votes: new Map() } : null;
    const pause = ENDED_SECONDS + (this.vote ? VOTE_SECONDS : 0);
    this.phase = 'ended';
    this.phaseEnd = now + pause;
    this.host.broadcast({ t: 'matchend', winnerTeam: r.winnerTeam, winnerId: r.winnerId, restartIn: pause });
    if (this.vote) this.broadcastVote();
    this.broadcastMatch();
    this.broadcastRoster();
    this.broadcastMode();
    this.host.onMatchEnd?.(r);
  }

  /** Next match: scores reset, teams rebalanced, everyone respawns into a new warm-up. */
  private restart(now: number): void {
    const chosen = this.vote ? this.vote.options[tallyVotes(this.vote.options.length, this.vote.votes.values())] : undefined;
    this.vote = null;
    const next = this.host.nextMap?.(this.map.id, this.def.requires, chosen);
    if (next && next !== this.map.id) this.setMap(next);
    this.phase = 'warmup';
    this.warmupEnd = 0;
    this.phaseEnd = Infinity;
    this.scores.red = this.scores.blue = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.pts = 0; }
    this.logic.onReset?.(this);
    if (this.teams && !this.logic.keepTeams) this.rebalance();
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

  /** A player's map vote (index into the offered maps); only between matches. Returns whether it counted. */
  castVote(id: number, choice: number): boolean {
    const v = this.vote;
    if (!v || this.phase !== 'ended' || !this.players.has(id)) return false;
    if (!Number.isInteger(choice) || choice < 0 || choice >= v.options.length) return false;
    if (v.votes.get(id) === choice) return true;
    v.votes.set(id, choice);
    this.broadcastVote();
    return true;
  }

  private voteMessage(id: number): ServerMessage {
    const v = this.vote;
    if (!v) return { t: 'vote', options: [], counts: [], endsIn: 0 };
    const counts = v.options.map(() => 0);
    for (const c of v.votes.values()) counts[c]++;
    const mine = v.votes.get(id);
    return { t: 'vote', options: v.options, counts, endsIn: this.timeLeft(), ...(mine !== undefined ? { mine } : {}) };
  }

  /** Vote state to everyone (each player also learns their own choice). */
  private broadcastVote(): void {
    for (const id of this.players.keys()) this.host.send(id, this.voteMessage(id));
  }

  /** How close the match is to its score limit: the leader's share, 0..1 (quick play avoids nearly finished matches). */
  progress(): number {
    const limit = this.info.scoreLimit;
    if (!(limit > 0)) return 0;
    let top = this.teams ? Math.max(this.scores.red, this.scores.blue) : 0;
    if (!this.teams) for (const p of this.players.values()) top = Math.max(top, this.def.scoreColumn ? p.pts : p.kills);
    return Math.min(1, top / limit);
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
    if (this.teams && !this.logic.keepTeams) this.applyBalance(p);
    this.resetLife(p, now);
    this.sendSpawn(p);
    this.host.broadcast(this.holds(p), p.id);
  }

  /** Full health, full magazines, the chosen (or the mode's) weapons, a fresh spawn point and brief protection. */
  private resetLife(p: MatchPlayer, now: number): void {
    p.alive = true;
    p.health = PLAYER_MAX_HEALTH;
    p.lastHpSent = PLAYER_MAX_HEALTH;
    p.lastDamageAt = -1e9;
    p.protectedUntil = now + (this.def.respawn?.protectionSec ?? SPAWN_PROTECTION);
    const kit = this.logic.loadoutFor?.(this, p);
    if (kit) this.equip(p, kit.primary, kit.secondary ?? DEFAULT_SECONDARY, kit.melee ?? 'knife', undefined, 'none');
    else this.equip(p, p.next.primary, p.next.secondary, 'knife', p.next.optic, p.next.perk);
    p.switchReadyAt = 0;
    p.spawnedAt = now;
    p.firedThisLife = false;
    const s = this.logic.pickSpawn?.(this, p) ?? this.pickSpawn(p);
    p.x = s.x; p.y = s.y; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    p.height = HITBOX.height;
    p.historyCount = 0;
    p.respawnAt = 0;
    this.logic.onSpawn?.(this, p, now);
  }

  private sendSpawn(p: MatchPlayer): void {
    this.host.moveTo(p.id, p.x, p.y, p.z);
    this.host.send(p.id, {
      t: 'spawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team, primary: p.primary, secondary: p.secondary, optic: p.optic, perk: p.perk, health: p.health,
      ss: p.spreadSeed,
    });
    for (let i = 0; i < 3; i++) this.host.send(p.id, { t: 'ammo', slot: i as 0 | 1 | 2, mag: p.slots[i].mag, reloading: false, sn: p.shotN });
  }

  /** A shot was fired here (recent fights: spawns keep away from them). Fixed ring, no allocation. */
  private noteFight(x: number, z: number, now: number): void {
    const i = this.fightHead;
    this.fightX[i] = x; this.fightZ[i] = z; this.fightT[i] = now;
    this.fightHead = (i + 1) % FIGHT_MEMORY;
  }

  /**
   * A spawn away from the fight: the team's spawns (team modes) or all (ffa), scored by
   *  - the distance (blocks) to the nearest living opponent,
   *  - minus 8 when an opponent within SPAWN_SIGHT_RANGE can see it (no spawning into a sight line),
   *  - minus 3 per shot fired nearby in the last SPAWN_FIGHT_SECONDS, up to 3 (no spawning into a fight),
   *  - plus 1 in team modes with a teammate within 25 blocks (spawn with your team),
   * plus up to 2 of randomness so the same point is not used every time. Weights tuned with scripts/flow-metrics.ts
   * (bot matches): stronger sight/fight penalties pick closer hidden spots and get more spawn kills.
   */
  pickSpawn(p: MatchPlayer): Spawn {
    const list: Spawn[] = this.teams && p.team ? this.map.spawns[p.team] : this.map.spawns.ffa;
    const now = this.host.now();
    let best = list[0], bestScore = -Infinity;
    for (const s of list) {
      let nearest = 1000, seen = false, mate = false;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const d = dist2(s.x, s.z, o.x, o.z);
        if (this.teams && o.team === p.team) { if (d < 25) mate = true; continue; }
        nearest = Math.min(nearest, d);
        if (!seen && d < SPAWN_SIGHT_RANGE) seen = bodyVisible(this.host.blocks, o.x, o.y + EYE_HEIGHT, o.z, s.x, s.y, s.z);
      }
      let fights = 0;
      for (let i = 0; i < FIGHT_MEMORY; i++) {
        if (now - this.fightT[i] <= SPAWN_FIGHT_SECONDS && dist2(s.x, s.z, this.fightX[i], this.fightZ[i]) < SPAWN_FIGHT_RADIUS) fights++;
      }
      const score = nearest - (seen ? 8 : 0) - Math.min(3, fights) * 3 + (mate ? 1 : 0) + this.host.random() * 2;
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
    if (id && (kind === 'flag-captured' || kind === 'flag-returned') && this.phase === 'live') this.host.onObjective?.(id, kind, 1);
  }

  /** Objective credit for a player the event does not name (zone capturers, time in a hill); live phase only. */
  creditObjective(p: MatchPlayer, kind: 'zone-captured' | 'hill', amount = 1): void {
    if (this.phase === 'live') this.host.onObjective?.(p.id, kind, amount);
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
      ...(p.bot ? { bot: 1 as const } : {}),
      ...(p.rank ? { rk: p.rank } : {}),
    }));
  }

  broadcastRoster(): void {
    this.nextRoster = this.host.now() + 3;
    this.host.broadcast({ t: 'roster', players: this.roster() });
  }
}

/** The winning option of a map vote: most votes, a tie goes to the lowest index (the rotation's pick). */
export function tallyVotes(options: number, votes: Iterable<number>): number {
  const counts = new Array<number>(Math.max(1, options)).fill(0);
  for (const v of votes) if (v >= 0 && v < counts.length) counts[v]++;
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
  return best;
}

function newSlot(id: string, perk: PerkId): Slot {
  const def = weaponDef(id) ?? weaponDef(DEFAULT_PRIMARY)!;
  const cap = magazineFor(def, perk);
  return { def, mag: cap, cap, rangeMul: rangeMulFor(def, perk), nextFireAt: 0, reloadDoneAt: 0, burstShots: 0, burstStart: 0 };
}

function isSlot(v: unknown): v is 0 | 1 | 2 {
  return v === 0 || v === 1 || v === 2;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The client's shot counter from a `fire` message, −1 when absent. */
function seqOf(m: Extract<ClientMessage, { t: 'fire' }>): number {
  return typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq >= 0 ? m.seq : -1;
}

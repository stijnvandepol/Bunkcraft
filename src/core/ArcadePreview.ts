import { type GameType, type Team, gameTypeDef } from '../modes/GameTypes';
import { getMap } from '../modes/maps';
import { PLAYER_MAX_HEALTH, REGEN_DELAY, REGEN_PER_SECOND, RESPAWN_SECONDS, magazineFor, reloadTimeFor, weaponDef } from '../modes/Weapons';
import { type ClassSpec, DEFAULT_CLASS, validateClass } from '../modes/Loadouts';
import type { ClientMessage, MatchInfo, MatchPhase, ModeEventKind, ModeState, RosterEntry, ServerMessage, SnapshotEntry } from '../net/protocol';

/**
 * Development only: a tiny in-browser stand-in for the arcade server, so the client side (HUD,
 * weapons, tracers, scoreboard, death and match end screens) can be looked at and tested without
 * the real server. It answers the client's messages the way the contract describes (ammo, shot,
 * hit, kill, spawn, ...) and moves a few bots around. It is not a game server: no walls for
 * bullets besides the host's block raycast, no bot aim, no anti-cheat.
 */
export interface PreviewHost {
  deliver(msg: ServerMessage): void;
  snapshot(entries: SnapshotEntry[]): void;
  /** Where bullets stop: distance along the ray to the first block, or `max`. */
  rayDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number;
}

interface Bot {
  id: number;
  name: string;
  team: Team | '';
  /** Orbit around the arena centre. */
  radius: number;
  angle: number;
  speed: number;
  health: number;
  kills: number;
  deaths: number;
  deadUntil: number;
  weapon: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Stands still where it is (for looking at models). */
  pinned?: boolean;
}

const BOT_NAMES = ['Nova', 'Pixel', 'Rex', 'Blaze', 'Kiwi', 'Echo', 'Vortex'];
const BOT_WEAPONS = ['rifle', 'smg', 'shotgun', 'sniper', 'pistol', 'rifle', 'smg'];

export class ArcadePreviewServer {
  readonly selfId = 1;
  phase: MatchPhase = 'warmup';
  timeLeft = 4;
  readonly info: MatchInfo;
  private readonly bots: Bot[] = [];
  private readonly scores = { red: 0, blue: 0 };
  private team: Team | '';
  private kills = 0;
  private deaths = 0;
  private health = PLAYER_MAX_HEALTH;
  private lastDamage = -99;
  private dead = false;
  private respawnAt = 0;
  private primary = 'rifle';
  private cls: ClassSpec = { ...DEFAULT_CLASS };
  private slot = 0;
  private readonly mags = [0, 12, 0];
  private readonly reloadDone = [0, 0, 0];
  private t = 0;
  private snapTimer = 0;
  private matchTimer = 0;
  private rosterTimer = 0;
  private botFire = 2;
  private endAt = 0;
  /** Bots shoot at you when true (turn off to look at things in peace). */
  botsAggressive = true;
  /** Pitch the bots look at (radians, positive = up). */
  botPitch = 0;
  /** Where the arena floor is and its centre (set by the host). */
  centerX = 8;
  centerZ = 8;
  floorY = 80;

  /** Objective score per player id (gun game level, captures) for the roster. */
  private readonly pts = new Map<number, number>();
  private text = '';

  constructor(private readonly host: PreviewHost, type: GameType, private readonly selfName: string, scoreLimit = 10, mapId?: string) {
    const def = gameTypeDef(type);
    this.info = { type, scoreLimit: def.logic === 'deathmatch' ? scoreLimit : def.scoreLimit, timeLimitSec: def.timeLimitSec, ...(mapId ? { map: mapId } : {}) };
    this.team = def.teams ? 'red' : '';
    this.timeLeft = 4;
    const count = def.teams ? 6 : 5;
    for (let i = 0; i < count; i++) {
      const team: Team | '' = def.teams ? (i % 2 === 0 ? 'blue' : i < 2 ? 'red' : 'blue') : '';
      this.bots.push({
        id: 10 + i, name: BOT_NAMES[i], team: def.teams ? (i < 2 ? 'red' : 'blue') : team, radius: 8 + i * 3, angle: (i / count) * Math.PI * 2,
        speed: (i % 2 ? 1 : -1) * (0.25 + i * 0.04), health: PLAYER_MAX_HEALTH, kills: 0, deaths: 0, deadUntil: 0,
        weapon: BOT_WEAPONS[i], x: 0, y: 0, z: 0, yaw: 0,
      });
    }
    this.mags[0] = weaponDef(this.primary)!.magazine;
  }

  /** The bot ids and names, for building the welcome player list. */
  players(): { id: number; name: string; team?: Team }[] {
    return this.bots.map((b) => ({ id: b.id, name: b.name, ...(b.team ? { team: b.team } : {}) }));
  }

  /** Sends the initial state, as the server would right after the welcome. */
  start(spawn: { x: number; y: number; z: number }): void {
    for (const b of this.bots) this.host.deliver({ t: 'holds', id: b.id, weapon: b.weapon, ...(b.weapon === 'sniper' ? { optic: 'scope' } : {}) });
    this.sendRoster();
    this.sendMatch();
    this.host.deliver({ t: 'spawn', x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0, team: this.team, primary: this.primary, health: this.health });
    this.sendAmmo(0);
    this.sendAmmo(1);
  }

  // ---------------------------------------------------------------- client messages

  onClient(msg: ClientMessage, player: { x: number; y: number; z: number }): void {
    switch (msg.t) {
      case 'loadout': {
        // The preview applies a class at once (the real server only right after a spawn).
        this.cls = validateClass(msg);
        this.primary = this.cls.primary;
        this.mags[0] = magazineFor(weaponDef(this.primary)!, this.cls.perk);
        this.mags[1] = magazineFor(weaponDef(this.cls.secondary)!, this.cls.perk);
        this.host.deliver({ t: 'gear', primary: this.primary, secondary: this.cls.secondary, optic: this.cls.optic, perk: this.cls.perk });
        this.sendAmmo(0);
        this.sendAmmo(1);
        break;
      }
      case 'weapon': this.slot = msg.slot; break;
      case 'reload': this.startReload(msg.slot); break;
      case 'fire': this.onFire(msg); break;
      default: void player;
    }
  }

  private weaponOf(slot: number): string {
    return slot === 0 ? this.primary : slot === 1 ? this.cls.secondary : 'knife';
  }

  private startReload(slot: number): void {
    const w = weaponDef(this.weaponOf(slot))!;
    if (w.magazine === 0 || this.reloadDone[slot] > 0 || this.mags[slot] >= w.magazine) return;
    this.reloadDone[slot] = this.t + reloadTimeFor(w, this.mags[slot]);
    this.sendAmmo(slot);
  }

  private onFire(msg: Extract<ClientMessage, { t: 'fire' }>): void {
    if (this.dead || this.phase === 'ended') return;
    const w = weaponDef(this.weaponOf(msg.slot))!;
    if (w.magazine > 0) {
      if (this.mags[msg.slot] <= 0 || this.reloadDone[msg.slot] > 0) return;
      this.mags[msg.slot]--;
      this.sendAmmo(msg.slot);
    }
    // Nearest bot on the ray (a box 0.6 wide and 1.8 tall).
    let bestT = Math.min(w.maxRange, this.host.rayDistance(msg.ox, msg.oy, msg.oz, msg.dx, msg.dy, msg.dz, w.maxRange));
    let target: Bot | null = null;
    let head = false;
    for (const b of this.bots) {
      if (b.deadUntil > 0 || (b.team !== '' && b.team === this.team)) continue;
      const hit = rayBox(msg.ox, msg.oy, msg.oz, msg.dx, msg.dy, msg.dz, b.x, b.y, b.z);
      if (hit >= 0 && hit < bestT) {
        bestT = hit;
        target = b;
        head = msg.oy + msg.dy * hit > b.y + 1.4;
      }
    }
    this.host.deliver({
      t: 'shot', id: this.selfId, weapon: w.id, ox: msg.ox, oy: msg.oy, oz: msg.oz,
      ex: msg.ox + msg.dx * bestT, ey: msg.oy + msg.dy * bestT, ez: msg.oz + msg.dz * bestT,
    });
    if (!target) return;
    const damage = Math.round(w.damage * (head ? w.headshot : 1));
    target.health -= damage;
    const killed = target.health <= 0;
    this.host.deliver({ t: 'hit', victim: target.id, damage, head, killed });
    if (killed) this.kill(this.selfId, target, w.id, head);
  }

  // ---------------------------------------------------------------- scripted events (for tests)

  /** A bot shoots and hits you for `damage` from the direction (dx, dz). */
  damage(damage: number, fromBot = 0): void {
    const b = this.bots[fromBot % this.bots.length];
    this.hurt(b, damage, false);
  }

  /** Kills you by a bot. */
  killSelf(fromBot = 0, head = false): void {
    const b = this.bots[fromBot % this.bots.length];
    this.health = 0;
    this.die(b, b.weapon, head);
  }

  /** Kills a bot as if you shot it. */
  killBot(index = 0): void {
    const b = this.bots[index % this.bots.length];
    b.health = 0;
    this.host.deliver({ t: 'hit', victim: b.id, damage: 100, head: false, killed: true });
    this.kill(this.selfId, b, this.weaponOf(this.slot), false);
  }

  /** Bots kill each other (fills the kill feed). */
  botKill(): void {
    const a = this.bots[0], v = this.bots[1];
    this.host.deliver({ t: 'kill', killer: a.id, victim: v.id, weapon: a.weapon, head: true });
    a.kills++;
    v.deaths++;
    this.sendRoster();
  }

  /** Ends the match with a win for `team` (or you / draw for free for all). */
  endMatch(winner: 'self' | 'draw' | Team = 'self'): void {
    this.phase = 'ended';
    this.endAt = this.t + 10;
    this.host.deliver({
      t: 'matchend', winnerTeam: winner === 'red' || winner === 'blue' ? winner : '', winnerId: winner === 'self' ? this.selfId : 0, restartIn: 10,
    });
    this.sendMatch();
  }

  /** Gives the bots and you some kills so the scoreboard has something to show. */
  fillScores(): void {
    this.kills = 7;
    this.deaths = 3;
    this.bots.forEach((b, i) => {
      b.kills = 2 + ((i * 5) % 9);
      b.deaths = 1 + ((i * 3) % 6);
    });
    this.scores.red = 14;
    this.scores.blue = 11;
    this.sendRoster();
    this.sendMatch();
  }

  // ---------------------------------------------------------------- objective modes (scripted states for looking at the HUD)

  /** Puts the match in a phase with a timer (intermission, countdown, roundend, live). */
  setPhase(phase: MatchPhase, seconds: number, text = ''): void {
    this.phase = phase;
    this.timeLeft = seconds;
    this.text = text;
    this.sendMatch();
  }

  setScores(red: number, blue: number): void {
    this.scores.red = red;
    this.scores.blue = blue;
    this.sendMatch();
  }

  /** Sends a mode state as the server would (zones, flags, rounds). */
  modeState(state: ModeState): void {
    this.host.deliver({ t: 'mode', state });
  }

  event(kind: ModeEventKind, team: Team | '' = '', id = 0, text = ''): void {
    this.host.deliver({ t: 'event', kind, ...(team ? { team } : {}), ...(id ? { id } : {}), ...(text ? { text } : {}) });
  }

  /** A typical state of the current mode on the preview's map: zones held/contested, a carried flag, round 3 ... */
  demo(): void {
    const def = gameTypeDef(this.info.type);
    const map = getMap(this.info.map);
    if (def.logic === 'zones') {
      const hp = this.info.type === 'hardpoint';
      const zones = map.zones.map((z, i) => ({
        name: z.name, x: z.x, y: z.y, z: z.z, r: z.r, active: hp ? i === 0 : true,
        owner: (hp ? (i === 0 ? 'red' : '') : i === 0 ? 'red' : i === 1 ? 'blue' : '') as Team | '',
        progress: hp ? 0 : i === 2 ? 0.45 : 1, progressTeam: (hp ? '' : i === 2 ? 'red' : i === 0 ? 'red' : 'blue') as Team | '',
        contested: !hp && i === 1, red: i === 0 ? 2 : i === 1 ? 1 : 0, blue: i === 1 ? 1 : 0,
      }));
      this.modeState({ kind: 'zones', variant: hp ? 'hardpoint' : 'domination', zones: hp ? zones : map.dominationZones.map((i) => zones[i]), rotateIn: 42, gap: false });
      this.setScores(hp ? 132 : 61, hp ? 97 : 48);
      this.text = hp ? `Hill: ${map.zones[0]?.name ?? ''} · first to ${this.info.scoreLimit}` : `First to ${this.info.scoreLimit} points`;
      this.sendMatch();
    } else if (def.logic === 'ctf') {
      const [rf, bf] = [map.flags.find((f) => f.team === 'red'), map.flags.find((f) => f.team === 'blue')];
      if (!rf || !bf) return;
      const carrier = this.bots.find((b) => b.team === 'blue') ?? this.bots[0];
      this.modeState({
        kind: 'ctf', flags: [
          { team: 'red', status: 'carried', x: carrier.x, y: carrier.y, z: carrier.z, carrier: carrier.id, returnIn: 0, hx: rf.x, hy: rf.y, hz: rf.z },
          { team: 'blue', status: 'dropped', x: bf.x - 6, y: bf.y, z: bf.z + 2, carrier: 0, returnIn: 9, hx: bf.x, hy: bf.y, hz: bf.z },
        ],
      });
      this.pts.set(this.selfId, 1);
      this.setScores(1, 2);
      this.sendRoster();
    } else if (def.logic === 'rounds') {
      this.modeState({ kind: 'rounds', round: 4, need: this.info.scoreLimit, wins: { red: 2, blue: 1 }, alive: { red: 2, blue: 3 } });
      this.text = `Round 4 · first to ${this.info.scoreLimit}`;
      this.setScores(2, 1);
    } else if (def.logic === 'gungame') {
      this.ladder(6);
    }
  }

  /** Gun game: puts you on a ladder level (0-based) and the bots around it. */
  ladder(level: number): void {
    const ladder = gameTypeDef(this.info.type).ladder;
    if (!ladder) return;
    this.pts.set(this.selfId, level);
    this.bots.forEach((b, i) => this.pts.set(b.id, (level + 3 - i + ladder.length) % ladder.length));
    this.primary = ladder[Math.min(level, ladder.length - 1)];
    this.host.deliver({ t: 'gear', primary: this.primary, secondary: 'knife' });
    this.sendRoster();
  }

  // ---------------------------------------------------------------- simulation

  private sendAmmo(slot: number): void {
    this.host.deliver({ t: 'ammo', slot: slot as 0 | 1 | 2, mag: this.mags[slot], reloading: this.reloadDone[slot] > 0 });
  }

  private sendMatch(): void {
    this.host.deliver({ t: 'match', phase: this.phase, timeLeft: this.timeLeft, scores: { ...this.scores }, info: this.info, ...(this.text ? { text: this.text } : {}) });
  }

  private sendRoster(): void {
    const withPts = !!gameTypeDef(this.info.type).scoreColumn;
    const pts = (id: number) => (withPts ? { pts: this.pts.get(id) ?? 0 } : {});
    const players: RosterEntry[] = [{ id: this.selfId, name: this.selfName, team: this.team, kills: this.kills, deaths: this.deaths, ping: 0, ...pts(this.selfId) }];
    for (const b of this.bots) players.push({ id: b.id, name: b.name, team: b.team, kills: b.kills, deaths: b.deaths, ping: 20 + ((b.id * 7) % 50), ...pts(b.id) });
    this.host.deliver({ t: 'roster', players });
  }

  private hurt(b: Bot, damage: number, head: boolean): void {
    if (this.dead) return;
    this.lastDamage = this.t;
    this.health -= damage;
    const p = this.playerPos;
    this.host.deliver({ t: 'damaged', from: b.id, damage, dx: b.x - p.x, dz: b.z - p.z });
    this.host.deliver({ t: 'hp', health: Math.max(0, this.health) });
    if (this.health <= 0) this.die(b, b.weapon, head);
  }

  private die(b: Bot, weapon: string, head: boolean): void {
    if (this.dead) return;
    this.dead = true;
    this.deaths++;
    b.kills++;
    this.respawnAt = this.t + RESPAWN_SECONDS;
    this.host.deliver({ t: 'hp', health: 0 });
    this.host.deliver({ t: 'kill', killer: b.id, victim: this.selfId, weapon, head });
    if (b.team) this.scores[b.team]++;
    this.sendRoster();
    this.sendMatch();
  }

  private kill(killer: number, victim: Bot, weapon: string, head: boolean): void {
    victim.deadUntil = this.t + RESPAWN_SECONDS;
    victim.deaths++;
    if (killer === this.selfId) {
      this.kills++;
      if (this.team) this.scores[this.team]++;
    }
    this.host.deliver({ t: 'kill', killer, victim: victim.id, weapon, head });
    this.sendRoster();
    this.sendMatch();
    this.checkEnd();
  }

  private checkEnd(): void {
    if (this.phase !== 'live') return;
    if (this.info.type === 'tdm') {
      if (this.scores.red >= this.info.scoreLimit) this.endMatch('red');
      else if (this.scores.blue >= this.info.scoreLimit) this.endMatch('blue');
    } else if (this.kills >= this.info.scoreLimit) this.endMatch('self');
  }

  private playerPos = { x: 0, y: 0, z: 0, yaw: 0 };

  /** Advances the simulation; `player` is where you are (for bot aim and regeneration). */
  update(dt: number, player: { x: number; y: number; z: number; yaw: number }): void {
    this.t += dt;
    this.playerPos = player;
    // Match clock.
    this.matchTimer -= dt;
    if (this.phase === 'warmup' || this.phase === 'live') {
      this.timeLeft -= dt;
      if (this.phase === 'warmup' && this.timeLeft <= 0) {
        this.phase = 'live';
        this.timeLeft = this.info.timeLimitSec;
        this.sendMatch();
      }
    } else if (this.phase === 'ended' && this.t >= this.endAt) {
      this.phase = 'warmup';
      this.timeLeft = 4;
      this.scores.red = this.scores.blue = this.kills = this.deaths = 0;
      for (const b of this.bots) b.kills = b.deaths = 0;
      this.sendMatch();
      this.sendRoster();
      this.respawn();
    }
    if (this.matchTimer <= 0) {
      this.matchTimer = 1;
      this.sendMatch();
    }
    this.rosterTimer -= dt;
    if (this.rosterTimer <= 0) {
      this.rosterTimer = 3;
      this.sendRoster();
    }
    // Reloads finish.
    for (let s = 0; s < 3; s++) {
      if (this.reloadDone[s] > 0 && this.t >= this.reloadDone[s]) {
        this.reloadDone[s] = 0;
        this.mags[s] = weaponDef(this.weaponOf(s))!.magazine;
        this.sendAmmo(s);
      }
    }
    // Respawn and regeneration.
    if (this.dead && this.t >= this.respawnAt) this.respawn();
    if (!this.dead && this.health < PLAYER_MAX_HEALTH && this.t - this.lastDamage > REGEN_DELAY) {
      this.health = Math.min(PLAYER_MAX_HEALTH, this.health + REGEN_PER_SECOND * dt);
      if (Math.floor(this.t * 5) !== Math.floor((this.t - dt) * 5)) this.host.deliver({ t: 'hp', health: Math.round(this.health) });
    }
    // Bots walk in circles, die and come back.
    for (const b of this.bots) {
      if (b.deadUntil > 0 && this.t >= b.deadUntil) {
        b.deadUntil = 0;
        b.health = PLAYER_MAX_HEALTH;
      }
      if (b.pinned) continue;
      const prevX = b.x, prevZ = b.z;
      b.angle += b.speed * dt;
      b.x = this.centerX + Math.cos(b.angle) * b.radius;
      b.z = this.centerZ + Math.sin(b.angle) * b.radius;
      b.y = this.floorY;
      const vx = b.x - prevX, vz = b.z - prevZ;
      if (vx !== 0 || vz !== 0) b.yaw = Math.atan2(-vx, -vz);
    }
    // Snapshots at 20 Hz.
    this.snapTimer -= dt;
    if (this.snapTimer <= 0) {
      this.snapTimer = 0.05;
      const entries: SnapshotEntry[] = [];
      for (const b of this.bots) {
        const aim = Math.atan2(-(player.x - b.x), -(player.z - b.z));
        entries.push([b.id, b.x, b.y, b.z, this.botsAggressive && b.deadUntil === 0 ? aim : b.yaw, this.botPitch, 1 | 4, 0]);
      }
      this.host.snapshot(entries);
    }
    // Bots shoot at you now and then.
    this.botFire -= dt;
    if (this.botFire <= 0 && this.botsAggressive) {
      this.botFire = 0.9 + Math.random() * 1.4;
      const live = this.bots.filter((b) => b.deadUntil === 0 && (b.team === '' || b.team !== this.team));
      if (live.length > 0 && this.phase === 'live' && !this.dead) {
        const b = live[Math.floor(Math.random() * live.length)];
        const dx = player.x - b.x, dy = player.y + 1.4 - (b.y + 1.5), dz = player.z - b.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const hits = Math.random() < 0.35;
        this.host.deliver({
          t: 'shot', id: b.id, weapon: b.weapon, ox: b.x, oy: b.y + 1.5, oz: b.z,
          ex: b.x + (dx / len) * len * (hits ? 1 : 0.9), ey: b.y + 1.5 + (dy / len) * len, ez: b.z + (dz / len) * len * (hits ? 1 : 0.9),
        });
        if (hits) this.hurt(b, 14 + Math.floor(Math.random() * 14), Math.random() < 0.1);
      }
    }
  }

  private respawn(): void {
    this.dead = false;
    this.health = PLAYER_MAX_HEALTH;
    this.primary = this.cls.primary;
    this.mags[0] = magazineFor(weaponDef(this.primary)!, this.cls.perk);
    this.mags[1] = magazineFor(weaponDef(this.cls.secondary)!, this.cls.perk);
    this.reloadDone[0] = this.reloadDone[1] = 0;
    this.slot = 0;
    this.host.deliver({
      t: 'spawn', x: this.centerX + (Math.random() - 0.5) * 20, y: this.floorY, z: this.centerZ + (Math.random() - 0.5) * 20,
      yaw: Math.random() * Math.PI * 2, team: this.team, primary: this.primary, health: this.health,
      secondary: this.cls.secondary, optic: this.cls.optic, perk: this.cls.perk,
    });
    this.sendAmmo(0);
    this.sendAmmo(1);
  }
}

/** Ray against a player box (feet at x, y, z): distance along the ray or −1. */
function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, bx: number, by: number, bz: number): number {
  const min = [bx - 0.3, by, bz - 0.3], max = [bx + 0.3, by + 1.8, bz + 0.3];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return -1;
    } else {
      let t1 = (min[i] - o[i]) / d[i], t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}


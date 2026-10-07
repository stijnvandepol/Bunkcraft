import type { Team } from '../../src/modes/GameTypes';
import { LOADOUT_PRESETS, type LoadoutPreset } from '../../src/modes/Loadouts';
import { lockClass } from '../../src/modes/progression/Unlocks';
import { HITBOX, PLAYER_MAX_HEALTH, type WeaponDef } from '../../src/modes/Weapons';
import type { BlockGetter } from '../../src/player/Collision';
import { PHYSICS } from '../../src/player/Physics';
import { type ClientMessage, type ModeState, SNAP_FLAG_ADS, type ServerMessage } from '../../src/net/protocol';
import { type BlockQuery, traceBlocks } from '../Combat';
import type { Match, MatchPlayer } from '../Match';
import { BotAim, wrapAngle, yawPitchOf } from './BotAim';
import { BotMover } from './BotMover';
import { type BotSkill, NOTICE_NEAR } from './BotSkill';
import type { NavGraph } from './NavGraph';

const DEG = Math.PI / 180;
const EYE = PHYSICS.EYE_HEIGHT;
/** Chest and head heights above the feet (aim points). */
const CHEST = 1.1;
const HEAD = HITBOX.height - HITBOX.head / 2;
const SIGHT_POINTS = [CHEST, HEAD] as const;

/** What the bots of one lobby share: the match, the map, the clock budget and what was heard. */
export interface BotEnv {
  readonly match: Match;
  graph: NavGraph;
  blocks: BlockQuery;
  getBlock: BlockGetter;
  getMeta?: BlockGetter;
  rng: () => number;
  /** A client message from bot `id`, handled exactly like one from a socket. */
  send(id: number, msg: ClientMessage): void;
  /** The mode's HUD state (zones, flags), refreshed a few times a second; null in plain modes. */
  mode: ModeState | null;
  /** Path searches left this tick (spread over ticks so a burst of re-plans never spikes). */
  pathTokens: number;
  /** Recent gunfire (shooter, where, when, suppressed). */
  heard: { id: number; x: number; y: number; z: number; t: number; quiet: boolean }[];
}

interface Known {
  /** Last time it was in sight; position and velocity then. */
  seenAt: number;
  x: number; y: number; z: number;
  vx: number; vz: number;
  visible: boolean;
}

type State = 'roam' | 'fight' | 'retreat';

/** The weapon roles that matter for positioning: range kept in a fight. */
function preferredRange(w: WeaponDef): number {
  if (w.slot === 'melee') return 1.5;
  if (w.id === 'shotgun') return 5;
  if (w.id === 'smg' || w.id === 'mpistol') return 9;
  if (w.id === 'sniper' || w.id === 'semisniper' || w.id === 'dmr') return 35;
  return 18;
}

/** Large maps favour long guns, small ones close-range classes; plus some personal taste. */
export function pickClass(mapHalfSize: number, rng: () => number, skill: BotSkill): LoadoutPreset {
  const big = mapHalfSize >= 38;
  const weights: Record<string, number> = {
    assault: 30, rusher: big ? 12 : 22, breacher: big ? 3 : 10, support: 10, marksman: big ? 14 : 6,
    burst: 14, sniper: big ? (skill.ads ? 8 : 2) : 2,
  };
  let sum = 0;
  for (const p of LOADOUT_PRESETS) sum += weights[p.id] ?? 5;
  let r = rng() * sum;
  for (const p of LOADOUT_PRESETS) {
    r -= weights[p.id] ?? 5;
    if (r <= 0) return p;
  }
  return LOADOUT_PRESETS[0];
}

/**
 * One server-side bot: perception (sight lines, gunfire, hits), a small state machine (roam/objective, fight,
 * retreat to cover), path following on the nav graph and human-like aim. It plays through the same doors
 * as a player: `pos`, `fire`, `reload`, `weapon` and `loadout` messages go through the server's normal
 * handler with its rate limits, movement validation and shot checks; what it knows of the game is what a
 * client is told (its own state, sight lines, the HUD's mode state, gunfire and hits).
 */
export class Bot {
  readonly aim: BotAim;
  readonly mover = new BotMover();
  /** Fixed role in team objective modes: 0 attack, 1 defend/hold. */
  readonly role: number;
  state: State = 'roam';
  private readonly known = new Map<number, Known>();
  private target = 0;
  private nextThink = 0;
  private lastTick = 0;
  private alive = false;
  /** Roam / objective goal: a node and when to choose again. */
  private goalNode = -1;
  private goalUntil = 0;
  private goalKey = '';
  private routeAt = -1e9;
  private retreatUntil = 0;
  private lastDamagedAt = -1e9;
  private attacker = 0;
  private investigate: { x: number; y: number; z: number; until: number } | null = null;
  private strafeDir = 1;
  private strafeUntil = 0;
  private hopAt = 0;
  private adsSince = 0;
  private nextClickAt = 0;
  private shotIndex = 0;
  private lastShotAt = -1e9;
  private heardSeen = 0;
  private lastPosAt = 0;
  private classPicked = false;
  private deaths = 0;
  private readonly route: number[] = [];
  private readonly scratch: number[] = [];
  private readonly dir: [number, number, number] = [0, 0, 0];
  private readonly yp = { yaw: 0, pitch: 0 };

  constructor(readonly id: number, readonly name: string, public skill: BotSkill, private readonly env: BotEnv, index: number, private readonly posInterval: number) {
    this.aim = new BotAim(skill, env.rng);
    this.role = index % 3 === 2 ? 1 : 0;
    this.nextThink = 0;
  }

  private get me(): MatchPlayer | undefined {
    return this.env.match.players.get(this.id);
  }

  // ---------------------------------------------------------------- messages from the server

  /** Server messages addressed to this bot (objects, never serialised). */
  onMessage(msg: ServerMessage, now: number): void {
    switch (msg.t) {
      case 'spawn':
        this.mover.reset(msg.x, msg.y, msg.z);
        this.aim.yaw = msg.yaw;
        this.aim.pitch = 0;
        this.aim.drop();
        this.alive = true;
        this.known.clear();
        this.target = 0;
        this.state = 'roam';
        this.goalNode = -1;
        this.investigate = null;
        this.adsSince = 0;
        this.nextThink = Math.min(this.nextThink, now + 0.05);
        break;
      case 'teleport':
        // A rubber band (should never happen to a bot; the tests fail if it does): follow it and plan again.
        this.mover.reset(msg.x, msg.y, msg.z);
        this.routeAt = -1e9;
        break;
      case 'damaged': {
        this.lastDamagedAt = now;
        this.attacker = msg.from;
        const a = this.env.match.players.get(msg.from);
        // Hit from somewhere: look that way and remember roughly where the shooter is.
        if (a) this.investigate = { x: a.x, y: a.y, z: a.z, until: now + 6 };
        this.nextThink = Math.min(this.nextThink, now + 0.05);
        break;
      }
      case 'kill':
        if (msg.victim === this.id) { this.alive = false; this.deaths++; this.mover.clearRoute(); }
        else if (msg.victim === this.target) { this.target = 0; this.aim.drop(); }
        this.known.delete(msg.victim);
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- the tick

  /** Called every server tick; `think` = this bot may run its (more expensive) decision step now. */
  tick(now: number, mayThink: boolean): void {
    const dt = this.lastTick > 0 ? Math.min(0.25, now - this.lastTick) : 0;
    this.lastTick = now;
    const me = this.me;
    if (!me) return;
    if (!this.classPicked) this.chooseClass();
    if (!me.alive || !this.alive) { this.mover.clearRoute(); return; }
    const phase = this.env.match.phase;
    const frozen = phase === 'ended' || phase === 'roundend' || phase === 'intermission' || phase === 'countdown';
    if (mayThink && now >= this.nextThink) {
      this.nextThink = now + 0.09 + this.env.rng() * 0.03;
      this.think(now, me, frozen);
    }
    this.act(dt, now, me, frozen);
  }

  /** Whether `tick` would like to think now (the manager hands out the budget). */
  wantsThink(now: number): boolean {
    return this.alive && now >= this.nextThink;
  }

  private chooseClass(): void {
    this.classPicked = true;
    if (this.env.match.def.loadout === 'ladder') return;
    const b = this.env.match.map.bounds;
    // Bots have no Realms profile: like a guest they get the level 1 unlocks (the server would enforce that anyway).
    const c = lockClass(pickClass(Math.max(b.maxX, b.maxZ), this.env.rng, this.skill), { level: 1, prestige: 0 });
    this.env.send(this.id, { t: 'loadout', primary: c.primary, secondary: c.secondary, optic: c.optic, perk: c.perk });
  }

  // ---------------------------------------------------------------- perception and decisions

  private enemy(o: MatchPlayer, me: MatchPlayer): boolean {
    return o.id !== me.id && o.alive && (!this.env.match.teams || o.team !== me.team);
  }

  /** Line of sight from the eye to the chest or head of a player at (x, y, z). */
  private sees(ex: number, ey: number, ez: number, x: number, y: number, z: number): boolean {
    for (const h of SIGHT_POINTS) {
      const dx = x - ex, dy = y + h - ey, dz = z - ez, d = Math.hypot(dx, dy, dz);
      if (d < 0.5) return true;
      if (traceBlocks(this.env.blocks, ex, ey, ez, dx / d, dy / d, dz / d, d) >= d - 0.05) return true;
    }
    return false;
  }

  private perceive(now: number, me: MatchPlayer): void {
    const m = this.mover, s = this.skill;
    const ex = m.x, ey = m.y + EYE, ez = m.z;
    for (const k of this.known.values()) k.visible = false;
    for (const o of this.env.match.players.values()) {
      if (!this.enemy(o, me)) continue;
      const dx = o.x - ex, dz = o.z - ez, d = Math.hypot(dx, o.y + CHEST - ey, dz);
      const k = this.known.get(o.id);
      const tracking = !!k && now - k.seenAt < 1;
      if (d > s.noticeRange && !tracking) continue;
      const off = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - this.aim.yaw)) / DEG;
      // Noticed: in the view cone, close by (footsteps), the one that just shot us, or already being tracked.
      if (!(off <= s.fov || d <= NOTICE_NEAR || tracking || (o.id === this.attacker && now - this.lastDamagedAt < 1.5))) continue;
      if (!this.sees(ex, ey, ez, o.x, o.y, o.z)) continue;
      if (k) {
        const dtk = Math.max(0.05, now - k.seenAt);
        if (now - k.seenAt < 0.5) { k.vx = (o.x - k.x) / dtk; k.vz = (o.z - k.z) / dtk; } else { k.vx = 0; k.vz = 0; }
        k.x = o.x; k.y = o.y; k.z = o.z; k.seenAt = now; k.visible = true;
      } else this.known.set(o.id, { seenAt: now, x: o.x, y: o.y, z: o.z, vx: 0, vz: 0, visible: true });
    }
    for (const [id, k] of this.known) if (now - k.seenAt > 8) this.known.delete(id);
    // Gunfire: an enemy shot within earshot is worth a look.
    const heard = this.env.heard;
    for (let i = heard.length - 1; i >= 0 && heard[i].t > this.heardSeen; i--) {
      const h = heard[i];
      if (h.id === me.id) continue;
      const o = this.env.match.players.get(h.id);
      if (!o || !this.enemy(o, me)) continue;
      const range = h.quiet ? 12 : 40;
      if (Math.hypot(h.x - ex, h.z - ez) > range) continue;
      if (!this.investigate || this.investigate.until < now + 3) this.investigate = { x: h.x, y: h.y - EYE, z: h.z, until: now + 6 };
    }
    if (heard.length) this.heardSeen = heard[heard.length - 1].t;
  }

  /** The visible enemy to fight: close, near the crosshair, shooting at us, carrying our flag. */
  private chooseTarget(now: number, me: MatchPlayer): void {
    let best = 0, bestScore = Infinity;
    const m = this.mover;
    for (const [id, k] of this.known) {
      if (!k.visible) continue;
      const dx = k.x - m.x, dz = k.z - m.z, d = Math.hypot(dx, k.y - m.y, dz);
      const off = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - this.aim.yaw)) / DEG;
      let score = d * (1 + off / 90);
      if (id === this.attacker && now - this.lastDamagedAt < 2) score -= 8;
      if (id === this.target) score -= 6; // stick with a fight
      if (this.flagCarrierOf(me.team) === id) score -= 15;
      if (score < bestScore) { bestScore = score; best = id; }
    }
    if (best && best !== this.aim.targetId) this.aim.acquire(best, now);
    if (best) { this.target = best; return; }
    // Nobody in sight: keep the last target for a moment (pre-aim where it went), then give up.
    const k = this.known.get(this.target);
    if (!k || now - k.seenAt > 1.5) { this.target = 0; this.aim.drop(); }
  }

  private think(now: number, me: MatchPlayer, frozen: boolean): void {
    this.perceive(now, me);
    if (frozen) { this.target = 0; this.state = 'roam'; return; }
    // Warm-up: nobody can be hurt, so no fights; walk the map.
    if (this.env.match.phase === 'warmup') { this.target = 0; this.aim.drop(); this.state = 'roam'; this.plan(now, me); return; }
    this.chooseTarget(now, me);
    const k = this.target ? this.known.get(this.target) : undefined;
    const slot = me.slots[me.slot];
    // Retreat: low health, or caught reloading at range (cover first, then come back).
    if (this.state !== 'retreat' && k?.visible && this.skill.retreatHealth > 0) {
      const dist = Math.hypot(k.x - this.mover.x, k.z - this.mover.z);
      const reloading = slot.reloadDoneAt > 0 && dist > 10 && this.skill.retreatHealth >= 40;
      if ((me.health < this.skill.retreatHealth && now - this.lastDamagedAt < 1.5) || reloading) this.startRetreat(now, k);
    }
    if (this.state === 'retreat') {
      const healed = me.health >= PLAYER_MAX_HEALTH * 0.85 && slot.reloadDoneAt === 0;
      if (now > this.retreatUntil || healed) this.state = 'roam';
    } else this.state = this.target ? 'fight' : 'roam';
    this.plan(now, me);
    this.weapons(now, me, k);
  }

  private startRetreat(now: number, threat: Known): void {
    const cover = this.findCover(threat);
    if (cover < 0) return;
    this.state = 'retreat';
    this.retreatUntil = now + 7;
    this.setGoal(cover, 'cover', now, true);
  }

  /** A nearby standing spot the threat cannot see (chest and head hidden), preferring close ones. */
  private findCover(t: Known): number {
    const g = this.env.graph, m = this.mover;
    const near = g.nodesNear(m.x, m.y, m.z, 11, 3, this.scratch);
    let best = -1, bestScore = Infinity;
    const tx = t.x, ty = t.y + EYE, tz = t.z;
    let checks = 0;
    // Visit candidates in a scattered order; at most 36 sight checks.
    const step = Math.max(1, Math.floor(near.length / 36));
    for (let i = 0; i < near.length && checks < 36; i += step) {
      const n = near[i];
      if (!g.core[n]) continue;
      const d = Math.hypot(g.nx[n] - m.x, g.nz[n] - m.z);
      const toThreat = Math.hypot(g.nx[n] - tx, g.nz[n] - tz);
      if (toThreat < 6) continue;
      checks++;
      if (this.sees(tx, ty, tz, g.nx[n], g.ny[n], g.nz[n])) continue;
      const score = d - toThreat * 0.3 - (g.cover[n] ? 1.5 : 0);
      if (score < bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  private flagCarrierOf(team: Team | ''): number {
    const mode = this.env.mode;
    if (!team || mode?.kind !== 'ctf') return 0;
    const own = mode.flags.find((f) => f.team === team);
    return own && own.status === 'carried' ? own.carrier : 0;
  }

  /** Movement goal for this think: cover, the fight, the objective, or a place to look for enemies. */
  private plan(now: number, me: MatchPlayer): void {
    const g = this.env.graph, m = this.mover;
    if (this.state === 'retreat') { this.ensureRoute(now); return; }
    const objective = this.objective(now, me);
    if (this.state === 'fight') {
      const k = this.known.get(this.target)!;
      const w = me.slots[me.slot].def;
      const d = Math.hypot(k.x - m.x, k.z - m.z);
      // Objective first when it is urgent (carrying a flag, standing on the point): fight on the way.
      if (objective?.urgent) { this.setGoal(objective.node, objective.key, now); this.ensureRoute(now); return; }
      if (d > preferredRange(w) * 1.3 || !k.visible) {
        this.setGoal(g.nodeAt(k.x, k.y, k.z), `chase:${this.target}`, now, false, 1);
        this.ensureRoute(now);
      } else {
        // In range: strafe around (see act); no route.
        m.clearRoute();
        this.goalNode = -1;
      }
      return;
    }
    if (objective) { this.setGoal(objective.node, objective.key, now); this.ensureRoute(now); return; }
    // Hunt: where we were shot from or heard shooting; else wander the map.
    if (this.investigate && this.investigate.until > now) {
      const n = g.nodeAt(this.investigate.x, this.investigate.y, this.investigate.z);
      if (n >= 0) { this.setGoal(n, 'investigate', now, false, 2); this.ensureRoute(now); return; }
    }
    if (this.goalNode < 0 || now > this.goalUntil || this.goalKey !== 'roam' || !m.hasRoute) {
      this.setGoal(this.roamNode(me), 'roam', now, true, 25);
    }
    this.ensureRoute(now);
  }

  private setGoal(node: number, key: string, now: number, force = false, ttl = 30): void {
    if (node < 0) return;
    if (!force && this.goalKey === key && this.goalNode === node) return;
    if (!force && this.goalKey === key && key.startsWith('chase') && now < this.routeAt + 1) return;
    this.goalNode = node;
    this.goalKey = key;
    this.goalUntil = now + ttl;
    this.routeAt = -1e9;
  }

  /** Plans a route to the goal when there is none, it is stale or the bot got stuck (one path search per think). */
  private ensureRoute(now: number): void {
    const m = this.mover, g = this.env.graph;
    if (this.goalNode < 0) return;
    // A route to this goal (still being walked, or walked to the end) needs no new search.
    if (m.destination === this.goalNode && !m.stuck && now - this.routeAt < 6) return;
    if (m.stuck) this.hopAt = now; // stuck: hop once while replanning
    const from = g.nodeAt(m.x, m.y, m.z);
    if (from < 0) return;
    if (from === this.goalNode) { m.setRoute([from], now); this.routeAt = now; return; }
    if (this.env.pathTokens <= 0) return;
    this.env.pathTokens--;
    const r = g.path(from, this.goalNode, 6000, this.route);
    this.routeAt = now;
    if (r && r.length) m.setRoute(r, now);
    else { m.clearRoute(); this.goalNode = -1; }
  }

  /** A roaming spot in the main area: a few candidates, the one at a good distance (15-40 blocks) wins. */
  private roamNode(me: MatchPlayer): number {
    const g = this.env.graph, m = this.mover, rng = this.env.rng;
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < 6; i++) {
      const n = g.coreList[Math.floor(rng() * g.coreList.length)];
      const d = Math.hypot(g.nx[n] - m.x, g.nz[n] - m.z);
      let score = -Math.abs(d - 25) + rng() * 10;
      // Team games: drift towards the enemy half (red spawns on the left).
      if (this.env.match.teams && me.team) score += (me.team === 'red' ? g.nx[n] : -g.nx[n]) * 0.15;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  /** A random standing node within `r` of (x, z) at about height y (spreading out on an objective). */
  private spotNear(x: number, y: number, z: number, r: number): number {
    const g = this.env.graph;
    const near = g.nodesNear(x, y, z, r, 1.6, this.scratch);
    if (near.length === 0) return g.nodeAt(x, y, z);
    return near[Math.floor(this.env.rng() * near.length)];
  }

  /** Objective of the mode: where to go, a key for the goal, and whether it beats fighting. */
  private objective(now: number, me: MatchPlayer): { node: number; key: string; urgent: boolean } | null {
    const mode = this.env.mode;
    const g = this.env.graph, m = this.mover;
    if (!mode || !me.team) return null;
    if (mode.kind === 'zones') {
      const zones = mode.zones;
      let pick = -1;
      if (mode.variant === 'hardpoint') {
        pick = zones.findIndex((z) => z.active);
        if (pick < 0 || mode.gap) return null;
      } else {
        // Domination: the cheapest point to take or defend; held points matter less, each bot has a preference.
        let bestScore = Infinity;
        for (let i = 0; i < zones.length; i++) {
          const z = zones[i];
          let score = Math.hypot(z.x - m.x, z.z - m.z);
          if (z.owner === me.team && !(z.progressTeam && z.progressTeam !== me.team && z.progress > 0)) score += 45;
          if (z.contested) score -= 10;
          score += ((this.id * 7 + i * 13) % 5) * 6; // spread the team over the points
          if (score < bestScore) { bestScore = score; pick = i; }
        }
      }
      if (pick < 0) return null;
      const z = zones[pick];
      const inside = Math.hypot(me.x - z.x, me.z - z.z) < z.r - 0.5 && Math.abs(me.y - z.y) < 2;
      const key = `zone:${pick}`;
      // On the point: shuffle between spots inside it every few seconds (a harder target than standing still).
      if (this.goalKey !== key || this.goalNode < 0 || (inside && !m.hasRoute && now > this.goalUntil)) {
        this.setGoal(this.spotNear(z.x, z.y, z.z, Math.max(1, z.r - 1)), key, now, true, 3 + this.env.rng() * 3);
      }
      return { node: this.goalNode, key, urgent: inside };
    }
    if (mode.kind === 'ctf') {
      const own = mode.flags.find((f) => f.team === me.team);
      const enemy = mode.flags.find((f) => f.team !== me.team);
      if (!own || !enemy) return null;
      const carrying = enemy.status === 'carried' && enemy.carrier === me.id;
      if (carrying) {
        // Home with it; when our flag is gone, get it back first (a dropped one is returned by touching it).
        if (own.status === 'dropped') return { node: g.nodeAt(own.x, own.y, own.z), key: 'ctf:return', urgent: true };
        if (own.status === 'carried') {
          const c = this.env.match.players.get(own.carrier);
          if (c) return { node: g.nodeAt(c.x, c.y, c.z), key: `ctf:hunt:${own.carrier}`, urgent: false };
        }
        return { node: g.nodeAt(own.hx, own.hy, own.hz), key: 'ctf:home', urgent: true };
      }
      if (own.status === 'dropped' && Math.hypot(own.x - m.x, own.z - m.z) < 45) {
        return { node: g.nodeAt(own.x, own.y, own.z), key: 'ctf:return', urgent: true };
      }
      if (own.status === 'carried' && (this.role === 1 || Math.hypot(own.x - m.x, own.z - m.z) < 25)) {
        const c = this.env.match.players.get(own.carrier);
        if (c) return { node: g.nodeAt(c.x, c.y, c.z), key: `ctf:hunt:${own.carrier}`, urgent: false };
      }
      if (this.role === 1) {
        // Defender: around the own base.
        if (this.goalKey !== 'ctf:defend' || now > this.goalUntil) this.setGoal(this.spotNear(own.hx, own.hy, own.hz, 7), 'ctf:defend', now, true, 6 + this.env.rng() * 6);
        return { node: this.goalNode, key: 'ctf:defend', urgent: false };
      }
      if (enemy.status === 'carried') {
        // A teammate has it: escort towards home.
        const c = this.env.match.players.get(enemy.carrier);
        if (c) return { node: g.nodeAt(c.x, c.y, c.z), key: `ctf:escort:${enemy.carrier}`, urgent: false };
      }
      return { node: g.nodeAt(enemy.x, enemy.y, enemy.z), key: `ctf:take:${enemy.status}`, urgent: Math.hypot(enemy.x - m.x, enemy.z - m.z) < 8 };
    }
    return null;
  }

  /** Reload when empty or calm, switch to the sidearm when the primary runs dry up close. */
  private weapons(now: number, me: MatchPlayer, k: Known | undefined): void {
    const env = this.env;
    if (env.match.def.loadout === 'ladder') {
      // Gun game: the ladder weapon only (the knife is its own last level).
      const s = me.slots[me.slot];
      if (s.cap > 0 && s.mag === 0 && s.reloadDoneAt === 0) env.send(this.id, { t: 'reload', slot: me.slot });
      if (me.slot !== 0) env.send(this.id, { t: 'weapon', slot: 0 });
      return;
    }
    const s = me.slots[me.slot];
    const fighting = !!k?.visible;
    const dist = k ? Math.hypot(k.x - this.mover.x, k.z - this.mover.z) : Infinity;
    if (me.slot === 0 && s.mag === 0 && fighting && dist < 14 && me.slots[1].mag > 0) {
      env.send(this.id, { t: 'weapon', slot: 1 });
      return;
    }
    if (me.slot !== 0 && (!fighting || (me.slots[me.slot].mag === 0 && now - this.lastShotAt > 0.5))) {
      if (!fighting || me.slots[0].mag > 0) { env.send(this.id, { t: 'weapon', slot: 0 }); return; }
    }
    if (s.cap > 0 && s.reloadDoneAt === 0) {
      const calm = !k || now - k.seenAt > 1.5;
      if (s.mag === 0 || (calm && s.mag < s.cap * 0.5 && now - this.lastShotAt > 1.2)) env.send(this.id, { t: 'reload', slot: me.slot });
    }
  }

  // ---------------------------------------------------------------- acting every tick

  private act(dt: number, now: number, me: MatchPlayer, frozen: boolean): void {
    const m = this.mover, g = this.env.graph;
    const k = this.target ? this.known.get(this.target) : undefined;
    const w = me.slots[me.slot].def;
    let wx = 0, wz = 0, jump = false;
    if (!frozen) {
      if (this.state === 'fight' && !m.hasRoute && k) {
        // Strafe around the target, keeping to standing spots; close in or back off towards the weapon's range.
        if (now > this.strafeUntil) {
          this.strafeDir = this.env.rng() < 0.5 ? -1 : 1;
          this.strafeUntil = now + 0.35 + this.env.rng() * 0.9;
        }
        const dx = k.x - m.x, dz = k.z - m.z, d = Math.hypot(dx, dz) || 1;
        const fx = dx / d, fz = dz / d;
        const want = preferredRange(w);
        const along = d > want * 1.1 ? 1 : d < want * 0.6 ? -0.7 : 0;
        const side = this.skill.strafe * this.strafeDir;
        wx = fx * along + -fz * side; wz = fz * along + fx * side;
        const len = Math.hypot(wx, wz);
        if (len > 1e-3) {
          wx /= len; wz /= len;
          if (!g.walkable(m.x + wx * 0.9, m.y, m.z + wz * 0.9)) {
            this.strafeDir = -this.strafeDir;
            wx = fx * along + fz * side; wz = fz * along - fx * side;
            const l2 = Math.hypot(wx, wz);
            if (l2 > 1e-3 && g.walkable(m.x + (wx / l2) * 0.9, m.y, m.z + (wz / l2) * 0.9)) { wx /= l2; wz /= l2; } else { wx = 0; wz = 0; }
          }
        } else { wx = 0; wz = 0; }
        // Good players hop now and then in a fight.
        if (this.skill.strafe > 0.6 && m.body.onGround && now > this.hopAt + 1.2 && this.env.rng() < dt * 0.6) { jump = true; this.hopAt = now; }
      } else if (m.hasRoute) {
        m.follow(g, now);
        wx = m.wantX; wz = m.wantZ; jump = m.jump;
      }
      if (now - this.hopAt < 0.1) jump = true;
    }

    // Aim: the target (late by the tracking lag), the place it vanished, a noise, or where we walk.
    const ex = m.x, ey = m.y + EYE, ez = m.z;
    const moving = wx !== 0 || wz !== 0;
    if (k && !frozen && this.state !== 'retreat') {
      const lag = this.skill.trackLag;
      const tx = k.x - k.vx * lag, tz = k.z - k.vz * lag;
      const ty = k.y + (this.aim.aimHead ? HEAD : CHEST);
      this.aim.track(dt, ex, ey, ez, tx, ty, tz, moving, Math.hypot(k.vx, k.vz));
    } else if (this.investigate && this.investigate.until > now && !frozen) {
      yawPitchOf(this.investigate.x - ex, this.investigate.y + CHEST - ey, this.investigate.z - ez, this.yp);
      this.aim.look(dt, this.yp.yaw, this.yp.pitch);
    } else if (moving) {
      this.aim.look(dt, Math.atan2(-wx, -wz), 0);
    }

    // Aiming down the sights at range (takes the weapon's aim time), slower on the feet like a player.
    const wantAds = this.skill.ads && !!k?.visible && w.slot !== 'melee' && Math.hypot(k.x - m.x, k.z - m.z) > 10 && !frozen;
    if (wantAds) { if (this.adsSince === 0) this.adsSince = now; } else this.adsSince = 0;
    const ads = this.adsSince > 0 && now - this.adsSince >= w.adsTime;
    const carry = this.carrySlow(me);
    m.step(dt, wx, wz, jump, this.aim.yaw, w.moveSpeed * (ads ? 0.8 : 1) * carry, this.env.getBlock, this.env.getMeta);

    if (now - this.lastPosAt >= this.posInterval - 1e-3) {
      this.lastPosAt = now;
      const b = m.body;
      const flags = (b.sprinting ? 1 : 0) | (b.onGround ? 4 : 0) | (ads ? SNAP_FLAG_ADS : 0);
      this.env.send(this.id, { t: 'pos', x: b.x, y: b.y, z: b.z, yaw: this.aim.yaw, pitch: this.aim.pitch, flags, held: 0, step: m.steps });
    }
    if (!frozen && k?.visible && this.env.match.phase === 'live') this.tryFire(now, me, k, w, ads);
  }

  private carrySlow(me: MatchPlayer): number {
    const mode = this.env.mode;
    if (mode?.kind !== 'ctf') return 1;
    const carrying = mode.flags.some((f) => f.status === 'carried' && f.carrier === me.id);
    return carrying ? 1 - (this.env.match.def.params?.carrySlow ?? 0.1) : 1;
  }

  private tryFire(now: number, me: MatchPlayer, k: Known, w: WeaponDef, ads: boolean): void {
    if (now < this.aim.readyAt || this.aim.targetId !== this.target) return;
    const s = me.slots[me.slot];
    if (s.reloadDoneAt > 0 || now < me.switchReadyAt || now < s.nextFireAt || (s.cap > 0 && s.mag <= 0)) return;
    const m = this.mover;
    const d = Math.hypot(k.x - m.x, k.y - m.y, k.z - m.z);
    if (d > w.maxRange * 0.95) return;
    if (w.slot === 'melee' && d > w.range - 0.3) return;
    // Semi-automatic and bolt weapons: one click at a time, at a human rate.
    if (now < this.nextClickAt && (w.burst ? s.burstShots === 0 : !w.auto)) return;
    const half = Math.atan2(HITBOX.width / 2 + 0.05, Math.max(0.5, d));
    if (!this.aim.converged(half)) return;
    // Long guns wait for the scope (a hip shot with a sniper is a waste).
    if (w.adsSpread < w.spread * 0.3 && this.skill.ads && d > 10 && !ads) return;
    this.aim.dir(this.dir);
    const ex = m.x, ey = m.y + EYE, ez = m.z;
    this.env.send(this.id, { t: 'fire', slot: me.slot, ox: ex, oy: ey, oz: ez, dx: this.dir[0], dy: this.dir[1], dz: this.dir[2], ads });
    this.shotIndex = now - this.lastShotAt > 0.5 ? 0 : this.shotIndex + 1;
    this.lastShotAt = now;
    if (w.burst) {
      // A new trigger pull starts a burst; the server spaces its shots.
      if (s.burstShots === 1) this.nextClickAt = now + Math.max(w.burstCycleSec ?? 0.3, 1 / this.skill.maxCps);
    } else if (!w.auto) this.nextClickAt = now + Math.max(60 / w.rpm, 1 / this.skill.maxCps);
    this.aim.recoil(w, this.shotIndex);
  }
}

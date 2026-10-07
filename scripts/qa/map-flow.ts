/**
 * QA: offline flow simulation of a team deathmatch per map (no browser, no server). Two teams of bots walk
 * honest routes (scripts/lib/arenaPath, the paths the movement validator accepts) towards the fight, see each
 * other through the server's bullet trace and shoot it out with a simple time-to-kill model; the dead respawn
 * after 3 s at the team spawn furthest from the living enemies (like server/Match.pickSpawn). It measures how
 * fast a map gets you into a fight, the "Nuketown feel":
 *
 *  - first     time from the match start to the first sighting between the teams
 *  - spawn→see mean time from a (re)spawn to the first enemy in sight (spawn-to-fight time)
 *  - gap       mean time a living bot goes without an enemy in sight between two engagements
 *  - kpm       kills per minute over both teams
 *  - range     median distance of the sightings that started a fight (fights start within 40 blocks)
 *  - long%     share of the time out of a fight that a bot has an enemy in sight beyond 40 blocks (long lanes)
 *
 *   npx tsx scripts/qa/map-flow.ts [mapId ...] [--bots=6] [--secs=240] [--runs=3] [--json=out.json]
 *
 * Bots have 360° awareness and perfect routes, so the absolute numbers are optimistic; compare maps and
 * before/after, not with real matches.
 */
import { writeFileSync } from 'node:fs';
import { traceBlocks } from '../../server/Combat';
import { ARENA_FLOOR_Y, MAPS, getMap } from '../../src/modes/maps';
import { SOLID, TALL } from '../../src/world/BlockRegistry';
import type { ArenaMap, Spawn } from '../../src/modes/maps/ArenaMap';
import { arenaPath, follow } from '../lib/arenaPath';

const args = process.argv.slice(2);
const opt = (name: string, def: number) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const jsonOut = args.find((a) => a.startsWith('--json='))?.slice(7);
const ids = args.filter((a) => !a.startsWith('--'));
const maps = ids.length ? ids.map((id) => getMap(id)) : MAPS;
const BOTS = opt('bots', 6), SECS = opt('secs', 240), RUNS = opt('runs', 3);

const HZ = 10;
const SPEED = 7; // blocks per second, about the arcade run speed
const EYE = 1.62, CHEST = 1.2;
const RESPAWN = 3;
/** Seconds without an enemy in sight before a new sighting counts as a new engagement. */
const CALM = 2;
/** Fights start inside this range; sightings further out only count towards `long`. */
const MAX_SIGHT = 40;
const FAR_SIGHT = 100;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

interface Bot {
  team: 0 | 1;
  x: number; y: number; z: number;
  route: [number, number, number][];
  alive: boolean;
  respawnAt: number;
  spawnedAt: number;
  /** Time of the first sighting in this life (−1: none yet). */
  firstSeen: number;
  lastSight: number;
  inSight: boolean;
  /** Aim time built up on the current target. */
  aim: number;
  target: Bot | null;
}

interface Result { first: number; spawnToSee: number; gap: number; kpm: number; range: number; long: number; unseenLives: number }

function simulate(map: ArenaMap, seed: number): Result {
  const r = rng(seed);
  const variant = map.variantFor(seed);
  const world = { getBlock: (x: number, y: number, z: number) => map.blockAt(variant, x, y, z) };
  const sees = (a: Bot, b: Bot, max = MAX_SIGHT) => {
    const ox = a.x, oy = a.y + EYE, oz = a.z, dx = b.x - ox, dy = b.y + CHEST - oy, dz = b.z - oz, d = Math.hypot(dx, dy, dz);
    return d < max && traceBlocks(world, ox, oy, oz, dx / d, dy / d, dz / d, d) >= d - 0.01;
  };
  // Goals: standing cells of the map, drawn from the routes between the spawns and objectives, so bots
  // spread over all lanes (and roofs) instead of walking one straight line.
  const b = map.bounds;
  // Standing spots (floor, upper floors, roofs up to 8 high), feet height included.
  const goals: [number, number, number][] = [];
  const at = (x: number, y: number, z: number) => map.blockAt(variant, x, y, z);
  for (let i = 0; i < 6000 && goals.length < 400; i++) {
    const x = Math.floor(b.minX + 2 + r() * (b.maxX - b.minX - 4)), z = Math.floor(b.minZ + 2 + r() * (b.maxZ - b.minZ - 4));
    const levels: number[] = [];
    for (let y = ARENA_FLOOR_Y; y <= ARENA_FLOOR_Y + 8; y++) if (SOLID[at(x, y, z)] && !TALL[at(x, y, z)] && at(x, y + 1, z) === 0 && at(x, y + 2, z) === 0) levels.push(y + 1);
    if (levels.length) goals.push([x + 0.5, z + 0.5, levels[Math.floor(r() * levels.length)]]);
  }
  const spawns = [map.spawns.red, map.spawns.blue];
  const bots: Bot[] = [];
  for (let i = 0; i < BOTS * 2; i++) {
    bots.push({ team: (i % 2) as 0 | 1, x: 0, y: 0, z: 0, route: [], alive: false, respawnAt: 0, spawnedAt: 0, firstSeen: -1, lastSight: -99, inSight: false, aim: 0, target: null });
  }
  let t = 0;
  const spawnFor = (bot: Bot): Spawn => {
    let best = spawns[bot.team][0], score = -Infinity;
    for (const s of spawns[bot.team]) {
      let near = 1e6;
      for (const o of bots) if (o.alive && o.team !== bot.team) near = Math.min(near, (o.x - s.x) ** 2 + (o.z - s.z) ** 2);
      const sc = near + r() * 5;
      if (sc > score) { score = sc; best = s; }
    }
    return best;
  };
  const lives: number[] = [];
  let unseen = 0, kills = 0, calmTime = 0, engagements = 0, first = -1, aliveTime = 0, farTime = 0;
  const ranges: number[] = [];
  const spawn = (bot: Bot) => {
    // The first wave uses every spawn of the team once, like players joining.
    const s = t === 0 ? spawns[bot.team][(bots.indexOf(bot) >> 1) % spawns[bot.team].length] : spawnFor(bot);
    Object.assign(bot, { x: s.x, y: s.y, z: s.z, route: [], alive: true, spawnedAt: t, firstSeen: -1, lastSight: -99, inSight: false, aim: 0, target: null });
  };
  const replan = (bot: Bot) => {
    // Push towards the enemy: goals on the enemy's side of the map are twice as likely.
    for (let k = 0; k < 6; k++) {
      const g = goals[Math.floor(r() * goals.length)];
      const enemySide = bot.team === 0 ? g[0] > -4 : g[0] < 4;
      if (!enemySide && r() < 0.5) continue;
      const route = arenaPath(map, variant, [bot.x, bot.z, bot.y], g);
      if (route && route.length > 1) { bot.route = route; return; }
    }
  };
  for (const bot of bots) spawn(bot);
  const dt = 1 / HZ;
  for (; t < SECS; t += dt) {
    for (const bot of bots) {
      if (!bot.alive) { if (t >= bot.respawnAt) spawn(bot); continue; }
      // Sight: the nearest visible enemy.
      let target: Bot | null = null, best = Infinity;
      for (const o of bots) {
        if (!o.alive || o.team === bot.team) continue;
        const d = Math.hypot(o.x - bot.x, o.z - bot.z);
        if (d < best && sees(bot, o)) { best = d; target = o; }
      }
      if (target) {
        aliveTime += dt;
        if (!bot.inSight && t - bot.lastSight >= CALM) { engagements++; ranges.push(best); if (first < 0) first = t; }
        if (bot.firstSeen < 0) { bot.firstSeen = t; lives.push(t - bot.spawnedAt); }
        bot.inSight = true;
        bot.lastSight = t;
        if (bot.target !== target) { bot.target = target; bot.aim = -0.25 - r() * 0.2; }
        bot.aim += dt;
        // Time to kill: about 0.45 s up close, longer at range (spread, more misses).
        if (bot.aim >= 0.45 + best / 45) {
          target.alive = false;
          target.respawnAt = t + RESPAWN;
          if (target.firstSeen < 0) unseen++;
          kills++;
          bot.target = null;
          bot.aim = 0;
        }
        continue;
      }
      if (bot.inSight && t - bot.lastSight >= CALM) bot.inSight = false;
      if (!bot.inSight) calmTime += dt;
      aliveTime += dt;
      // Exposed to a long lane: an enemy in sight beyond fighting range.
      for (const o of bots) if (o.alive && o.team !== bot.team && sees(bot, o, FAR_SIGHT)) { farTime += dt; break; }
      bot.target = null;
      if (!bot.route.length) replan(bot);
      follow(bot, bot.route, SPEED * dt);
    }
  }
  ranges.sort((a, c) => a - c);
  const mean = (l: number[]) => (l.length ? l.reduce((a, c) => a + c, 0) / l.length : NaN);
  return {
    first, spawnToSee: mean(lives), gap: calmTime / Math.max(1, engagements), kpm: kills / (SECS / 60),
    range: ranges.length ? ranges[Math.floor(ranges.length / 2)] : NaN, long: 100 * farTime / Math.max(1e-9, aliveTime), unseenLives: unseen,
  };
}

const out: Record<string, Result> = {};
console.log('map'.padEnd(10) + 'first'.padStart(7) + 'spawn→see'.padStart(11) + 'gap'.padStart(7) + 'kpm'.padStart(7) + 'range'.padStart(7) + 'long%'.padStart(7));
for (const map of maps) {
  const runs = Array.from({ length: RUNS }, (_, i) => simulate(map, 1000 + i * 7919));
  const avg = (k: keyof Result) => runs.reduce((a, c) => a + c[k], 0) / runs.length;
  const res: Result = { first: avg('first'), spawnToSee: avg('spawnToSee'), gap: avg('gap'), kpm: avg('kpm'), range: avg('range'), long: avg('long'), unseenLives: avg('unseenLives') };
  out[map.id] = res;
  console.log(map.id.padEnd(10) + res.first.toFixed(1).padStart(7) + res.spawnToSee.toFixed(1).padStart(11) + res.gap.toFixed(1).padStart(7) + res.kpm.toFixed(1).padStart(7) + res.range.toFixed(0).padStart(7) + res.long.toFixed(1).padStart(7));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));

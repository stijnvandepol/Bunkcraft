/**
 * Spawn density on the multiplayer server's world (the same EntityManager as singleplayer):
 * hostile mobs within 64 blocks of a stationary survival player at midnight after 60 s and
 * 5 min, passive mobs in daylight after the chunks around the player loaded, and the CPU time
 * of a tick. Several seeds, one player each.
 *
 *   npx tsx scripts/bench-spawn.ts [seeds=6]
 */
import type { ServerMessage } from '../src/net/protocol';
import { BIOME } from '../src/world/Biomes';
import { createGenerator } from '../src/world/WorldGenerator';
import { ServerEntities } from '../server/ServerEntities';

const SEEDS = Number(process.argv[2] ?? 6);
const RADIUS = 64;

const host = {
  send: (_to: number, _msg: ServerMessage) => undefined,
  broadcast: (_msg: ServerMessage) => undefined,
  broadcastBlock: () => undefined,
  broadcastBlocks: () => undefined,
  recordEdit: () => undefined,
};

function findSpawn(seed: number): { x: number; y: number; z: number } {
  const gen = createGenerator('terrain', seed);
  for (let r = 0; r < 2000; r += 8) {
    const steps = Math.max(1, Math.floor((r * Math.PI * 2) / 16));
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
      const h = gen.heightAt(x, z);
      const biome = gen.biomeAt(x, z, Math.floor(h));
      if (h > 64 && h < 85 && (biome === BIOME.PLAINS || biome === BIOME.FOREST || biome === BIOME.TAIGA)) return { x: x + 0.5, y: h + 2, z: z + 0.5 };
    }
  }
  return { x: 0.5, y: 80, z: 0.5 };
}

function count(e: ServerEntities, p: { x: number; z: number }) {
  const c = { hostile: 0, passive: 0, kinds: {} as Record<string, number> };
  for (const m of e.manager.mobs) {
    if (m.removed || Math.hypot(m.x - p.x, m.z - p.z) > RADIUS) continue;
    if (m.type.hostile) c.hostile++; else c.passive++;
    c.kinds[m.type.kind] = (c.kinds[m.type.kind] ?? 0) + 1;
  }
  return c;
}

function run(seed: number, time: number, seconds: number[]) {
  const spawn = findSpawn(seed);
  const e = new ServerEntities(seed, {}, 'survival', host, () => time);
  const player = { id: 1, x: spawn.x, y: spawn.y, z: spawn.z, flags: 0, held: 0, hasPos: true };
  const out: ReturnType<typeof count>[] = [];
  let ms = 0, worst = 0;
  const ticks = Math.max(...seconds) * 20;
  for (let t = 1; t <= ticks; t++) {
    const t0 = performance.now();
    e.tick([player]);
    const d = performance.now() - t0;
    ms += d;
    worst = Math.max(worst, d);
    if (seconds.some((s) => s * 20 === t)) out.push(count(e, player));
  }
  return { out, avgMs: ms / ticks, worst };
}

const fmt = (c: ReturnType<typeof count>) => `${c.hostile}h/${c.passive}p ${JSON.stringify(c.kinds)}`;
console.log('seed | midnight 60 s | midnight 300 s | daylight 30 s | avg ms/tick (worst)');
const totals = { h60: 0, h300: 0, p: 0 };
for (let seed = 1; seed <= SEEDS; seed++) {
  const night = run(seed, 0.75, [60, 300]);
  const day = run(seed, 0.25, [30]);
  totals.h60 += night.out[0].hostile;
  totals.h300 += night.out[1].hostile;
  totals.p += day.out[0].passive;
  console.log(`${seed} | ${fmt(night.out[0])} | ${fmt(night.out[1])} | ${fmt(day.out[0])} | ${night.avgMs.toFixed(2)} (${night.worst.toFixed(1)})`);
}
console.log(`mean hostile 60 s: ${(totals.h60 / SEEDS).toFixed(1)}, 300 s: ${(totals.h300 / SEEDS).toFixed(1)}, passive in daylight: ${(totals.p / SEEDS).toFixed(1)}`);

// ---------------------------------------------------------------- AI cost: 60 mobs around 8 players
// Eight players 12 blocks apart, 60 mobs of every kind among them (spawning off), 30 s at midnight: the cost of the
// goal AI, the navigator and the A* (path searches and expanded nodes per tick) on the real server world.
{
  const { pathStats } = await import('../src/entities/ai/Pathfinder');
  const spawn = findSpawn(1);
  const e = new ServerEntities(1, {}, 'survival', host, () => 0.75);
  e.manager.hostileSpawning = false;
  e.manager.passiveSpawning = false;
  const players = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, x: spawn.x + (i % 4) * 12, y: spawn.y, z: spawn.z + Math.floor(i / 4) * 12, flags: 0, held: 0, hasPos: true,
  }));
  for (let t = 0; t < 100; t++) e.tick(players); // load the chunks
  const kinds = ['zombie', 'skeleton', 'creeper', 'spider', 'pig', 'cow', 'sheep', 'chicken', 'wolf', 'enderman', 'slime',
    'husk', 'stray', 'cave_spider', 'witch', 'horse'] as const;
  for (let i = 0; i < 60; i++) {
    const p = players[i % 8];
    const a = (i / 60) * Math.PI * 2;
    const x = p.x + Math.cos(a) * 10, z = p.z + Math.sin(a) * 10;
    let y = Math.floor(p.y) + 10;
    while (y > 1 && e.world.getBlock(Math.floor(x), y - 1, Math.floor(z)) === 0) y--;
    e.manager.spawnMob(kinds[i % kinds.length], x, y, z);
  }
  const s0 = pathStats.searches, n0 = pathStats.nodes;
  let ms = 0, worst = 0;
  const ticks = 600;
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now();
    e.tick(players);
    const d = performance.now() - t0;
    ms += d;
    worst = Math.max(worst, d);
  }
  console.log(`\nAI: ${e.manager.mobs.length} mobs, 8 players, ${ticks} ticks: ${(ms / ticks).toFixed(2)} ms/tick (worst ${worst.toFixed(1)}),`
    + ` ${((pathStats.searches - s0) / ticks).toFixed(2)} path searches/tick, ${((pathStats.nodes - n0) / ticks).toFixed(0)} nodes/tick`);
}

/**
 * Time budget of the mob hot path (npm run test:perf reads its output; the unit tests count work instead):
 *
 * - obstacles: 40 mobs on a flat test world behind rows of walls, so most of them need A* paths (tests/mobAi.test.ts).
 * - room: one survival game on the server (ServerEntities, real terrain) at midnight with 4 players 80 blocks apart,
 *   i.e. the full hostile cap plus the animal herds (tests/mobTickBudget.test.ts).
 *
 * Main-thread CPU time (process.threadCpuUsage) per tick, best of several batches, so waiting for a core on a busy
 * machine does not count.
 *
 *   npx tsx scripts/bench-mobs.ts
 */
import { EntityManager, type EntityWorld } from '../src/entities/EntityManager';
import type { MobEvents, MobTarget } from '../src/entities/Mob';
import { BLOCK } from '../src/world/BlockRegistry';
import { type EntityPlayer, ServerEntities } from '../server/ServerEntities';

let seed = 1;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const tc = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
const cpuMs = (): number => {
  const u = tc ? tc.call(process) : process.cpuUsage();
  return (u.user + u.system) / 1000;
};
EntityManager.clock = cpuMs;

/** Best mean and best p95 (ms) over `batches` batches of `ticks` calls. */
function measure(batches: number, ticks: number, fn: () => void, phase?: () => number): { mean: number; p95: number; phase: number } {
  let mean = Infinity, p95 = Infinity, ph = Infinity;
  for (let b = 0; b < batches; b++) {
    const times: number[] = [];
    let phSum = 0;
    for (let i = 0; i < ticks; i++) {
      const t0 = cpuMs();
      fn();
      times.push(cpuMs() - t0);
      if (phase) phSum += phase();
    }
    times.sort((a, c) => a - c);
    mean = Math.min(mean, times.reduce((a, c) => a + c, 0) / ticks);
    p95 = Math.min(p95, times[Math.floor(ticks * 0.95)]);
    ph = Math.min(ph, phSum / ticks);
  }
  return { mean, p95, phase: ph };
}

// ---------------------------------------------------------------- obstacles
class FlatWorld implements EntityWorld {
  readonly edits = new Map<number, number>();
  getBlock(x: number, y: number, z: number): number {
    const e = this.edits.size ? this.edits.get(((x + 512) * 1024 + (z + 512)) * 128 + y) : undefined;
    if (e !== undefined) return e;
    return y < 62 ? BLOCK.STONE : y === 62 ? BLOCK.GRASS : 0;
  }
  set(x: number, y: number, z: number, id: number): void { this.edits.set(((x + 512) * 1024 + (z + 512)) * 128 + y, id); }
  getLight(): number { return 15 << 4; }
}
const noop = () => undefined;
const events: MobEvents = {
  attack: noop, explode: noop, shoot: noop, arrowHit: noop, arrowImpact: noop, tntExplode: noop, killed: noop, playerArrowHit: noop, sound: noop,
};
const flat = new FlatWorld();
for (let x = -30; x <= 30; x += 6) for (let z = -30; z <= 30; z++) if (Math.abs(z) > 1) { flat.set(x, 63, z, BLOCK.STONE); flat.set(x, 64, z, BLOCK.STONE); }
const em = new EntityManager(flat, 1);
em.hostileSpawning = false;
em.passiveSpawning = false;
const player: MobTarget = { x: 0.5, y: 63, z: 0.5, attackable: true };
for (let i = 0; i < 40; i++) em.spawnMob(i % 2 ? 'zombie' : 'pig', -25 + (i % 10) * 5 + 0.5, 63, -20 + Math.floor(i / 10) * 10 + 0.5);
for (let i = 0; i < 40; i++) em.tick(player, 0, events, null, false);
const obstacles = measure(8, 60, () => em.tick(player, 0, events, null, false));
console.log(`obstacles (40 mobs): tick mean ${obstacles.mean.toFixed(3)} ms, p95 ${obstacles.p95.toFixed(3)} ms`);

// ---------------------------------------------------------------- room
const host = { send: noop, broadcast: noop, broadcastBlock: noop, broadcastBlocks: noop, recordEdit: noop };
const ents = new ServerEntities(4242, {}, 'survival', host, () => 0.75);
const ps: EntityPlayer[] = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, x: 0.5 + i * 80, y: 90, z: 0.5, flags: 4, held: 0, hasPos: true }));
const land = () => {
  for (const p of ps) {
    const y = ents.world.surfaceY(Math.floor(p.x), Math.floor(p.z));
    if (y >= 0) p.y = y + 1;
  }
};
for (let i = 0; i < 400; i++) { ents.tick(ps); land(); }
const roomStats = measure(6, 100, () => ents.tick(ps), () => ents.phaseMs.mobs);
console.log(`room (4 players far apart, midnight, ${ents.mobCount} mobs): tick mean ${roomStats.mean.toFixed(3)} ms, p95 ${roomStats.p95.toFixed(3)} ms, mobs mean ${roomStats.phase.toFixed(3)} ms`);
process.exit(0);

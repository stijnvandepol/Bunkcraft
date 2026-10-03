/**
 * Cost of the random tick system per game tick.
 *
 *  - singleplayer: generated terrain at render distance 12 (25 x 25 chunks), random ticks within 8 chunks
 *    (128 blocks) of the player, plus the scheduled block updates; target < 0.3 ms per tick;
 *  - server: ServerWorld around 1 and 4 players (chunk radius 3); target < 0.5 ms per player.
 *
 * Reported: CPU time per tick (robust on a busy machine) and the wall-clock distribution (p50 is the useful one when
 * other processes compete for the cores; p99/max then mostly show the OS scheduler).
 *
 * Both run long enough for grass to spread and leaves to be checked; a second pass cuts down a forest so leaf decay
 * (the most expensive rule: a small search per leaf) is part of the measurement.
 *
 *   npx tsx scripts/bench-randomticks.ts [seed]
 */
import { ServerWorld } from '../server/ServerWorld';
import { BLOCK } from '../src/world/BlockRegistry';
import { BlockUpdates } from '../src/world/BlockUpdates';
import { createRandomTicker } from '../src/world/Growth';
import { isLog } from '../src/world/PlantRules';
import type { RandomTickHost } from '../src/world/RandomTicks';
import { CHUNK_AREA, CHUNK_HEIGHT, CHUNK_VOLUME, blockIndex, chunkKey } from '../src/world/constants';
import { TerrainGenerator } from '../src/world/TerrainGenerator';

const seed = Number(process.argv[2] ?? 12345);
const RENDER = 12;

/** CPU time of this process (ms): unlike wall time it does not count the time the OS gave to other processes. */
function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

function stats(samples: number[]): string {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `avg ${avg.toFixed(3)} ms  p50 ${p(0.5).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${s[s.length - 1].toFixed(3)}`;
}

// ---------------------------------------------------------------- singleplayer-like host over generated chunks

const gen = new TerrainGenerator(seed);
const chunks = new Map<number, Uint8Array>();
const metas = new Map<number, Uint8Array>();
let changes = 0;
const t0 = performance.now();
for (let cz = -RENDER; cz <= RENDER; cz++) {
  for (let cx = -RENDER; cx <= RENDER; cx++) {
    const b = new Uint8Array(CHUNK_VOLUME);
    gen.generate(cx, cz, b, new Uint8Array(CHUNK_AREA));
    chunks.set(chunkKey(cx, cz), b);
  }
}
console.log(`generated ${chunks.size} chunks in ${(performance.now() - t0).toFixed(0)} ms (seed ${seed})`);

const getBlock = (x: number, y: number, z: number): number => {
  if (y < 0) return BLOCK.BEDROCK;
  if (y >= CHUNK_HEIGHT) return BLOCK.AIR;
  const c = chunks.get(chunkKey(x >> 4, z >> 4));
  return c ? c[blockIndex(x & 15, y, z & 15)] : BLOCK.UNLOADED;
};
const getMeta = (x: number, y: number, z: number): number => metas.get(chunkKey(x >> 4, z >> 4))?.[blockIndex(x & 15, y, z & 15)] ?? 0;
const write = (x: number, y: number, z: number, id: number, meta: number): void => {
  const key = chunkKey(x >> 4, z >> 4);
  const c = chunks.get(key);
  if (!c || y < 0 || y >= CHUNK_HEIGHT) return;
  c[blockIndex(x & 15, y, z & 15)] = id;
  let m = metas.get(key);
  if (meta && !m) { m = new Uint8Array(CHUNK_VOLUME); metas.set(key, m); }
  if (m) m[blockIndex(x & 15, y, z & 15)] = meta;
};
let updates: BlockUpdates;
const host: RandomTickHost = {
  chunkBlocks: (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null,
  getBlock, getMeta,
  // Open sky everywhere above the surface is close enough for the light checks.
  getLight: () => 0xf0,
  setState: (x, y, z, id, meta, quiet) => {
    write(x, y, z, id, meta);
    if (!quiet) { changes++; updates.notify(x, y, z); }
  },
};
updates = new BlockUpdates({ getBlock, getMeta, setState: (x, y, z, id, meta) => host.setState(x, y, z, id, meta, false) });
const ticker = createRandomTicker(host, { radius: 8, budgetMs: 1e9 });
const centre = [{ x: 0, z: 0 }];

function runSingle(label: string, ticks: number): void {
  for (let i = 0; i < 100; i++) { ticker.tick(centre); updates.tick(); }
  const samples: number[] = [];
  changes = 0;
  let handled = 0;
  const c0 = cpuMs();
  for (let i = 0; i < ticks; i++) {
    const a = performance.now();
    ticker.tick(centre);
    updates.tick();
    samples.push(performance.now() - a);
    handled += ticker.stats.handled;
  }
  const cpu = (cpuMs() - c0) / ticks;
  console.log(`singleplayer ${label.padEnd(34)} cpu ${cpu.toFixed(3)} ms/tick | wall ${stats(samples)}  (${(handled / ticks).toFixed(1)} handler calls, ${(changes / ticks).toFixed(2)} changes per tick)`);
}

runSingle('render 12, sim radius 8', 2000);
// Cut every trunk within 128 blocks: from now on every leaf hit runs the decay search and most decay.
let cut = 0;
for (let z = -128; z < 128; z++) for (let x = -128; x < 128; x++) for (let y = 60; y < 120; y++) if (isLog(getBlock(x, y, z))) { write(x, y, z, BLOCK.AIR, 0); cut++; }
console.log(`(cut ${cut} log blocks)`);
runSingle('after cutting every tree (decay)', 2000);

// ---------------------------------------------------------------- server

function runServer(players: number): void {
  const w = new ServerWorld(seed, {});
  const centres = Array.from({ length: players }, (_, i) => ({ x: i * 200, z: 0 }));
  for (let i = 0; i < 400; i++) w.update(centres);
  for (let i = 0; i < 100; i++) w.tickGrowth(centres);
  const samples: number[] = [];
  const c0 = cpuMs();
  for (let i = 0; i < 2000; i++) {
    const a = performance.now();
    w.tickGrowth(centres);
    samples.push((performance.now() - a) / players);
    w.drainSimEdits();
  }
  const cpu = (cpuMs() - c0) / 2000 / players;
  console.log(`server ${String(players).padStart(2)} player(s), per player          cpu ${cpu.toFixed(3)} ms/tick | wall ${stats(samples)}  (${w.loadedChunks} chunks loaded)`);
}

runServer(1);
runServer(4);

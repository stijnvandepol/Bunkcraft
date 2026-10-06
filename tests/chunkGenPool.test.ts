import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChunkGenPool, type GenClient, type WorkerLike, chunkWorkerCount } from '../server/chunkgen/ChunkGenPool';
import { type GenSpec, type GeneratedChunk, generateChunk } from '../server/chunkgen/genChunk';
import type { GenRequest, GenResponse } from '../server/chunkgen/protocol';
import { ServerWorld } from '../server/ServerWorld';
import { MAP_IDS } from '../src/modes/maps';
import { BLOCK, LIGHT_EMIT, OPAQUE } from '../src/world/BlockRegistry';
import { packState } from '../src/world/BlockStates';
import { type WorldType, arenaWorldType, createGenerator } from '../src/world/WorldGenerator';
import { CHUNK_HEIGHT, CHUNK_VOLUME, chunkKey } from '../src/world/constants';
import { fnv1a } from './helpers';
import { GOLDEN_SEED, GOLDEN_V1, GOLDEN_V2, GOLDEN_V3 } from './helpers/goldenChunks';

/** A client that turns one pool request into a promise. */
function requestChunk(pool: ChunkGenPool, spec: GenSpec, cx: number, cz: number): Promise<GeneratedChunk> {
  return new Promise((resolve, reject) => {
    const client: GenClient = {
      genSpec: spec,
      chunkGenerated: (_x, _z, _k, c) => resolve(c),
      chunkDropped: (_x, _z, _k, failed) => reject(new Error(`dropped (failed: ${failed})`)),
    };
    if (!pool.request(client, cx, cz, chunkKey(cx, cz), 0)) reject(new Error('refused'));
  });
}

/** What ServerWorld computed before the worker pool existed (generate, then scan the finished chunk). */
function reference(type: WorldType, seed: number, version: number, cx: number, cz: number): GeneratedChunk {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  const meta = createGenerator(type, seed, version).generate(cx, cz, blocks) ?? null;
  const tops = new Int16Array(256);
  for (let col = 0; col < 256; col++) {
    let y = CHUNK_HEIGHT - 1;
    while (y >= 0 && !OPAQUE[blocks[col | (y << 8)]]) y--;
    tops[col] = y;
  }
  const em: number[] = [];
  for (let i = 0; i < CHUNK_VOLUME; i++) if (LIGHT_EMIT[blocks[i]] > 0) em.push(i);
  return { blocks, meta, tops, emitters: Int32Array.from(em) };
}

function expectSame(a: GeneratedChunk, b: GeneratedChunk): void {
  expect(fnv1a(a.blocks)).toBe(fnv1a(b.blocks));
  expect(a.blocks).toEqual(b.blocks);
  expect(a.meta === null).toBe(b.meta === null);
  if (a.meta && b.meta) expect(a.meta).toEqual(b.meta);
  expect(a.tops).toEqual(b.tops);
  expect(a.emitters).toEqual(b.emitters);
}

describe('worker-thread chunk generation (real workers)', () => {
  let pool: ChunkGenPool;
  beforeAll(() => { pool = new ChunkGenPool({ size: 2 }); });
  afterAll(async () => { await pool.close(); });

  const goldens: [number, [number, number, number, number][]][] = [[1, GOLDEN_V1], [2, GOLDEN_V2], [3, GOLDEN_V3]];
  it.each(goldens)('genVersion %i: the workers produce the golden chunks', async (version, golden) => {
    const spec: GenSpec = { worldType: 'terrain', seed: GOLDEN_SEED, genVersion: version };
    const chunks = await Promise.all(golden.map(([cx, cz]) => requestChunk(pool, spec, cx, cz)));
    golden.forEach(([cx, cz, hash], i) => {
      expect(fnv1a(chunks[i].blocks)).toBe(hash);
      expectSame(chunks[i], reference('terrain', GOLDEN_SEED, version, cx, cz));
    });
  });

  it('is byte-identical to the main thread for every version, many chunks and several seeds', async () => {
    const jobs: { spec: GenSpec; cx: number; cz: number }[] = [];
    for (const genVersion of [1, 2, 3]) {
      for (const seed of [1, 777, 0xdeadbeef]) {
        for (let k = 0; k < 6; k++) jobs.push({ spec: { worldType: 'terrain', seed, genVersion }, cx: k * 7 - 20, cz: 13 - k * 5 });
      }
    }
    const out = await Promise.all(jobs.map((j) => requestChunk(pool, j.spec, j.cx, j.cz)));
    const gens = new Map<string, ReturnType<typeof createGenerator>>();
    jobs.forEach((j, i) => {
      const id = `${j.spec.seed}/${j.spec.genVersion}`;
      if (!gens.has(id)) gens.set(id, createGenerator('terrain', j.spec.seed, j.spec.genVersion));
      expectSame(out[i], generateChunk(gens.get(id)!, j.cx, j.cz));
    });
    expect(pool.getStats().generated).toBeGreaterThanOrEqual(jobs.length);
  });

  it('builds the same arcade arenas', async () => {
    const jobs = MAP_IDS.flatMap((map) => [[-3, -3], [0, 0], [2, 1]].map(([cx, cz]) => ({ type: arenaWorldType(map), cx, cz })));
    const out = await Promise.all(jobs.map((j) => requestChunk(pool, { worldType: j.type, seed: 5, genVersion: 3 }, j.cx, j.cz)));
    jobs.forEach((j, i) => expectSame(out[i], reference(j.type, 5, 3, j.cx, j.cz)));
  });

  it('gives a ServerWorld exactly the world of the synchronous path, edits and light included', async () => {
    const edits: Record<string, number> = {
      '3,100,3': packState(BLOCK.GLASS, 6), '4,90,4': BLOCK.STONE, '20,70,-5': BLOCK.TORCH, '21,71,-5': BLOCK.GLOWSTONE,
      '-30,64,40': BLOCK.WATER | (2 << 8), '5,3,5': BLOCK.AIR, '40,80,40': BLOCK.LAVA,
    };
    for (const genVersion of [1, 3]) {
      const sync = new ServerWorld(99, edits, 'terrain', genVersion);
      const async = new ServerWorld(99, edits, 'terrain', genVersion, pool);
      const centers = [{ x: 0, z: 0 }, { x: 40, z: 40 }];
      for (let i = 0; i < 200 && sync.loadedChunks < 120; i++) sync.update(centers);
      for (let i = 0; i < 400 && (async.loadedChunks < sync.loadedChunks || async.pendingChunks > 0); i++) {
        async.update(centers);
        await new Promise((r) => setTimeout(r, 2));
      }
      expect(async.loadedChunks).toBe(sync.loadedChunks);
      for (let x = -50; x < 70; x += 3) {
        for (let z = -50; z < 70; z += 5) {
          for (let y = 0; y < CHUNK_HEIGHT; y += 1) {
            if (async.getBlock(x, y, z) !== sync.getBlock(x, y, z) || async.getMeta(x, y, z) !== sync.getMeta(x, y, z)) {
              throw new Error(`differs at ${x},${y},${z}`);
            }
          }
          expect(async.surfaceY(x, z)).toBe(sync.surfaceY(x, z));
          for (const y of [40, 64, 70, 71, 90, 100]) expect(async.getLight(x, y, z)).toBe(sync.getLight(x, y, z));
        }
      }
      expect(async.getLight(20, 72, -5)).toBe(sync.getLight(20, 72, -5));
      expect(async.getLight(20, 72, -5) & 15).toBeGreaterThan(0);
      async.dispose();
    }
  });
});

/** A worker the test answers by hand: records what it was sent. */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  readonly got: GenRequest[] = [];
  terminated = false;
  private handlers: Record<string, ((v: never) => void)[]> = {};
  constructor() { FakeWorker.all.push(this); }
  postMessage(msg: GenRequest): void { this.got.push(msg); }
  on(event: string, fn: (v: never) => void): this { (this.handlers[event] ??= []).push(fn); return this; }
  emit(event: string, v: unknown): void { for (const fn of this.handlers[event] ?? []) fn(v as never); }
  terminate(): Promise<number> { this.terminated = true; return Promise.resolve(0); }
  ref(): void {}
  unref(): void {}
  /** Answers the oldest open request. */
  answer(): GenRequest {
    const req = this.got.shift()!;
    const res: GenResponse = { id: req.id, blocks: new Uint8Array(1), meta: null, tops: new Int16Array(1), emitters: new Int32Array(0), ms: 1 };
    this.emit('message', res);
    return req;
  }
}

function recorder(name = 'w'): GenClient & { done: string[]; dropped: string[] } {
  const done: string[] = [], dropped: string[] = [];
  return {
    genSpec: { worldType: 'terrain', seed: name.length, genVersion: 3 },
    done, dropped,
    chunkGenerated: (cx, cz) => { done.push(`${name}:${cx},${cz}`); },
    chunkDropped: (cx, cz, _k, failed) => { dropped.push(`${name}:${cx},${cz}${failed ? '!' : ''}`); },
  };
}

function fakePool(opts: { size?: number; maxQueue?: number; perWorker?: number } = {}): { pool: ChunkGenPool; workers: FakeWorker[] } {
  FakeWorker.all = [];
  const pool = new ChunkGenPool({ size: opts.size ?? 1, maxQueue: opts.maxQueue, perWorker: opts.perWorker ?? 1, spawn: () => new FakeWorker() });
  return { pool, workers: FakeWorker.all };
}

const req = (pool: ChunkGenPool, c: GenClient, cx: number, cz: number, prio: number) => pool.request(c, cx, cz, chunkKey(cx, cz), prio);

describe('ChunkGenPool scheduling', () => {
  it('sends the nearest chunks first, in request order within a ring', () => {
    const { pool, workers: [w] } = fakePool();
    const a = recorder('a');
    req(pool, a, 0, 0, 3); // goes straight out: the worker was idle
    req(pool, a, 1, 0, 3);
    req(pool, a, 2, 0, 1);
    req(pool, a, 3, 0, 0);
    req(pool, a, 4, 0, 1);
    req(pool, a, 5, 0, 0);
    const order: string[] = [];
    while (w.got.length) { const r = w.answer(); order.push(`${r.cx}`); }
    expect(order).toEqual(['0', '3', '5', '2', '4', '1']);
    expect(a.done).toHaveLength(6);
  });

  it('keeps one request per world and chunk, moving it up when a nearer player asks', () => {
    const { pool, workers: [w] } = fakePool();
    const a = recorder('a'), b = recorder('bb');
    req(pool, a, 9, 9, 0); // in flight
    req(pool, a, 1, 1, 4);
    req(pool, a, 2, 2, 2);
    expect(req(pool, a, 1, 1, 4)).toBe(true); // duplicate: no second job
    req(pool, a, 1, 1, 0); // nearer now: overtakes 2,2
    req(pool, b, 1, 1, 3); // another world, same coordinates: its own job
    expect(pool.getStats().queued).toBe(3);
    expect(req(pool, a, 9, 9, 0)).toBe(true); // in flight: left alone
    const order: string[] = [];
    while (w.got.length) { const r = w.answer(); order.push(`${r.seed}:${r.cx}`); }
    expect(order).toEqual(['1:9', '1:1', '1:2', '2:1']);
    expect(a.done).toEqual(['a:9,9', 'a:1,1', 'a:2,2']);
    expect(b.done).toEqual(['bb:1,1']);
  });

  it('cancels queued and in-flight requests (the result of an in-flight one is thrown away)', () => {
    const { pool, workers: [w] } = fakePool();
    const a = recorder('a');
    req(pool, a, 0, 0, 0);
    req(pool, a, 1, 0, 0);
    req(pool, a, 2, 0, 0);
    pool.cancel(a, chunkKey(0, 0)); // in flight
    pool.cancel(a, chunkKey(1, 0)); // queued
    expect(pool.pending(a, chunkKey(0, 0))).toBe(false);
    while (w.got.length) w.answer();
    expect(a.done).toEqual(['a:2,0']);
    req(pool, a, 5, 5, 0);
    req(pool, a, 6, 6, 0);
    pool.cancelAll(a);
    while (w.got.length) w.answer();
    expect(a.done).toEqual(['a:2,0']);
    expect(pool.getStats()).toMatchObject({ queued: 0, inFlight: 0 });
  });

  it('bounds the queue: nearer chunks push out the farthest, farther ones are refused', () => {
    const { pool, workers: [w] } = fakePool({ maxQueue: 3 });
    const a = recorder('a');
    req(pool, a, 0, 0, 0); // in flight, not counted
    expect(req(pool, a, 1, 0, 2)).toBe(true);
    expect(req(pool, a, 2, 0, 4)).toBe(true);
    expect(req(pool, a, 3, 0, 4)).toBe(true);
    expect(req(pool, a, 4, 0, 4)).toBe(false); // full, nothing farther than 4
    expect(req(pool, a, 5, 0, 1)).toBe(true); // pushes out the newest of ring 4
    expect(a.dropped).toEqual(['a:3,0']);
    expect(pool.getStats()).toMatchObject({ queued: 3, dropped: 1 });
    const order: number[] = [];
    while (w.got.length) order.push(w.answer().cx);
    expect(order).toEqual([0, 5, 1, 2]);
  });

  it('spreads work over the workers, a few requests each', () => {
    const { pool, workers } = fakePool({ size: 2, perWorker: 2 });
    const a = recorder('a');
    for (let i = 0; i < 7; i++) req(pool, a, i, 0, 0);
    expect(workers.map((w) => w.got.length)).toEqual([2, 2]);
    expect(pool.getStats()).toMatchObject({ queued: 3, inFlight: 4 });
    workers[1].answer();
    expect(workers[1].got.length).toBe(2);
  });

  it('replaces a crashed worker and gives it the lost requests first', () => {
    const errors: string[] = [];
    FakeWorker.all = [];
    const pool = new ChunkGenPool({ size: 1, perWorker: 1, spawn: () => new FakeWorker(), onError: (m) => errors.push(m) });
    const a = recorder('a');
    req(pool, a, 0, 0, 2);
    req(pool, a, 1, 0, 2);
    FakeWorker.all[0].emit('error', new Error('boom'));
    expect(errors[0]).toMatch(/boom/);
    expect(FakeWorker.all[0].terminated).toBe(true);
    const fresh = FakeWorker.all[1];
    expect(fresh.got.map((r) => r.cx)).toEqual([0]);
    fresh.answer();
    fresh.answer();
    expect(a.done).toEqual(['a:0,0', 'a:1,0']);
    expect(pool.usable).toBe(true);
  });

  it('a failed chunk goes back to its world, which then makes it itself', () => {
    const { pool, workers: [w] } = fakePool();
    const a = recorder('a');
    req(pool, a, 0, 0, 0);
    const r = w.got.shift()!;
    w.emit('message', { id: r.id, error: 'bad', ms: 0 } satisfies GenResponse);
    expect(a.dropped).toEqual(['a:0,0!']);
    expect(pool.getStats().failed).toBe(1);
  });

  it('reads CHUNK_WORKERS: default min(2, cores − 1), 0 = main thread', () => {
    expect(chunkWorkerCount(undefined, 8)).toBe(2);
    expect(chunkWorkerCount(undefined, 2)).toBe(1);
    expect(chunkWorkerCount(undefined, 1)).toBe(0);
    expect(chunkWorkerCount('', 8)).toBe(2);
    expect(chunkWorkerCount('0', 8)).toBe(0);
    expect(chunkWorkerCount('4', 8)).toBe(4);
    expect(chunkWorkerCount('-3', 8)).toBe(0);
    expect(chunkWorkerCount('lots', 8)).toBe(2);
  });
});

describe('ChunkGenPool shutdown', () => {
  it('terminates its threads, refuses new work and lets worlds fall back to the main thread', async () => {
    const pool = new ChunkGenPool({ size: 2 });
    const w = new ServerWorld(4, {}, 'terrain', 3, pool);
    w.update([{ x: 0, z: 0 }]);
    expect(w.pendingChunks).toBeGreaterThan(0);
    const threads = (pool as unknown as { slots: { worker: { threadId: number; once(e: 'exit', f: () => void): void } }[] }).slots.map((s) => s.worker);
    const exits = threads.map((t) => new Promise<void>((r) => t.once('exit', r)));
    await pool.close();
    await Promise.all(exits);
    expect(pool.usable).toBe(false);
    expect(req(pool, recorder(), 0, 0, 0)).toBe(false);
    // The world notices and generates on its own thread (a couple per update, like before the pool).
    for (let i = 0; i < 60; i++) w.update([{ x: 0, z: 0 }]);
    expect(w.pendingChunks).toBe(0);
    expect(w.loadedChunks).toBe(81);
  });

  it('a world that goes away drops its outstanding requests', () => {
    const { pool } = fakePool();
    const w = new ServerWorld(4, {}, 'terrain', 3, pool);
    w.update([{ x: 0, z: 0 }]);
    expect(pool.getStats().queued).toBe(80);
    w.dispose();
    expect(pool.getStats()).toMatchObject({ queued: 0 });
    expect(w.pendingChunks).toBe(0);
  });
});

describe('ServerWorld with a worker pool', () => {
  /** A pool whose fake worker generates for real, on demand (deterministic timing). */
  function realisticPool(): { pool: ChunkGenPool; run: (n?: number) => number } {
    FakeWorker.all = [];
    const pool = new ChunkGenPool({ size: 1, perWorker: 1, spawn: () => new FakeWorker() });
    const run = (n = Infinity): number => {
      let k = 0;
      const w = FakeWorker.all[0];
      while (k < n && w.got.length) {
        const r = w.got.shift()!;
        const c = generateChunk(createGenerator(r.worldType, r.seed, r.genVersion), r.cx, r.cz);
        w.emit('message', { id: r.id, ...c, ms: 0 } satisfies GenResponse);
        k++;
      }
      return k;
    };
    return { pool, run };
  }

  it('requests the whole area nearest-first and treats missing chunks as UNLOADED until they are installed', () => {
    const { pool, run } = realisticPool();
    const w = new ServerWorld(8, {}, 'terrain', 3, pool);
    w.update([{ x: 8, z: 8 }]);
    expect(w.loadedChunks).toBe(0);
    expect(w.getBlock(8, 60, 8)).toBe(BLOCK.UNLOADED);
    const first = FakeWorker.all[0].got[0];
    expect([first.cx, first.cz]).toEqual([0, 0]);
    run(1);
    expect(w.getBlock(8, 60, 8)).toBe(BLOCK.UNLOADED); // arrived, goes in at the next update (inside a tick)
    w.update([{ x: 8, z: 8 }]);
    expect(w.hasChunk(0, 0)).toBe(true);
    expect(w.getBlock(8, 0, 8)).not.toBe(BLOCK.UNLOADED);
    // The 8 neighbours (ring 1) come before ring 2.
    run(8);
    w.update([{ x: 8, z: 8 }]);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) expect(w.hasChunk(dx, dz)).toBe(true);
    run();
    for (let i = 0; i < 12; i++) w.update([{ x: 8, z: 8 }]);
    expect(w.loadedChunks).toBe(81);
    expect(w.pendingChunks).toBe(0);
  });

  it('cancels what the players walked away from and never installs it', () => {
    const { pool, run } = realisticPool();
    const w = new ServerWorld(8, {}, 'terrain', 3, pool);
    w.update([{ x: 0, z: 0 }]);
    run(3);
    w.update([{ x: 5000, z: 5000 }]); // teleported far away
    expect(pool.pending(w, chunkKey(4, 4))).toBe(false);
    run();
    for (let i = 0; i < 12; i++) w.update([{ x: 5000, z: 5000 }]);
    expect(w.hasChunk(0, 0)).toBe(false);
    expect(w.hasChunk(312, 312)).toBe(true);
  });

  it('ensureChunk makes a missing chunk at once (a block edit next to a player who just arrived)', () => {
    const { pool, run } = realisticPool();
    const sync = new ServerWorld(8, { '20,64,20': BLOCK.GLOWSTONE }, 'terrain', 3);
    const w = new ServerWorld(8, { '20,64,20': BLOCK.GLOWSTONE }, 'terrain', 3, pool);
    w.update([{ x: 20, z: 20 }]);
    expect(w.getBlock(20, 64, 20)).toBe(BLOCK.UNLOADED);
    w.ensureChunk(20, 20);
    expect(w.getBlock(20, 64, 20)).toBe(BLOCK.GLOWSTONE);
    expect(pool.pending(w, chunkKey(1, 1))).toBe(false);
    run();
    w.update([{ x: 20, z: 20 }]);
    sync.ensureChunk(20, 20);
    for (let y = 0; y < CHUNK_HEIGHT; y++) expect(w.getBlock(17, y, 30)).toBe(sync.getBlock(17, y, 30));
    expect(w.getLight(20, 65, 21)).toBe(sync.getLight(20, 65, 21));
  });

  it('a chunk a worker failed on is generated on the main thread', () => {
    FakeWorker.all = [];
    const pool = new ChunkGenPool({ size: 1, perWorker: 100, spawn: () => new FakeWorker() });
    const w = new ServerWorld(8, {}, 'terrain', 3, pool);
    w.update([{ x: 0, z: 0 }]);
    const fw = FakeWorker.all[0];
    const r = fw.got.shift()!;
    fw.emit('message', { id: r.id, error: 'boom', ms: 0 } satisfies GenResponse);
    w.update([{ x: 0, z: 0 }]);
    expect(w.hasChunk(r.cx, r.cz)).toBe(true);
  });
});

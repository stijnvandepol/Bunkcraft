import { describe, expect, it } from 'vitest';
import { pathStats } from '../src/entities/ai/Pathfinder';
import { EntityManager } from '../src/entities/EntityManager';
import { capAreas } from '../src/entities/MobSpawner';
import type { MobTarget } from '../src/entities/Mob';
import type { MobEntry, ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { chunkKey } from '../src/world/constants';
import { type EntityPlayer, ServerEntities } from '../server/ServerEntities';
import { ServerWorld } from '../server/ServerWorld';
import { useSeededRandom } from './helpers/seededRandom';
import { TIME_SLACK } from './helpers/timing';

/**
 * The server's mob hot path (see docs/research/SERVER-DEPLOY.md §2.7): per-tick path-finding allowance, the shortcuts
 * that must give the same answers as the plain code, and a CPU budget for a full survival room at night.
 */
useSeededRandom();

function room(time = 0.75) {
  const sent: { to: number; msg: ServerMessage }[] = [];
  const host = {
    send: (to: number, msg: ServerMessage) => { sent.push({ to, msg }); },
    broadcast: () => undefined,
    broadcastBlock: () => undefined,
    broadcastBlocks: () => undefined,
    recordEdit: () => undefined,
  };
  const ents = new ServerEntities(4242, {}, 'survival', host, () => time);
  return { ents, sent };
}

function players(n: number, spread: number): EntityPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, x: 0.5 + (i % 4) * spread, y: 90, z: 0.5 + Math.floor(i / 4) * spread, flags: 4, held: 0, hasPos: true,
  }));
}

/** Puts every player on the ground once the chunks are there. */
function land(ents: ServerEntities, ps: EntityPlayer[]): void {
  for (const p of ps) {
    const y = ents.world.surfaceY(Math.floor(p.x), Math.floor(p.z));
    if (y >= 0) p.y = y + 1;
  }
}

describe('path finding allowance per tick', () => {
  it('a tick never expands more A* nodes or starts more searches than allowed, and the searches still happen', () => {
    const { ents } = room();
    const ps = players(8, 24);
    for (let i = 0; i < 80; i++) { ents.tick(ps); land(ents, ps); }
    // Many mobs that all want a path at once: zombies chasing the players over uneven ground.
    for (let i = 0; i < 90; i++) {
      const p = ps[i % ps.length];
      const x = Math.floor(p.x + 10 + (i % 7) * 2), z = Math.floor(p.z - 10 + (i % 5) * 3);
      const y = ents.world.surfaceY(x, z);
      if (y >= 0) ents.manager.spawnMob('zombie', x + 0.5, y + 1, z + 0.5);
    }
    let maxNodes = 0, maxSearches = 0, total = 0;
    for (let t = 0; t < 200; t++) {
      const n0 = pathStats.nodes, s0 = pathStats.searches;
      ents.tick(ps);
      maxNodes = Math.max(maxNodes, pathStats.nodes - n0);
      maxSearches = Math.max(maxSearches, pathStats.searches - s0);
      total += pathStats.searches - s0;
    }
    expect(maxNodes).toBeLessThanOrEqual(EntityManager.PATH_NODES_PER_TICK);
    expect(maxSearches).toBeLessThanOrEqual(EntityManager.PATHS_PER_TICK);
    expect(total).toBeGreaterThan(100); // the allowance spreads the work, it does not stop it
  });
});

describe('shortcuts give the same answers', () => {
  it('the chunk lookup cache matches the chunk map, also while chunks load and unload', () => {
    const w = new ServerWorld(99, {});
    const chunks = (w as unknown as { chunks: Map<number, { blocks: Uint8Array }> }).chunks;
    let rng = 11;
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
    for (let step = 0; step < 120; step++) {
      // A player walking away and back: chunks come and go under the cache.
      const px = step < 60 ? step * 4 : (120 - step) * 4;
      w.update([{ x: px, z: 0 }]);
      for (let k = 0; k < 300; k++) {
        const x = px + rand(200) - 100, y = rand(128), z = rand(200) - 100;
        const c = chunks.get(chunkKey(x >> 4, z >> 4));
        const want = c ? c.blocks[(x & 15) | ((z & 15) << 4) | (y << 8)] : BLOCK.UNLOADED;
        expect(w.getBlock(x, y, z)).toBe(want);
      }
    }
  });

  it('the cached mob cap area count follows players into other chunks', () => {
    const em = new EntityManager({ getBlock: () => 0, getLight: () => 0 }, 1);
    const spawner = (em as unknown as { spawner: { areas(t: readonly MobTarget[]): number } }).spawner;
    const ts: MobTarget[] = [{ x: 0, y: 64, z: 0, attackable: true }, { x: 5, y: 64, z: 5, attackable: true }];
    for (let step = 0; step < 400; step++) {
      ts[1].x += 0.9; // walks away from the first player, through many chunks
      if (step === 200) ts.push({ x: -300, y: 64, z: 40, attackable: true });
      if (step === 300) ts.shift();
      expect(spawner.areas(ts)).toBe(capAreas(ts));
    }
  });

  it('snapshots share one entry per mob between the players and keep the send radius', () => {
    const { ents, sent } = room();
    const ps = players(3, 30);
    for (let i = 0; i < 60; i++) { ents.tick(ps); land(ents, ps); }
    for (let i = 0; i < 12; i++) ents.manager.spawnMob('cow', ps[0].x + i * 9, ps[0].y, ps[0].z + 3);
    sent.length = 0;
    ents.tick(ps);
    ents.tick(ps);
    const frames = new Map<number, MobEntry[]>();
    for (const { to, msg } of sent) if (msg.t === 'ent') frames.set(to, msg.m);
    expect(frames.size).toBe(3);
    const byId = new Map<number, MobEntry>();
    for (const p of ps) {
      const m = frames.get(p.id)!;
      const want = ents.manager.mobs.filter((e) => !e.removed && Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) <= 64).map((e) => e.netId);
      expect(m.map((e) => e[0])).toEqual(want);
      for (const e of m) {
        const seen = byId.get(e[0]);
        if (seen) expect(e).toBe(seen); // the same array, not a copy per player
        else byId.set(e[0], e);
      }
    }
  });
});

describe('CPU budget of a survival room at night', () => {
  // Measured 0.4 ms (mobs 0.3 ms) on an M1 Pro; the limits leave room for slower machines but catch a hot path that
  // starts scanning all pairs or searching paths without limit.
  it('4 players far apart with the full hostile cap tick in under 1 ms (mobs under 0.6 ms)', () => {
    const { ents } = room();
    const ps = players(4, 80);
    // Chunks load, mobs spawn up to the cap (hostiles at midnight, herds with the chunks).
    for (let i = 0; i < 400; i++) { ents.tick(ps); land(ents, ps); }
    expect(ents.mobCount).toBeGreaterThan(50);
    // Best of several batches: other processes on the machine only ever make a batch slower.
    let best = Infinity, bestMobs = Infinity;
    for (let b = 0; b < 6; b++) {
      let mobs = 0;
      const t0 = performance.now();
      for (let i = 0; i < 40; i++) { ents.tick(ps); mobs += ents.phaseMs.mobs; }
      best = Math.min(best, (performance.now() - t0) / 40);
      bestMobs = Math.min(bestMobs, mobs / 40);
    }
    expect(bestMobs).toBeLessThan(0.6 * TIME_SLACK);
    expect(best).toBeLessThan(1 * TIME_SLACK);
  }, 120_000);
});

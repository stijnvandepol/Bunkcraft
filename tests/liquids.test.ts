import { describe, expect, it } from 'vitest';
import { ITEM } from '../src/items/ItemRegistry';
import { RECIPES } from '../src/items/Recipes';
import { ChunkMesher, type GeometryData } from '../src/rendering/ChunkMesher';
import { BLOCK } from '../src/world/BlockRegistry';
import { CHUNK_AREA, CHUNK_VOLUME, blockIndex, chunkKey as chunkKeyOf } from '../src/world/constants';
import { resolveBucketTarget } from '../src/world/Placement';
import { emptyChunk, makeTestWorld, setLocal } from './helpers';
import {
  FALLING_BIT, type LiquidGrid, LiquidSim, MAX_CHANGES_PER_TICK, MAX_PENDING, isLiquid, liquidAmount, liquidHeight, liquidMeta,
} from '../src/world/Liquids';

const W = BLOCK.WATER, L = BLOCK.LAVA, AIR = BLOCK.AIR, STONE = BLOCK.STONE;

/** An open flat world: stone at y <= 0, air above; edits are kept in a map. Out of the 0..127 range reads as air/stone. */
class FakeGrid implements LiquidGrid {
  readonly cells = new Map<string, [number, number]>();
  sim!: LiquidSim;
  changes = 0;
  /** y of the top of the floor; blocks at y <= floor are stone unless overridden. */
  constructor(readonly floor = 0) {}

  private k(x: number, y: number, z: number): string { return `${x},${y},${z}`; }
  getBlock(x: number, y: number, z: number): number {
    return this.cells.get(this.k(x, y, z))?.[0] ?? (y <= this.floor ? STONE : AIR);
  }
  getMeta(x: number, y: number, z: number): number { return this.cells.get(this.k(x, y, z))?.[1] ?? 0; }
  setState(x: number, y: number, z: number, id: number, meta: number): void {
    this.cells.set(this.k(x, y, z), [id, meta]);
    this.changes++;
    this.sim.notify(x, y, z);
  }
  /** A player edit (placing a block or a bucket of liquid). */
  place(x: number, y: number, z: number, id: number, meta = 0): void { this.setState(x, y, z, id, meta); }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells.set(this.k(x, y, z), [id, 0]);
  }
  amount(x: number, y: number, z: number): number {
    const id = this.getBlock(x, y, z);
    return isLiquid(id) ? liquidAmount(this.getMeta(x, y, z)) : 0;
  }
}

function setup(floor = 0): { g: FakeGrid; sim: LiquidSim } {
  const g = new FakeGrid(floor);
  const sim = new LiquidSim(g);
  g.sim = sim;
  return { g, sim };
}

/** Ticks until nothing is scheduled (or the tick limit), returns the number of ticks used. */
function settle(sim: LiquidSim, limit = 2000): number {
  let n = 0;
  while (sim.pendingCount > 0 && n < limit) { sim.tick(); n++; }
  return n;
}

describe('liquid state', () => {
  it('maps the level byte to amount, falling and height', () => {
    expect(liquidAmount(0)).toBe(8);
    expect(liquidAmount(1)).toBe(7);
    expect(liquidAmount(7)).toBe(1);
    expect(liquidAmount(FALLING_BIT)).toBe(8);
    expect(liquidMeta(8, false)).toBe(0);
    expect(liquidMeta(3, false)).toBe(5);
    expect(liquidMeta(8, true)).toBe(FALLING_BIT);
    expect(liquidHeight(0)).toBeCloseTo(8 / 9, 9);
    expect(liquidHeight(7)).toBeCloseTo(1 / 9, 9);
  });
});

describe('water flow', () => {
  it('does nothing until it is disturbed, then spreads at one block per 5 ticks', () => {
    const { g, sim } = setup();
    g.cells.set('0,1,0', [W, 0]); // natural water: never scheduled
    expect(sim.pendingCount).toBe(0);
    for (let i = 0; i < 20; i++) sim.tick();
    expect(g.getBlock(1, 1, 0)).toBe(AIR);
    // A bucket of water: the source is placed and notified.
    const { g: g2, sim: sim2 } = setup();
    g2.place(0, 1, 0, W);
    for (let i = 0; i < 4; i++) sim2.tick();
    expect(g2.getBlock(1, 1, 0)).toBe(AIR); // nothing before tick 5
    sim2.tick(); // the 5th tick
    expect(g2.getBlock(1, 1, 0)).toBe(W);
    expect(g2.getMeta(1, 1, 0)).toBe(1); // amount 7
  });

  it('spreads up to 7 blocks on a flat floor, decaying by 1 per block', () => {
    const { g, sim } = setup();
    g.place(0, 1, 0, W);
    settle(sim);
    for (let d = 0; d <= 7; d++) {
      expect(g.amount(d, 1, 0)).toBe(8 - d);
      expect(g.amount(0, 1, d)).toBe(8 - d);
      expect(g.amount(-d, 1, 0)).toBe(8 - d);
    }
    expect(g.amount(8, 1, 0)).toBe(0);
    // Diagonals follow the Manhattan distance.
    expect(g.amount(3, 1, 3)).toBe(2);
    expect(g.amount(4, 1, 4)).toBe(0);
    // The source itself is untouched.
    expect(g.getMeta(0, 1, 0)).toBe(0);
  });

  it('falls straight down a shaft as full-height falling water, then spreads on the floor', () => {
    const { g, sim } = setup();
    // A 1×1 shaft of stone from y = 2 up to 7; below it the floor is open.
    for (let y = 2; y <= 7; y++) for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.cells.set(`${x},${y},${z}`, [STONE, 0]);
    g.place(0, 7, 0, W);
    settle(sim);
    for (let y = 1; y <= 6; y++) {
      expect(g.getBlock(0, y, 0)).toBe(W);
      expect(g.getMeta(0, y, 0)).toBe(FALLING_BIT);
    }
    // At the floor it flows out: first ring is amount 7 (level 1).
    expect(g.getMeta(1, 1, 0)).toBe(1);
    expect(g.amount(7, 1, 0)).toBe(1);
    expect(g.amount(8, 1, 0)).toBe(0);
  });

  it('lets a source in mid-air spread at its own level while its water falls (like Minecraft)', () => {
    const { g, sim } = setup();
    g.place(0, 6, 0, W);
    settle(sim);
    expect(g.getMeta(0, 5, 0)).toBe(FALLING_BIT);
    expect(g.getMeta(1, 6, 0)).toBe(1); // flowing at the source's level
    expect(g.getMeta(1, 5, 0)).toBe(FALLING_BIT); // and falling from there
  });

  it('dries up when the source is removed, from the edges inwards', () => {
    const { g, sim } = setup();
    g.place(0, 1, 0, W);
    settle(sim);
    expect(g.amount(5, 1, 0)).toBe(3);
    g.place(0, 1, 0, AIR); // the player scoops the source
    settle(sim);
    let water = 0;
    for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) if (g.getBlock(x, 1, z) === W) water++;
    expect(water).toBe(0);
  });

  it('makes an infinite source from two sources next to a gap over a solid floor', () => {
    const { g, sim } = setup();
    g.place(0, 1, 0, W);
    g.place(2, 1, 0, W);
    settle(sim);
    // The cell between them is flowing water that has two source neighbours: it becomes a source.
    expect(g.getBlock(1, 1, 0)).toBe(W);
    expect(g.getMeta(1, 1, 0)).toBe(0);
    // And it stays when one original source is taken away.
    g.place(0, 1, 0, AIR);
    settle(sim);
    expect(g.getMeta(1, 1, 0)).toBe(0);
  });

  it('does not make a source without a floor: the water between two sources over air falls instead', () => {
    const { g, sim } = setup();
    // A pit one block deep and a block wide at x = 1, between two sources on the floor at y = 2.
    g.fill(-3, 1, -3, 5, 1, 3, STONE);
    g.cells.delete('1,1,0');
    g.fill(-3, 0, -3, 5, 0, 3, STONE);
    g.place(0, 2, 0, W);
    g.place(2, 2, 0, W);
    settle(sim);
    // The cell at (1, 2, 0) has two sources next to it but air (the pit) below: no source there, it is falling water.
    expect(g.getBlock(1, 2, 0)).toBe(W);
    expect(g.getMeta(1, 2, 0)).not.toBe(0);
    expect(g.getBlock(1, 1, 0)).toBe(W);
  });

  it('goes round obstacles towards a drop within 4 blocks', () => {
    const { g, sim } = setup(0);
    // A floor at y = 1 with a hole at x = 3: water at x = 0 flows towards the hole first.
    g.fill(-6, 1, -6, 6, 1, 6, STONE);
    g.cells.delete('3,1,0');
    g.place(0, 2, 0, W);
    settle(sim);
    expect(g.getBlock(3, 1, 0)).toBe(W); // fell into the hole
    expect(g.getMeta(3, 1, 0)).toBe(FALLING_BIT);
    expect(g.getBlock(1, 2, 0)).toBe(W);
    // The directions away from the hole got water only later and thinner (or none within 1 tick): at least the way
    // to the hole is wet.
    expect(g.amount(2, 2, 0)).toBeGreaterThan(0);
  });

  it('washes plants and torches away, and reports them', () => {
    const { g, sim } = setup();
    const destroyed: number[][] = [];
    sim.onDestroyed = (x, y, z, id) => destroyed.push([x, y, z, id]);
    g.cells.set('1,1,0', [BLOCK.TORCH, 0]);
    g.cells.set('0,1,1', [BLOCK.DANDELION, 0]);
    g.cells.set('-1,1,0', [BLOCK.STONE, 0]);
    g.place(0, 1, 0, W);
    settle(sim);
    expect(g.getBlock(1, 1, 0)).toBe(W);
    expect(g.getBlock(0, 1, 1)).toBe(W);
    expect(g.getBlock(-1, 1, 0)).toBe(STONE); // solid blocks stay
    expect(destroyed).toEqual(expect.arrayContaining([[1, 1, 0, BLOCK.TORCH], [0, 1, 1, BLOCK.DANDELION]]));
    expect(destroyed).toHaveLength(2);
  });

  it('does not flow through doors, slabs or glass', () => {
    const { g, sim } = setup();
    g.cells.set('1,1,0', [BLOCK.OAK_DOOR, 0]);
    g.cells.set('-1,1,0', [BLOCK.GLASS, 0]);
    g.cells.set('0,1,1', [48, 0]); // stone slab
    g.place(0, 1, 0, W);
    settle(sim);
    expect(g.getBlock(1, 1, 0)).toBe(BLOCK.OAK_DOOR);
    expect(g.getBlock(-1, 1, 0)).toBe(BLOCK.GLASS);
    expect(g.getBlock(0, 1, 1)).toBe(48);
    expect(g.getBlock(0, 1, -1)).toBe(W);
  });

  it('is a source again after a stone is removed next to it (a disturbed neighbour re-ticks)', () => {
    const { g, sim } = setup();
    g.fill(-1, 1, -1, 1, 1, 1, STONE);
    g.place(0, 1, 0, W);
    g.cells.set('0,1,0', [W, 0]);
    settle(sim);
    expect(g.getBlock(1, 1, 0)).toBe(STONE);
    g.place(1, 1, 0, AIR); // knock a hole in the wall
    settle(sim);
    expect(g.getBlock(1, 1, 0)).toBe(W);
    expect(g.getMeta(1, 1, 0)).toBe(1);
  });
});

describe('lava flow', () => {
  it('flows 3 blocks and 6 times slower than water', () => {
    const { g, sim } = setup();
    g.place(0, 1, 0, L);
    for (let i = 0; i < 29; i++) sim.tick();
    expect(g.getBlock(1, 1, 0)).toBe(AIR);
    sim.tick(); // 30th tick
    expect(g.getBlock(1, 1, 0)).toBe(L);
    expect(g.getMeta(1, 1, 0)).toBe(2); // amount 6
    settle(sim);
    expect(g.amount(1, 1, 0)).toBe(6);
    expect(g.amount(2, 1, 0)).toBe(4);
    expect(g.amount(3, 1, 0)).toBe(2);
    expect(g.amount(4, 1, 0)).toBe(0);
  });

  it('never makes infinite sources', () => {
    const { g, sim } = setup();
    g.place(0, 1, 0, L);
    g.place(2, 1, 0, L);
    settle(sim);
    expect(g.getBlock(1, 1, 0)).toBe(L);
    expect(g.getMeta(1, 1, 0)).not.toBe(0);
  });
});

describe('water meets lava', () => {
  it('turns a lava source next to water into obsidian', () => {
    const { g, sim } = setup();
    g.place(0, 1, 0, L);
    g.place(1, 1, 0, W);
    for (let i = 0; i < 3; i++) sim.tick();
    expect(g.getBlock(0, 1, 0)).toBe(BLOCK.OBSIDIAN);
  });

  it('turns lava under or beside flowing water into cobblestone (flowing) or obsidian (source)', () => {
    const { g, sim } = setup();
    // A lava source with water poured on top of it.
    g.place(0, 1, 0, L);
    settle(sim, 40);
    g.place(0, 3, 0, W);
    settle(sim);
    expect(g.getBlock(0, 1, 0)).toBe(BLOCK.OBSIDIAN);
    // Flowing lava reached by water becomes cobblestone.
    const { g: g2, sim: sim2 } = setup();
    g2.place(0, 1, 0, L);
    settle(sim2);
    expect(g2.getMeta(1, 1, 0)).toBe(2);
    g2.place(5, 1, 0, W);
    settle(sim2);
    // The thin end of the lava next to the water is cobblestone and stops the water; the source is out of reach.
    expect(g2.getBlock(3, 1, 0)).toBe(BLOCK.COBBLESTONE);
    expect(g2.getBlock(0, 1, 0)).toBe(L);
    expect(g2.getMeta(0, 1, 0)).toBe(0);
  });

  it('lava falling onto water makes stone', () => {
    const { g, sim } = setup();
    // A shaft of stone from y = 3 to 6 with a one-block pool of water at the bottom.
    for (let y = 3; y <= 6; y++) for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.cells.set(`${x},${y},${z}`, [STONE, 0]);
    for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) g.cells.set(`${x},2,${z}`, [STONE, 0]);
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.cells.set(`${x},2,${z}`, [STONE, 0]);
    g.cells.set('0,2,0', [W, 0]); // the pool (a source, enclosed)
    g.place(0, 7, 0, L);
    settle(sim, 400);
    // Lava fell down the shaft and met the water: the pool is stone (or obsidian from the source reaction), not water.
    expect([STONE, BLOCK.OBSIDIAN, BLOCK.COBBLESTONE]).toContain(g.getBlock(0, 2, 0));
  });

  it('reports the hiss', () => {
    const { g, sim } = setup();
    let fizz = 0;
    sim.onFizz = () => fizz++;
    g.place(0, 1, 0, L);
    g.place(1, 1, 0, W);
    for (let i = 0; i < 3; i++) sim.tick();
    expect(fizz).toBeGreaterThan(0);
  });
});

describe('budget and safety', () => {
  it('limits block changes per tick so a flood cannot flood the network', () => {
    const { g, sim } = setup();
    // 40 sources in a row, all disturbed at once.
    for (let x = 0; x < 40; x++) g.place(x, 1, 0, W);
    let maxPerTick = 0, total = 0;
    for (let i = 0; i < 400; i++) {
      const c = sim.tick(600, 20);
      maxPerTick = Math.max(maxPerTick, c);
      total += c;
    }
    // A tick may overshoot the limit by the changes of its last update (one update changes at most a handful of blocks).
    expect(maxPerTick).toBeLessThanOrEqual(20 + 5);
    expect(total).toBeGreaterThan(100);
    expect(sim.stats.deferred).toBeGreaterThan(0);
    // The default budget is what the server documents.
    expect(MAX_CHANGES_PER_TICK).toBe(200);
  });

  it('still reaches the same result as without a budget, only later', () => {
    const run = (limit: number) => {
      const { g, sim } = setup();
      g.place(0, 1, 0, W);
      for (let i = 0; i < 600; i++) sim.tick(600, limit);
      let n = 0;
      for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) n += g.amount(x, 1, z);
      return n;
    };
    expect(run(3)).toBe(run(200));
  });

  it('refuses new scheduled ticks beyond the cap and counts them', () => {
    const { g, sim } = setup();
    for (let i = 0; i < MAX_PENDING + 10; i++) sim.schedule(i, 1, 0, 5);
    expect(sim.pendingCount).toBe(MAX_PENDING);
    expect(sim.stats.dropped).toBe(10);
    void g;
  });

  it('ignores a stale tick for a block that is no longer liquid', () => {
    const { g, sim } = setup();
    g.cells.set('0,1,0', [STONE, 0]);
    sim.schedule(0, 1, 0, 1);
    expect(sim.tick()).toBe(0);
  });
});

describe('buckets', () => {
  const ctx = (world: ReturnType<typeof setup>['g'], over = {}) => ({
    hitX: 0, hitY: 1, hitZ: 0, nx: 0, ny: 1, nz: 0, getBlock: (x: number, y: number, z: number) => world.getBlock(x, y, z),
    getMeta: (x: number, y: number, z: number) => world.getMeta(x, y, z), ...over,
  });

  it('pours into the cell in front of the clicked face, replacing plants and flowing liquid', () => {
    const { g } = setup();
    expect(resolveBucketTarget(ctx(g), W)).toEqual({ x: 0, y: 2, z: 0 });
    g.cells.set('0,1,0', [BLOCK.TALL_GRASS, 0]);
    expect(resolveBucketTarget(ctx(g), W)).toEqual({ x: 0, y: 1, z: 0 }); // the clicked plant itself
    const { g: g2 } = setup();
    g2.cells.set('0,2,0', [W, 3]);
    expect(resolveBucketTarget(ctx(g2), W)).toEqual({ x: 0, y: 2, z: 0 }); // flowing water is replaced by a source
  });

  it('refuses a solid target and an existing source of the same liquid', () => {
    const { g } = setup();
    g.cells.set('0,2,0', [STONE, 0]);
    expect(resolveBucketTarget(ctx(g), W)).toBeNull();
    const { g: g2 } = setup();
    g2.cells.set('0,2,0', [W, 0]);
    expect(resolveBucketTarget(ctx(g2), W)).toBeNull();
    expect(resolveBucketTarget(ctx(g2), L)).toEqual({ x: 0, y: 2, z: 0 }); // lava can replace a water source
  });

  it('is crafted from 3 iron ingots, empty buckets stack to 16 and full ones do not', async () => {
    const r = RECIPES.find((x) => x.result.id === ITEM.BUCKET)!;
    expect(r).toMatchObject({ result: { count: 1 }, ingredients: [{ ids: [ITEM.IRON_INGOT], count: 3 }], station: 'table' });
    const { PlayerInventory } = await import('../src/items/Inventory');
    expect(PlayerInventory.maxStack(ITEM.BUCKET)).toBe(16);
    expect(PlayerInventory.maxStack(ITEM.WATER_BUCKET)).toBe(1);
    expect(PlayerInventory.maxStack(ITEM.LAVA_BUCKET)).toBe(1);
  });
});

describe('World integration', () => {
  it('notifies the simulation on every edit and floods through World.setBlock', () => {
    const world = makeTestWorld();
    const sim = world.enableLiquids();
    // A flat stone floor under y = 70.
    for (let x = -4; x <= 12; x++) for (let z = -4; z <= 12; z++) world.setBlock(x, 69, z, STONE);
    expect(sim.pendingCount).toBe(0);
    world.setBlock(4, 70, 4, W);
    expect(sim.pendingCount).toBe(1);
    for (let i = 0; i < 12; i++) world.tickLiquids();
    expect(world.getBlock(5, 70, 4)).toBe(W);
    expect(world.getMeta(5, 70, 4)).toBe(1);
    expect(world.getBlock(6, 70, 4)).toBe(W);
    // The flow is an ordinary edit: it is saved with the others.
    expect([...world.edits.values()].reduce((n, m) => n + m.size, 0)).toBeGreaterThan(10);
  });

  it('a block next to water changes → the water re-ticks (natural pools stay put until disturbed)', () => {
    const world = makeTestWorld();
    const sim = world.enableLiquids();
    for (let x = -4; x <= 12; x++) for (let z = -4; z <= 12; z++) world.setBlock(x, 69, z, STONE);
    sim.clear();
    world.chunks.get(0, 0)!.blocks![blockIndex(5, 70, 5)] = W; // natural water, written without an edit
    for (let i = 0; i < 20; i++) world.tickLiquids();
    expect(world.getBlock(6, 70, 5)).toBe(BLOCK.AIR);
    world.setBlock(5, 71, 5, STONE); // placing a block on top disturbs it
    expect(sim.pendingCount).toBeGreaterThan(0);
  });

  it('resumes liquid that was still flowing in a saved world', () => {
    const idx = blockIndex(3, 70, 3);
    // Make a world whose edits already hold a flowing water cell, with the simulation switched on before the chunks arrive.
    const edits = new Map([[chunkKeyOf(0, 0), new Map([[idx, W | (2 << 8)]])]]);
    const world = makeTestWorld(edits, [], true);
    expect(world.liquids!.pendingCount).toBe(1);
    // A source (meta 0) is static and is not scheduled.
    const edits2 = new Map([[chunkKeyOf(0, 0), new Map([[idx, W]])]]);
    expect(makeTestWorld(edits2, [], true).liquids!.pendingCount).toBe(0);
  });
});

describe('mesher: liquid surface', () => {
  const mesher = new ChunkMesher();
  const biomes = () => Array.from({ length: 9 }, () => new Uint8Array(CHUNK_AREA));
  const quads = (g: GeometryData | null) => (g ? g.index.length / 6 : 0);

  function build(fill: (put: (x: number, y: number, z: number, id: number, meta?: number) => void) => void) {
    const nb = Array.from({ length: 9 }, () => emptyChunk());
    const metas: (Uint8Array | null)[] = Array(9).fill(null);
    metas[4] = new Uint8Array(CHUNK_VOLUME);
    fill((x, y, z, id, meta = 0) => {
      setLocal(nb[4], x, y, z, id);
      metas[4]![blockIndex(x, y, z)] = meta;
    });
    return mesher.mesh(nb, biomes(), true, metas);
  }

  /** Highest vertex y (in blocks) of the top faces. */
  function topY(g: GeometryData): { min: number; max: number } {
    let min = 99, max = -99;
    for (let v = 0; v < g.packed.length / 4; v++) {
      if ((g.data[v * 4 + 1] & 7) !== 2) continue;
      const y = g.packed[v * 4 + 1] / 16;
      min = Math.min(min, y);
      max = Math.max(max, y);
    }
    return { min, max };
  }

  it('draws a source in a pit 14/16 high (about 8/9), like a lowered water surface', () => {
    const r = build((put) => {
      put(5, 64, 5, STONE);
      for (const [x, z] of [[4, 5], [6, 5], [5, 4], [5, 6], [4, 4], [6, 4], [4, 6], [6, 6]]) put(x, 65, z, STONE);
      put(5, 65, 5, W, 0);
    });
    expect(topY(r.water!)).toEqual({ min: 65.875, max: 65.875 });
  });

  it('lets the surface of a lone source sink at the corners where it borders air', () => {
    const r = build((put) => { put(5, 64, 5, STONE); put(5, 65, 5, W, 0); });
    const t = topY(r.water!);
    expect(t.max).toBeCloseTo(65 + 0.6875, 6); // (8/9 × 10) / (10 + 3 air cells)
  });

  it('draws thinner water lower and slopes between levels', () => {
    const flat = (level: number) => build((put) => {
      for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) put(x, 64, z, STONE);
      for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) put(x, 65, z, W, level);
    });
    const high = topY(flat(1).water!);
    const low = topY(flat(7).water!);
    expect(low.max).toBeLessThan(high.max);
    expect(low.max).toBeLessThan(65.5);
    // One source with a level-3 cell next to it: the surface between them is a slope (different corner heights on one face).
    const r = build((put) => { put(5, 64, 5, STONE); put(6, 64, 5, STONE); put(5, 65, 5, W, 0); put(6, 65, 5, W, 5); });
    const t = topY(r.water!);
    expect(t.max - t.min).toBeGreaterThan(0.2);
  });

  it('merges a column of water into full-height walls and hides faces between neighbours', () => {
    const column = build((put) => { put(5, 64, 5, STONE); for (let y = 65; y <= 67; y++) put(5, y, 5, W, y === 65 ? 0 : 8); });
    // Top at 67 is the only top face; under it the cells see water above (full height).
    const t = topY(column.water!);
    expect(t.max).toBeGreaterThan(67.6);
    expect(t.max).toBeLessThan(68);
    // 3 cells: 4 sides each (12) + 1 top; bottoms and the faces between the cells are hidden.
    expect(quads(column.water)).toBe(13);
  });

  it('keeps lava in the opaque geometry and water in the blended one, with the right wave and lava flags', () => {
    const r = build((put) => { put(5, 64, 5, STONE); put(5, 65, 5, W, 0); put(8, 64, 5, STONE); put(8, 65, 5, BLOCK.LAVA, 0); });
    expect(r.water).not.toBeNull();
    expect(r.opaque).not.toBeNull();
    const flagsOf = (g: GeometryData) => new Set(Array.from({ length: g.data.length / 4 }, (_, v) => g.data[v * 4 + 1] >> 5));
    expect([...flagsOf(r.water!)]).toEqual(expect.arrayContaining([2])); // top vertices wave
    expect([...flagsOf(r.opaque!)].includes(4)).toBe(true); // lava flag on the lava faces
  });

  it('draws no bottom face over a solid floor and a side face against open air only', () => {
    const r = build((put) => { put(5, 64, 5, STONE); put(5, 65, 5, W, 0); });
    // top + 4 sides (the floor is opaque: no bottom face).
    expect(quads(r.water)).toBe(5);
  });
});

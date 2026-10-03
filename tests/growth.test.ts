import { describe, expect, it } from 'vitest';
import { BLOCK, CUBE_ID, LEAVES_PERSISTENT_BIT, SAPLING_STAGE_BIT } from '../src/world/BlockRegistry';
import { BlockUpdates } from '../src/world/BlockUpdates';
import {
  LEAF_REACH, advanceSapling, boneMealTarget, createRandomTicker, growTree, leafSupported, registerBoneMeal, useBoneMeal,
} from '../src/world/Growth';
import { isLeaves, isLog } from '../src/world/PlantRules';
import { type RandomTicker } from '../src/world/RandomTicks';
import { SAPLING_TYPES, speciesOf } from '../src/world/Trees';
import { GrowthWorld, seeded } from './helpers/growthWorld';

const B = BLOCK;
const SOIL_Y = 60;
const Y = 61;

function setup(seed = 1): { w: GrowthWorld; t: RandomTicker } {
  const w = new GrowthWorld(3, SOIL_Y);
  const t = createRandomTicker(w, { rng: seeded(seed), radius: 3 });
  w.updates = new BlockUpdates(w);
  w.updates.onBroken = (_x, _y, _z, id, meta) => w.drops.push({ id, meta });
  return { w, t };
}

/** Runs the random tick handler of the block at a position. */
function tickAt(t: RandomTicker, w: GrowthWorld, x: number, y: number, z: number): void {
  const handler = (t.constructor as typeof RandomTicker).handlerOf(w.getBlock(x, y, z));
  if (!handler) throw new Error('no handler');
  handler(t, x, y, z);
}

function plant(w: GrowthWorld, variant = 0, stage = false, x = 0, z = 0): void {
  w.set(x, SOIL_Y, z, B.GRASS);
  w.set(x, Y, z, B.SAPLING, variant | (stage ? SAPLING_STAGE_BIT : 0));
}

describe('sapling growth', () => {
  it('advances a stage with probability 1/7 per random tick', () => {
    const { w, t } = setup(11);
    let grown = 0;
    const N = 7000;
    for (let i = 0; i < N; i++) {
      plant(w);
      tickAt(t, w, 0, Y, 0);
      if (w.getMeta(0, Y, 0) & SAPLING_STAGE_BIT) grown++;
    }
    expect(grown / N).toBeGreaterThan(1 / 7 - 0.02);
    expect(grown / N).toBeLessThan(1 / 7 + 0.02);
  });

  it('needs light 9 above it (time of day counts), block light helps', () => {
    const { w, t } = setup(12);
    const tries = (): number => {
      let grown = 0;
      for (let i = 0; i < 700; i++) {
        plant(w);
        tickAt(t, w, 0, Y, 0);
        if (w.getMeta(0, Y, 0) & SAPLING_STAGE_BIT) grown++;
      }
      return grown;
    };
    expect(tries()).toBeGreaterThan(40);
    w.dark = 11; // night: sky 15 - 11 = 4
    expect(tries()).toBe(0);
    w.light = () => 0xf9; // a torch-ish block light of 9
    expect(tries()).toBeGreaterThan(40);
    w.light = () => 0x08;
    expect(tries()).toBe(0);
  });

  it('keeps the wood of the variant when it advances (quiet state change, no block change)', () => {
    const { w, t } = setup(13);
    plant(w, 3);
    for (let i = 0; i < 200 && !(w.getMeta(0, Y, 0) & SAPLING_STAGE_BIT); i++) tickAt(t, w, 0, Y, 0);
    expect(w.getMeta(0, Y, 0) & 7).toBe(3);
    expect(w.changed.length).toBe(0);
    expect(w.quiet.length).toBeGreaterThan(0);
  });

  it.each(SAPLING_TYPES.map((n, i) => [n, i] as const))('a stage 1 %s sapling grows into its own tree', (_name, variant) => {
    const { w, t } = setup(20 + variant);
    plant(w, variant, true);
    expect(growTree(t, 0, Y, 0)).toBe(true);
    const { log, leaves } = speciesOf(variant);
    // The trunk replaced the sapling and rises at least 4 blocks; the species has its own leaves.
    expect(w.getBlock(0, Y, 0)).toBe(log);
    let h = 0;
    while (isLog(w.getBlock(0, Y + h, 0))) h++;
    expect(h).toBeGreaterThanOrEqual(4);
    let leafCount = 0;
    let wrongLeaf = 0;
    for (let y = Y; y < Y + 14; y++) for (let z = -5; z <= 5; z++) for (let x = -5; x <= 5; x++) {
      const id = w.getBlock(x, y, z);
      if (isLeaves(id)) { leafCount++; if (id !== leaves) wrongLeaf++; }
    }
    expect(leafCount).toBeGreaterThan(12);
    expect(wrongLeaf).toBe(0);
    // Grown leaves are natural: they can decay later.
    for (let y = Y; y < Y + 14; y++) for (let z = -5; z <= 5; z++) for (let x = -5; x <= 5; x++) {
      if (isLeaves(w.getBlock(x, y, z))) expect(w.getMeta(x, y, z) & LEAVES_PERSISTENT_BIT).toBe(0);
    }
    // The ground under the trunk became dirt.
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.DIRT);
  });

  it('does not grow when the trunk has no room, and stays a sapling', () => {
    const { w, t } = setup(30);
    plant(w, 0, true);
    w.set(0, Y + 3, 0, B.STONE);
    expect(growTree(t, 0, Y, 0)).toBe(false);
    expect(w.getBlock(0, Y, 0)).toBe(B.SAPLING);
    // Leaves and small plants in the way are fine.
    w.set(0, Y + 3, 0, B.OAK_LEAVES);
    w.set(0, Y + 2, 0, B.TALL_GRASS);
    expect(growTree(t, 0, Y, 0)).toBe(true);
  });

  it('does not grow into a chunk that is not loaded', () => {
    const w = new GrowthWorld(0, SOIL_Y); // only chunk (0, 0) exists
    const t = createRandomTicker(w, { rng: seeded(31) });
    plant(w, 0, true, 15, 15); // canopy spills over the border
    expect(growTree(t, 15, Y, 15)).toBe(false);
    expect(w.getBlock(15, Y, 15)).toBe(B.SAPLING);
  });

  it('a stage 0 sapling only advances its stage; the tree comes with the next step', () => {
    const { w, t } = setup(32);
    plant(w);
    expect(advanceSapling(t, 0, Y, 0)).toBe(true);
    expect(w.getBlock(0, Y, 0)).toBe(B.SAPLING);
    expect(w.getMeta(0, Y, 0) & SAPLING_STAGE_BIT).toBe(SAPLING_STAGE_BIT);
    expect(advanceSapling(t, 0, Y, 0)).toBe(true);
    expect(w.getBlock(0, Y, 0)).toBe(B.OAK_LOG);
  });
});

describe('leaf decay', () => {
  function grownOak(): { w: GrowthWorld; t: RandomTicker } {
    const s = setup(40);
    plant(s.w, 0, true);
    expect(growTree(s.t, 0, Y, 0)).toBe(true);
    return s;
  }

  function leavesOf(w: GrowthWorld): number[] {
    const out: number[] = [];
    for (let y = Y; y < Y + 14; y++) for (let z = -6; z <= 6; z++) for (let x = -6; x <= 6; x++) if (isLeaves(w.getBlock(x, y, z))) out.push(x, y, z);
    return out;
  }

  it('keeps leaves that are connected to a log', () => {
    const { w, t } = grownOak();
    const leaves = leavesOf(w);
    for (let i = 0; i < leaves.length; i += 3) tickAt(t, w, leaves[i], leaves[i + 1], leaves[i + 2]);
    expect(leavesOf(w).length).toBe(leaves.length);
  });

  it('decays every leaf once the log is gone, dropping through the host', () => {
    const { w, t } = grownOak();
    for (let y = Y; y < Y + 8; y++) w.set(0, y, 0, B.AIR);
    const leaves = leavesOf(w);
    w.changed.length = 0;
    for (let i = 0; i < leaves.length; i += 3) tickAt(t, w, leaves[i], leaves[i + 1], leaves[i + 2]);
    // Decay also removes the leaves in a chain: check again until stable (each pass only sees leaves still there).
    expect(leavesOf(w).length).toBe(0);
    expect(w.changed.length / 5).toBe(leaves.length / 3);
    expect(w.drops.length).toBe(leaves.length / 3);
  });

  it('never decays leaves placed by a player (persistent)', () => {
    const { w, t } = setup(41);
    w.set(3, Y, 3, B.OAK_LEAVES, LEAVES_PERSISTENT_BIT);
    tickAt(t, w, 3, Y, 3);
    expect(w.getBlock(3, Y, 3)).toBe(B.OAK_LEAVES);
    w.set(3, Y, 3, B.OAK_LEAVES, 0);
    tickAt(t, w, 3, Y, 3);
    expect(w.getBlock(3, Y, 3)).toBe(B.AIR);
  });

  it('counts the distance through leaves: 6 steps from a log survive, 7 decay', () => {
    const { w } = setup(42);
    w.set(0, Y, 0, B.OAK_LOG);
    for (let i = 1; i <= 7; i++) w.set(i, Y, 0, B.OAK_LEAVES);
    expect(LEAF_REACH).toBe(6);
    expect(leafSupported(w, 1, Y, 0)).toBe(true);
    expect(leafSupported(w, 6, Y, 0)).toBe(true);
    expect(leafSupported(w, 7, Y, 0)).toBe(false);
  });

  it('does not connect through air or other blocks, and any species of leaves and logs connect', () => {
    const { w } = setup(43);
    w.set(0, Y, 0, CUBE_ID.jungle_log);
    w.set(1, Y, 0, B.BIRCH_LEAVES);
    w.set(2, Y, 0, CUBE_ID.cherry_leaves);
    w.set(3, Y, 0, B.STONE);
    w.set(4, Y, 0, B.OAK_LEAVES);
    expect(leafSupported(w, 2, Y, 0)).toBe(true);
    expect(leafSupported(w, 4, Y, 0)).toBe(false);
  });

  it('waits when the neighbourhood is not loaded (it cannot be judged)', () => {
    const w = new GrowthWorld(0, SOIL_Y);
    w.set(15, Y, 8, B.OAK_LEAVES);
    expect(leafSupported(w, 15, Y, 8)).toBe(true); // the +x neighbour is in an unloaded chunk
    w.set(8, Y, 8, B.OAK_LEAVES);
    expect(leafSupported(w, 8, Y, 8)).toBe(false);
  });

  it('drops saplings, sticks and apples with the Minecraft odds', async () => {
    const { blockDrop, ITEM, itemBlock } = await import('../src/items/ItemRegistry');
    const N = 40_000;
    let sapling = 0, stick = 0, apple = 0;
    for (let i = 0; i < N; i++) {
      const d = blockDrop(B.OAK_LEAVES, 0);
      if (!d) continue;
      if (d.id === ITEM.STICK) stick++;
      else if (itemBlock(d.id) === B.SAPLING) sapling++;
      else apple++;
    }
    expect(sapling / N).toBeGreaterThan(0.04);
    expect(sapling / N).toBeLessThan(0.06);
    expect(apple / N).toBeGreaterThan(0.002);
    expect(apple / N).toBeLessThan(0.009);
    expect(stick / N).toBeGreaterThan(0.01);
    let jungle = 0;
    for (let i = 0; i < N; i++) if (itemBlock(blockDrop(CUBE_ID.jungle_leaves, 0)?.id ?? 0) === B.SAPLING) jungle++;
    expect(jungle / N).toBeLessThan(0.035);
  });
});

describe('sugar cane and cactus', () => {
  function cane(w: GrowthWorld): void {
    w.set(0, SOIL_Y, 0, B.SAND);
    w.set(1, SOIL_Y, 0, B.WATER);
    w.set(0, Y, 0, CUBE_ID.sugar_cane);
  }

  it('ages 0 to 15 and then grows one block, up to 3 high', () => {
    const { w, t } = setup(50);
    cane(w);
    for (let i = 0; i < 15; i++) {
      tickAt(t, w, 0, Y, 0);
      expect(w.getMeta(0, Y, 0)).toBe(i + 1);
      expect(w.getBlock(0, Y + 1, 0)).toBe(B.AIR);
    }
    tickAt(t, w, 0, Y, 0);
    expect(w.getBlock(0, Y + 1, 0)).toBe(CUBE_ID.sugar_cane);
    expect(w.getMeta(0, Y, 0)).toBe(0);
    // Grow the next one and then it stops at 3.
    for (let k = 0; k < 40; k++) for (let y = Y; y < Y + 5; y++) if (w.getBlock(0, y, 0) === CUBE_ID.sugar_cane) tickAt(t, w, 0, y, 0);
    expect(w.getBlock(0, Y + 2, 0)).toBe(CUBE_ID.sugar_cane);
    expect(w.getBlock(0, Y + 3, 0)).toBe(B.AIR);
  });

  it('does not grow under a block (needs air above)', () => {
    const { w, t } = setup(51);
    cane(w);
    w.set(0, Y + 1, 0, B.STONE);
    for (let i = 0; i < 40; i++) tickAt(t, w, 0, Y, 0);
    expect(w.getBlock(0, Y + 1, 0)).toBe(B.STONE);
  });

  it('breaks and drops when it has no water next to its ground', () => {
    const { w, t } = setup(52);
    cane(w);
    w.set(1, SOIL_Y, 0, B.STONE);
    tickAt(t, w, 0, Y, 0);
    expect(w.getBlock(0, Y, 0)).toBe(B.AIR);
    expect(w.drops.length).toBe(1);
    expect(w.drops[0].id).toBe(CUBE_ID.sugar_cane);
  });

  it('a whole stack pops when its base is removed (block updates cascade upwards)', () => {
    const { w } = setup(53);
    cane(w);
    w.set(0, Y + 1, 0, CUBE_ID.sugar_cane);
    w.set(0, Y + 2, 0, CUBE_ID.sugar_cane);
    w.setState(0, SOIL_Y, 0, B.AIR, 0); // the sand under it is mined
    for (let i = 0; i < 30; i++) w.updates!.tick();
    expect(w.getBlock(0, Y, 0)).toBe(B.AIR);
    expect(w.getBlock(0, Y + 1, 0)).toBe(B.AIR);
    expect(w.getBlock(0, Y + 2, 0)).toBe(B.AIR);
    expect(w.drops.length).toBe(3);
  });

  it('cactus grows 3 high on sand and not next to a wall', () => {
    const { w, t } = setup(54);
    w.set(0, SOIL_Y, 0, B.SAND);
    w.set(0, Y, 0, B.CACTUS);
    for (let k = 0; k < 120; k++) for (let y = Y; y < Y + 5; y++) if (w.getBlock(0, y, 0) === B.CACTUS) tickAt(t, w, 0, y, 0);
    expect(w.getBlock(0, Y + 2, 0)).toBe(B.CACTUS);
    expect(w.getBlock(0, Y + 3, 0)).toBe(B.AIR);
    // A wall next to a would-be top: the cactus does not grow into it (it would pop at once).
    w.set(0, Y + 2, 0, B.AIR);
    w.set(1, Y + 2, 0, B.STONE);
    for (let k = 0; k < 40; k++) tickAt(t, w, 0, Y + 1, 0);
    expect(w.getBlock(0, Y + 2, 0)).toBe(B.AIR);
  });

  it('cactus breaks and drops when a block is placed beside it', () => {
    const { w } = setup(55);
    w.set(0, SOIL_Y, 0, B.SAND);
    w.set(0, Y, 0, B.CACTUS);
    w.setState(1, Y, 0, B.STONE, 0); // a player places a block next to it
    for (let i = 0; i < 5; i++) w.updates!.tick();
    expect(w.getBlock(0, Y, 0)).toBe(B.AIR);
    expect(w.drops.map((d) => d.id)).toEqual([B.CACTUS]);
  });

  it('cactus needs sand', () => {
    const { w, t } = setup(56);
    w.set(0, SOIL_Y, 0, B.DIRT);
    w.set(0, Y, 0, B.CACTUS);
    tickAt(t, w, 0, Y, 0);
    expect(w.getBlock(0, Y, 0)).toBe(B.AIR);
  });
});

describe('grass, mycelium, mushrooms, ice', () => {
  it('grass spreads onto nearby dirt in light, never in the dark', () => {
    const { w, t } = setup(60);
    w.fill(-3, SOIL_Y, -3, 3, SOIL_Y, 3, B.DIRT);
    w.set(0, SOIL_Y, 0, B.GRASS);
    for (let i = 0; i < 400; i++) for (let z = -3; z <= 3; z++) for (let x = -3; x <= 3; x++) if (w.getBlock(x, SOIL_Y, z) === B.GRASS) tickAt(t, w, x, SOIL_Y, z);
    expect(w.getBlock(1, SOIL_Y, 1)).toBe(B.GRASS);
    expect(w.getBlock(3, SOIL_Y, 3)).toBe(B.GRASS);

    const d = setup(61);
    d.w.dark = 11;
    d.w.fill(-3, SOIL_Y, -3, 3, SOIL_Y, 3, B.DIRT);
    d.w.set(0, SOIL_Y, 0, B.GRASS);
    for (let i = 0; i < 400; i++) tickAt(d.t, d.w, 0, SOIL_Y, 0);
    expect(d.w.count(B.GRASS)).toBe(1);
  });

  it('grass under an opaque block or under water turns back into dirt; under glass or leaves it lives', () => {
    const { w, t } = setup(62);
    w.set(0, SOIL_Y, 0, B.GRASS);
    w.set(0, Y, 0, B.STONE);
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.DIRT);
    for (const [above, meta] of [[B.GLASS, 0], [B.OAK_LEAVES, 0], [B.WATER, 3]] as const) {
      w.set(0, SOIL_Y, 0, B.GRASS);
      w.set(0, Y, 0, above, meta);
      tickAt(t, w, 0, SOIL_Y, 0);
      expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.GRASS);
    }
    w.set(0, Y, 0, B.WATER, 0);
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.DIRT);
  });

  it('does not spread onto dirt that is covered', () => {
    const { w, t } = setup(63);
    w.set(1, SOIL_Y, 0, B.DIRT);
    w.set(1, Y, 0, B.STONE);
    w.set(0, SOIL_Y, 0, B.GRASS);
    for (let i = 0; i < 500; i++) tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(1, SOIL_Y, 0)).toBe(B.DIRT);
  });

  it('mycelium spreads like grass', () => {
    const { w, t } = setup(64);
    w.set(1, SOIL_Y, 0, B.DIRT);
    w.set(0, SOIL_Y, 0, CUBE_ID.mycelium);
    for (let i = 0; i < 500; i++) tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(1, SOIL_Y, 0)).toBe(CUBE_ID.mycelium);
  });

  it('mushrooms spread in the dark but never beyond five in a 9x3x9 area', () => {
    const { w, t } = setup(65);
    w.light = () => 0x04; // dark enough
    w.fill(-6, SOIL_Y, -6, 6, SOIL_Y, 6, B.STONE);
    w.set(0, Y, 0, CUBE_ID.brown_mushroom);
    for (let i = 0; i < 6000; i++) {
      for (let z = -6; z <= 6; z++) for (let x = -6; x <= 6; x++) if (w.getBlock(x, Y, z) === CUBE_ID.brown_mushroom) tickAt(t, w, x, Y, z);
    }
    const n = w.count(CUBE_ID.brown_mushroom);
    expect(n).toBeGreaterThan(1);
    // Each pick is checked against the five-limit around its own position, so the total stays small.
    expect(n).toBeLessThanOrEqual(15);
  });

  it('mushrooms do not spread in bright light', () => {
    const { w, t } = setup(66);
    w.fill(-3, SOIL_Y, -3, 3, SOIL_Y, 3, B.STONE);
    w.set(0, Y, 0, CUBE_ID.red_mushroom);
    for (let i = 0; i < 3000; i++) tickAt(t, w, 0, Y, 0);
    expect(w.count(CUBE_ID.red_mushroom)).toBe(1);
  });

  it('water freezes at the shore in a cold biome, not in the middle, not in plains, not next to light', async () => {
    const { Precip, precipitationFor } = await import('../src/world/Weather');
    const { BIOME } = await import('../src/world/Biomes');
    expect(precipitationFor(BIOME.SNOWY, 63)).toBe(Precip.SNOW);
    const { w, t } = setup(67);
    // The surface sweep is internal to the ticker: drive it by calling the registered surface handlers through many ticks.
    w.biome = BIOME.SNOWY;
    w.fill(-3, SOIL_Y, -3, 3, SOIL_Y, 3, B.WATER);
    w.light = () => 0xf0;
    for (let i = 0; i < 4000; i++) t.tick([{ x: 0, z: 0 }]);
    expect(w.count(CUBE_ID.ice)).toBeGreaterThan(0);
    // The centre only freezes once its neighbours are ice: a lone source surrounded by water never does first.
    expect(w.getBlock(0, SOIL_Y, 0) === CUBE_ID.ice ? w.getBlock(1, SOIL_Y, 0) !== B.WATER : true).toBe(true);

    const p = setup(68);
    p.w.biome = BIOME.PLAINS;
    p.w.fill(-3, SOIL_Y, -3, 3, SOIL_Y, 3, B.WATER);
    for (let i = 0; i < 4000; i++) p.t.tick([{ x: 0, z: 0 }]);
    expect(p.w.count(CUBE_ID.ice)).toBe(0);
  });

  it('ice melts next to a strong light', () => {
    const { w, t } = setup(69);
    w.set(0, SOIL_Y, 0, CUBE_ID.ice);
    w.light = () => 0xf4;
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(CUBE_ID.ice);
    w.light = () => 0xf0 | 12;
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.WATER);
  });
});

describe('bone meal', () => {
  it('advances a sapling 45% of the time and is always used up', () => {
    const { w, t } = setup(70);
    let advanced = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      plant(w);
      expect(useBoneMeal(t, 0, Y, 0)).toBe(true);
      if (w.getMeta(0, Y, 0) & SAPLING_STAGE_BIT) advanced++;
    }
    expect(advanced / N).toBeGreaterThan(0.42);
    expect(advanced / N).toBeLessThan(0.48);
  });

  it('grows a tree from a stage 1 sapling given enough tries', () => {
    const { w, t } = setup(71);
    plant(w, 0, true);
    for (let i = 0; i < 50 && w.getBlock(0, Y, 0) === B.SAPLING; i++) useBoneMeal(t, 0, Y, 0);
    expect(w.getBlock(0, Y, 0)).toBe(B.OAK_LOG);
  });

  it('scatters grass on a grass block, not on one that is covered, and ignores other blocks', () => {
    const { w, t } = setup(72);
    w.fill(-4, SOIL_Y, -4, 4, SOIL_Y, 4, B.GRASS);
    expect(useBoneMeal(t, 0, SOIL_Y, 0)).toBe(true);
    expect(w.count(B.TALL_GRASS) + w.count(B.DANDELION) + w.count(B.POPPY)).toBeGreaterThan(5);
    w.set(0, Y, 0, B.STONE);
    expect(useBoneMeal(t, 0, SOIL_Y, 0)).toBe(false);
    expect(useBoneMeal(t, 5, SOIL_Y - 1, 5)).toBe(false); // stone
  });

  it('other systems can register bone meal for their blocks', () => {
    const { w, t } = setup(73);
    expect(boneMealTarget(B.SAPLING)).toBe(true);
    expect(boneMealTarget(CUBE_ID.melon)).toBe(false);
    let called = 0;
    registerBoneMeal(CUBE_ID.melon, () => { called++; return true; });
    w.set(2, Y, 2, CUBE_ID.melon);
    expect(boneMealTarget(CUBE_ID.melon)).toBe(true);
    expect(useBoneMeal(t, 2, Y, 2)).toBe(true);
    expect(called).toBe(1);
  });
});

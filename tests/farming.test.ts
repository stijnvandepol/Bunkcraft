/**
 * Farming (src/world/Farming.ts, Crops.ts): Minecraft Java 1.21 numbers from minecraft.wiki and the CropBlock,
 * StemBlock and FarmBlock code they describe. Growth rates are checked statistically with seeded random sources.
 */
import { describe, expect, it } from 'vitest';
import { InventoryGuard, classifyEdit, placingItem } from '../server/InventoryGuard';
import { blockDrop, blockDrops, cropDrops, getItemDef, itemId, plantedBy, possibleBlockDrops, seedItemOf } from '../src/items/ItemRegistry';
import { RECIPES } from '../src/items/Recipes';
import { toolUse } from '../src/items/ToolUse';
import { BLOCK, CUBE_ID, META_MASK, TEXTURE_NAMES, getBlockDef } from '../src/world/BlockRegistry';
import { BlockUpdates } from '../src/world/BlockUpdates';
import { isValidMeta } from '../src/world/BlockShapes';
import {
  CROPS, CROP_BLOCK, FARMLAND, FARMLAND_WET, FARMLAND_WET_TINT, attachedStemMeta, cropAge, cropBlock, cropState, farmlandState, isCrop, isStem, stemAttached, stemFacing,
} from '../src/world/Crops';
import {
  CROP_LIGHT, canTrample, farmStateText, growthOdds, growthSpeed, isNearWater, trample, trampleChance,
} from '../src/world/Farming';
import { boneMealTarget, createRandomTicker, useBoneMeal } from '../src/world/Growth';
import { isReplaceable } from '../src/world/Placement';
import { needsSupport, plantCanStand } from '../src/world/PlantRules';
import { RandomTicker } from '../src/world/RandomTicks';
import { FOOD_TAGS, isBreedFood } from '../src/entities/Breeding';
import { GrowthWorld, seeded } from './helpers/growthWorld';
import { ChunkMesher } from '../src/rendering/ChunkMesher';
import { CHUNK_AREA, CHUNK_VOLUME, blockIndex } from '../src/world/constants';

const B = BLOCK;
const SOIL_Y = 60;
const Y = 61;
const WHEAT = CROP_BLOCK.WHEAT;

function setup(seed = 1): { w: GrowthWorld; t: RandomTicker } {
  const w = new GrowthWorld(2, SOIL_Y);
  const t = createRandomTicker(w, { rng: seeded(seed), radius: 0 });
  w.updates = new BlockUpdates(w);
  w.updates.onBroken = (_x, _y, _z, id, meta) => w.drops.push({ id, meta });
  return { w, t };
}

function tickAt(t: RandomTicker, w: GrowthWorld, x: number, y: number, z: number): void {
  const h = RandomTicker.handlerOf(w.getBlock(x, y, z));
  if (!h) throw new Error(`no random tick for ${w.getBlock(x, y, z)}`);
  h(t, x, y, z);
}

/** Farmland in the square ±r around (cx, cz), wet or dry. */
function field(w: GrowthWorld, cx: number, cz: number, r: number, wet: boolean): void {
  for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) w.set(x, SOIL_Y, z, FARMLAND, wet ? FARMLAND_WET : 0);
}

function runUpdates(w: GrowthWorld, n = 5): void {
  for (let i = 0; i < n; i++) w.updates!.tick();
}

describe('crop blocks', () => {
  it('six crop blocks with their own ids, states validated by the server, one texture layer each', () => {
    const ids = CROPS.map((c) => c.id);
    expect(ids).toEqual([235, 236, 237, 238, 239, 240]);
    for (const c of CROPS) {
      expect(getBlockDef(c.id)?.name).toBe(c.name);
      expect(getBlockDef(c.id)?.inInventory).toBe(false);
      for (let a = 0; a <= c.maxAge; a++) expect(isValidMeta(c.id, a)).toBe(true);
      expect(isValidMeta(c.id, c.maxAge + 1)).toBe(c.style === 2); // stems carry attachment bits above the age
    }
    expect(isValidMeta(CROP_BLOCK.PUMPKIN_STEM, attachedStemMeta(3))).toBe(true);
    expect(META_MASK[FARMLAND]).toBe(7);
    // The texture budget: 6 layers for all crops (the 8-bit layer index allows 256).
    for (const name of ['wheat_crop', 'carrots_crop', 'potatoes_crop', 'beetroots_crop', 'stem', 'attached_stem']) expect(TEXTURE_NAMES).toContain(name);
    expect(TEXTURE_NAMES.length).toBeLessThanOrEqual(256);
  });

  it('exports clean helpers for structure generation (village farms)', () => {
    expect(cropState('wheat', 7)).toEqual({ id: WHEAT, meta: 7 });
    expect(cropState('beetroots', 99)).toEqual({ id: CROP_BLOCK.BEETROOTS, meta: 3 });
    expect(cropState('carrots', -4)).toEqual({ id: CROP_BLOCK.CARROTS, meta: 0 });
    expect(cropBlock('melon_stem')).toBe(CROP_BLOCK.MELON_STEM);
    expect(farmlandState(true)).toEqual({ id: CUBE_ID.farmland, meta: 7 });
    expect(isCrop(WHEAT) && isStem(CROP_BLOCK.PUMPKIN_STEM) && !isCrop(B.GRASS)).toBe(true);
    const m = attachedStemMeta(2);
    expect(stemAttached(m) && stemFacing(m) === 2 && cropAge(CROP_BLOCK.MELON_STEM, m) === 7).toBe(true);
  });

  it('crops need farmland, are not replaced by placed blocks, and show their state on F3', () => {
    const get = (_x: number, y: number): number => (y === 60 ? FARMLAND : y === 59 ? B.STONE : B.AIR);
    expect(plantCanStand(WHEAT, get, 0, 61, 0)).toBe(true);
    expect(plantCanStand(WHEAT, (_x, y) => (y === 60 ? B.GRASS : B.AIR), 0, 61, 0)).toBe(false);
    expect(needsSupport(CROP_BLOCK.POTATOES)).toBe(true);
    expect(isReplaceable(WHEAT)).toBe(false);
    expect(isReplaceable(B.TALL_GRASS)).toBe(true);
    expect(farmStateText(WHEAT, 3)).toBe('age: 3 (of 7)');
    expect(farmStateText(FARMLAND, 7)).toBe('moisture: 7');
    expect(farmStateText(CROP_BLOCK.PUMPKIN_STEM, attachedStemMeta(1))).toBe('attached, facing: south');
    expect(farmStateText(B.STONE, 0)).toBeNull();
  });
});

describe('growth speed (CropBlock.getGrowthSpeed)', () => {
  it('matches hand-computed values for the classic layouts', () => {
    const { w } = setup();
    // Lone crop on dry farmland, nothing around: 1 + 1.
    w.set(0, SOIL_Y, 0, FARMLAND, 0);
    expect(growthSpeed(w, WHEAT, 0, Y, 0)).toBe(2);
    // Lone crop on moist farmland: 1 + 3.
    w.set(0, SOIL_Y, 0, FARMLAND, 7);
    expect(growthSpeed(w, WHEAT, 0, Y, 0)).toBe(4);
    // Moist 3×3 farmland: 1 + 3 + 8 × 3/4 = 10, the best there is.
    field(w, 0, 0, 1, true);
    expect(growthSpeed(w, WHEAT, 0, Y, 0)).toBe(10);
    // A row of the same crop along x keeps the bonus (only one axis has neighbours).
    w.set(-1, Y, 0, WHEAT); w.set(1, Y, 0, WHEAT);
    expect(growthSpeed(w, WHEAT, 0, Y, 0)).toBe(10);
    // Neighbours on both axes halve it.
    w.set(0, Y, 1, WHEAT);
    expect(growthSpeed(w, WHEAT, 0, Y, 0)).toBe(5);
    // A diagonal neighbour alone halves it too; another crop next to it does not count.
    for (const [x, z] of [[-1, 0], [1, 0], [0, 1]]) w.set(x, Y, z, B.AIR);
    w.set(1, Y, 1, WHEAT);
    expect(growthSpeed(w, WHEAT, 0, Y, 0)).toBe(5);
    w.set(1, Y, 1, CROP_BLOCK.CARROTS);
    expect(growthSpeed(w, WHEAT, 0, Y, 0)).toBe(10);
    // Odds: 1 in ⌊25 / f⌋ + 1.
    expect([growthOdds(2), growthOdds(4), growthOdds(5), growthOdds(10)]).toEqual([13, 7, 6, 3]);
  });

  it('an attached stem is not the same plant for the neighbour rule', () => {
    const { w } = setup();
    field(w, 0, 0, 1, true);
    w.set(1, Y, 0, CROP_BLOCK.PUMPKIN_STEM, attachedStemMeta(3));
    w.set(0, Y, 1, CROP_BLOCK.PUMPKIN_STEM, 3);
    expect(growthSpeed(w, CROP_BLOCK.PUMPKIN_STEM, 0, Y, 0)).toBe(10);
    w.set(1, Y, 0, CROP_BLOCK.PUMPKIN_STEM, 3);
    expect(growthSpeed(w, CROP_BLOCK.PUMPKIN_STEM, 0, Y, 0)).toBe(5);
  });
});

describe('crop growth on random ticks', () => {
  /** Fraction of random ticks that advance a fresh crop of `id` at the origin. */
  function rate(id: number, layout: (w: GrowthWorld) => void, n: number, seed: number, light = 0xf0): number {
    const { w, t } = setup(seed);
    w.light = () => light;
    layout(w);
    let grown = 0;
    for (let i = 0; i < n; i++) {
      w.set(0, Y, 0, id, 0);
      tickAt(t, w, 0, Y, 0);
      if (cropAge(id, w.getMeta(0, Y, 0)) > 0) grown++;
    }
    return grown / n;
  }

  it.each([
    ['lone wheat, dry farmland', WHEAT, (w: GrowthWorld) => w.set(0, SOIL_Y, 0, FARMLAND, 0), 1 / 13],
    ['lone wheat, moist farmland', WHEAT, (w: GrowthWorld) => w.set(0, SOIL_Y, 0, FARMLAND, 7), 1 / 7],
    ['wheat in a moist 3×3 field', WHEAT, (w: GrowthWorld) => field(w, 0, 0, 1, true), 1 / 3],
    ['carrots in a moist field, planted all round', CROP_BLOCK.CARROTS, (w: GrowthWorld) => {
      field(w, 0, 0, 1, true);
      for (const [x, z] of [[1, 0], [0, 1]]) w.set(x, Y, z, CROP_BLOCK.CARROTS);
    }, 1 / 6],
    ['beetroots skip a third of their ticks', CROP_BLOCK.BEETROOTS, (w: GrowthWorld) => field(w, 0, 0, 1, true), (2 / 3) * (1 / 3)],
    ['a pumpkin stem grows like a crop', CROP_BLOCK.PUMPKIN_STEM, (w: GrowthWorld) => w.set(0, SOIL_Y, 0, FARMLAND, 7), 1 / 7],
  ] as const)('%s', (_name, id, layout, expected) => {
    const n = 12000;
    const got = rate(id, layout, n, 1000 + Math.round(expected * 1000));
    // Four standard deviations of a binomial fraction.
    const sd = Math.sqrt((expected * (1 - expected)) / n);
    expect(Math.abs(got - expected)).toBeLessThan(4 * sd);
  });

  it(`needs raw light ${CROP_LIGHT} at the crop; the sky counts at night (getRawBrightness(pos, 0)), block light helps`, () => {
    const layout = (w: GrowthWorld): void => field(w, 0, 0, 1, true);
    expect(rate(WHEAT, layout, 600, 5, 0x80)).toBe(0); // sky 8
    expect(rate(WHEAT, layout, 600, 5, 0x90)).toBeGreaterThan(0.2); // sky 9
    expect(rate(WHEAT, layout, 600, 5, 0x09)).toBeGreaterThan(0.2); // a torch-like block light 9
    const { w, t } = setup(6);
    layout(w);
    w.dark = 11; // midnight: the crop still reads its raw sky light
    w.set(0, Y, 0, WHEAT, 0);
    for (let i = 0; i < 50; i++) tickAt(t, w, 0, Y, 0);
    expect(w.getMeta(0, Y, 0)).toBeGreaterThan(0);
  });

  it('stops at the ripe stage and every step is a visible (sent) block change', () => {
    const { w, t } = setup(7);
    field(w, 0, 0, 1, true);
    w.set(0, Y, 0, CROP_BLOCK.BEETROOTS, 0);
    for (let i = 0; i < 500; i++) tickAt(t, w, 0, Y, 0);
    expect(w.getMeta(0, Y, 0)).toBe(3);
    const steps = [];
    for (let i = 0; i < w.changed.length; i += 5) if (w.changed[i + 3] === CROP_BLOCK.BEETROOTS) steps.push(w.changed[i + 4]);
    expect(steps).toEqual([1, 2, 3]);
  });

  it('with real random ticks (speed 3) wheat ripens in the time the wiki formula predicts', () => {
    // Lone wheat plants every other block on moist farmland kept wet by water lines, light 15, randomTickSpeed 3.
    const w = new GrowthWorld(0, SOIL_Y);
    const t = createRandomTicker(w, { rng: seeded(424242), radius: 0, budgetMs: 1e9, maxChanges: 1e9 });
    const plants: [number, number][] = [];
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        if (z % 4 === 3) { w.set(x, SOIL_Y, z, B.WATER); continue; }
        w.set(x, SOIL_Y, z, FARMLAND, 7);
        if (x % 2 === 0 && z % 4 === 1) { w.set(x, Y, z, WHEAT, 0); plants.push([x, z]); }
      }
    }
    // Expected ticks to ripen: 7 stages × odds random ticks, one random tick per block every 4096 / 3 game ticks.
    let expected = 0;
    for (const [x, z] of plants) expected += 7 * growthOdds(growthSpeed(w, WHEAT, x, Y, z)) * (4096 / 3);
    expected /= plants.length;
    const ripeAt = new Map<number, number>();
    for (let tick = 1; tick <= 4 * expected && ripeAt.size < plants.length; tick++) {
      t.tick([{ x: 8, z: 8 }]);
      if (tick % 20 !== 0) continue;
      plants.forEach(([x, z], i) => { if (!ripeAt.has(i) && w.getMeta(x, Y, z) === 7) ripeAt.set(i, tick); });
    }
    expect(ripeAt.size).toBe(plants.length);
    const mean = [...ripeAt.values()].reduce((a, b) => a + b, 0) / ripeAt.size;
    // 32 plants: the mean of 7 exponential waits has a spread of about 7 %.
    expect(mean / expected).toBeGreaterThan(0.8);
    expect(mean / expected).toBeLessThan(1.2);
    // Water kept every farmland block wet.
    for (const [x, z] of plants) expect(w.getMeta(x, SOIL_Y, z)).toBe(7);
  }, 30_000);
});

describe('farmland', () => {
  it('is wet with water within 4 blocks on its level or one above, not 5 away or below', () => {
    const { w } = setup();
    w.set(0, SOIL_Y, 0, FARMLAND);
    w.set(4, SOIL_Y, -4, B.WATER);
    expect(isNearWater(w, 0, SOIL_Y, 0)).toBe(true);
    w.set(4, SOIL_Y, -4, B.STONE);
    w.set(5, SOIL_Y, 0, B.WATER);
    expect(isNearWater(w, 0, SOIL_Y, 0)).toBe(false);
    w.set(-3, SOIL_Y + 1, 2, B.WATER);
    expect(isNearWater(w, 0, SOIL_Y, 0)).toBe(true);
    w.set(-3, SOIL_Y + 1, 2, B.AIR);
    w.set(0, SOIL_Y - 1, 1, B.WATER);
    expect(isNearWater(w, 0, SOIL_Y, 0)).toBe(false);
  });

  it('hydrates to 7 at once, dries one step per random tick, then turns to dirt unless something grows on it', () => {
    const { w, t } = setup(3);
    w.set(0, SOIL_Y, 0, FARMLAND, 0);
    w.set(2, SOIL_Y, 0, B.WATER);
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getMeta(0, SOIL_Y, 0)).toBe(7);
    w.set(2, SOIL_Y, 0, B.STONE);
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) { tickAt(t, w, 0, SOIL_Y, 0); seen.push(w.getMeta(0, SOIL_Y, 0)); }
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0]);
    // Only "wet → not wet" changes the look: that one is sent, the other steps are quiet.
    expect(w.changed.filter((_v, i) => i % 5 === 3 && w.changed[i] === FARMLAND).length).toBe(2);
    // A crop keeps dry farmland.
    w.set(0, Y, 0, WHEAT);
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(FARMLAND);
    w.set(0, Y, 0, B.AIR);
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.DIRT);
  });

  it('stays wet in the rain', () => {
    const { w, t } = setup(4);
    const raining = { on: true };
    (w as unknown as { rainingAt: () => boolean }).rainingAt = () => raining.on;
    w.set(0, SOIL_Y, 0, FARMLAND, 2);
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getMeta(0, SOIL_Y, 0)).toBe(7);
    raining.on = false;
    tickAt(t, w, 0, SOIL_Y, 0);
    expect(w.getMeta(0, SOIL_Y, 0)).toBe(6);
  });

  it('a solid block on top turns it into dirt and the crop on it pops off with its loot', () => {
    const { w } = setup();
    w.set(0, SOIL_Y, 0, FARMLAND, 7);
    w.setState(0, Y, 0, B.STONE, 0);
    runUpdates(w);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.DIRT);
    w.set(1, SOIL_Y, 0, FARMLAND, 7);
    w.set(1, Y, 0, WHEAT, 7);
    w.setState(1, SOIL_Y, 0, B.DIRT, 0);
    runUpdates(w);
    expect(w.getBlock(1, Y, 0)).toBe(B.AIR);
    expect(w.drops).toContainEqual({ id: WHEAT, meta: 7 });
  });

  it('is trampled with chance fallDistance − 0.5 by anything as big as a player', () => {
    expect(trampleChance(0.4)).toBe(0);
    expect(trampleChance(1.25)).toBeCloseTo(0.75); // a jump
    expect(trampleChance(3)).toBe(1);
    expect(canTrample(0.6, 1.8)).toBe(true); // player
    expect(canTrample(0.9, 1.4)).toBe(true); // cow
    expect(canTrample(0.4, 0.7)).toBe(false); // chicken
    const { w } = setup();
    w.set(0, SOIL_Y, 0, FARMLAND, 7);
    w.set(0, Y, 0, CROP_BLOCK.CARROTS, 7);
    const world = { getBlock: (x: number, y: number, z: number) => w.getBlock(x, y, z), setBlock: (x: number, y: number, z: number, id: number) => w.setState(x, y, z, id, 0) };
    expect(trample(world, 0, SOIL_Y, 0, 1.25, 0.8)).toBe(false);
    expect(trample(world, 0, SOIL_Y, 0, 1.25, 0.7)).toBe(true);
    runUpdates(w);
    expect(w.getBlock(0, SOIL_Y, 0)).toBe(B.DIRT);
    expect(w.getBlock(0, Y, 0)).toBe(B.AIR);
    expect(w.drops).toContainEqual({ id: CROP_BLOCK.CARROTS, meta: 7 });
    expect(trample(world, 0, SOIL_Y, 0, 9, 0)).toBe(false); // dirt is not farmland any more
  });

  it('is made by a hoe only with air above', () => {
    expect(toolUse('hoe', B.GRASS, B.AIR)?.to).toBe(FARMLAND);
    expect(toolUse('hoe', B.DIRT, B.TALL_GRASS)).toBeNull();
  });
});

describe('stems, pumpkins and melons', () => {
  it('a ripe stem grows its fruit on a free side over farmland or dirt and turns towards it', () => {
    const { w, t } = setup(9);
    field(w, 0, 0, 1, true);
    w.set(0, Y, 0, CROP_BLOCK.MELON_STEM, 7);
    // Only the east side may take the fruit: the others hold stone or a stone floor.
    w.set(0, Y, -1, B.STONE); w.set(0, Y, 1, B.STONE); w.set(-1, SOIL_Y, 0, B.STONE);
    for (let i = 0; i < 400 && w.getBlock(1, Y, 0) !== CUBE_ID.melon; i++) tickAt(t, w, 0, Y, 0);
    expect(w.getBlock(1, Y, 0)).toBe(CUBE_ID.melon);
    expect(w.getMeta(0, Y, 0)).toBe(attachedStemMeta(3));
    expect(w.getBlock(-1, Y, 0)).toBe(B.AIR);
    // The farmland under the melon cannot hold a solid block: it is dirt after the update.
    runUpdates(w);
    expect(w.getBlock(1, SOIL_Y, 0)).toBe(B.DIRT);
    // An attached stem does nothing on its own; when the melon is harvested it is a ripe stem again.
    w.setState(1, Y, 0, B.AIR, 0);
    runUpdates(w);
    expect(w.getMeta(0, Y, 0)).toBe(7);
  });

  it('stem seeds: B(3, (age + 1) / 15), attached B(3, 8/15)', () => {
    const mean = (meta: number): number => {
      let n = 0;
      for (let i = 0; i < 6000; i++) for (const d of cropDrops(CROP_BLOCK.PUMPKIN_STEM, meta)) n += d.count;
      return n / 6000;
    };
    expect(mean(0)).toBeCloseTo(3 / 15, 1);
    expect(mean(7)).toBeCloseTo(3 * 8 / 15, 1);
    expect(mean(attachedStemMeta(0))).toBeCloseTo(3 * 8 / 15, 1);
  });
});

describe('bone meal', () => {
  it('adds 2-5 ages to a crop (uniformly), never past ripe; a ripe crop takes none', () => {
    const { w, t } = setup(21);
    field(w, 0, 0, 1, true);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) {
      w.set(0, Y, 0, WHEAT, 0);
      expect(useBoneMeal(t, 0, Y, 0)).toBe(true);
      counts[w.getMeta(0, Y, 0)]++;
    }
    expect(counts[0] + counts[1]).toBe(0);
    for (let a = 2; a <= 5; a++) expect(counts[a] / 4000).toBeCloseTo(0.25, 1);
    w.set(0, Y, 0, WHEAT, 6);
    useBoneMeal(t, 0, Y, 0);
    expect(w.getMeta(0, Y, 0)).toBe(7);
    expect(useBoneMeal(t, 0, Y, 0)).toBe(false);
    expect(boneMealTarget(WHEAT, 7)).toBe(false);
    expect(boneMealTarget(WHEAT, 3)).toBe(true);
    expect(boneMealTarget(CROP_BLOCK.PUMPKIN_STEM, attachedStemMeta(0))).toBe(false);
  });

  it('beetroots get a third of it (0 or 1 age, 1 three times in four)', () => {
    const { w, t } = setup(22);
    field(w, 0, 0, 1, true);
    let ones = 0;
    for (let i = 0; i < 4000; i++) {
      w.set(0, Y, 0, CROP_BLOCK.BEETROOTS, 0);
      useBoneMeal(t, 0, Y, 0);
      ones += w.getMeta(0, Y, 0);
    }
    expect(ones / 4000).toBeCloseTo(0.75, 1);
  });

  it('a stem it ripens gets a random tick at once (so it may grow its fruit)', () => {
    const { w, t } = setup(23);
    field(w, 0, 0, 2, true);
    let fruit = 0;
    for (let i = 0; i < 300; i++) {
      w.set(0, Y, 0, CROP_BLOCK.PUMPKIN_STEM, 5);
      for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { w.set(x, Y, z, B.AIR); w.set(x, SOIL_Y, z, FARMLAND, 7); }
      useBoneMeal(t, 0, Y, 0);
      if (stemAttached(w.getMeta(0, Y, 0))) fruit++;
    }
    // Ripe every time (5 + 2..5 ≥ 7); then one growth roll: alone in a moist field f = 10, so 1 in 3, every side free.
    expect(fruit / 300).toBeGreaterThan(0.2);
    expect(fruit / 300).toBeLessThan(0.47);
  });
});

describe('drops (loot tables, Fortune)', () => {
  const avg = (id: number, meta: number, item: string, fortune = 0, n = 6000): number => {
    let c = 0;
    for (let i = 0; i < n; i++) for (const d of cropDrops(id, meta, fortune)) if (d.id === itemId(item)) c += d.count;
    return c / n;
  };

  it('unripe crops give back their seed', () => {
    expect(blockDrops(WHEAT, 0, 3)).toEqual([{ id: itemId('wheat_seeds'), count: 1 }]);
    expect(blockDrops(CROP_BLOCK.CARROTS, 0, 6)).toEqual([{ id: itemId('carrot'), count: 1 }]);
    expect(blockDrops(CROP_BLOCK.POTATOES, 0, 0)).toEqual([{ id: itemId('potato'), count: 1 }]);
    expect(blockDrops(CROP_BLOCK.BEETROOTS, 0, 2)).toEqual([{ id: itemId('beetroot_seeds'), count: 1 }]);
  });

  it('ripe wheat: 1 wheat and 1 + B(3 + Fortune, 4/7) seeds', () => {
    expect(avg(WHEAT, 7, 'wheat')).toBe(1);
    expect(avg(WHEAT, 7, 'wheat_seeds')).toBeCloseTo(1 + 3 * 4 / 7, 1);
    expect(avg(WHEAT, 7, 'wheat_seeds', 3)).toBeCloseTo(1 + 6 * 4 / 7, 1);
    for (let i = 0; i < 2000; i++) {
      const seeds = cropDrops(WHEAT, 7)[1].count;
      expect(seeds).toBeGreaterThanOrEqual(1);
      expect(seeds).toBeLessThanOrEqual(4);
    }
  });

  it('ripe carrots and potatoes 2-5 (more with Fortune), 2% poisonous potatoes; beetroot 1 + seeds', () => {
    expect(avg(CROP_BLOCK.CARROTS, 7, 'carrot')).toBeCloseTo(2 + 3 * 4 / 7, 1);
    expect(avg(CROP_BLOCK.POTATOES, 7, 'potato', 2)).toBeCloseTo(2 + 5 * 4 / 7, 1);
    expect(avg(CROP_BLOCK.POTATOES, 7, 'poisonous_potato', 0, 20000)).toBeCloseTo(0.02, 2);
    expect(avg(CROP_BLOCK.BEETROOTS, 3, 'beetroot')).toBe(1);
    expect(avg(CROP_BLOCK.BEETROOTS, 3, 'beetroot_seeds')).toBeCloseTo(1 + 3 * 4 / 7, 1);
  });

  it('the server credits the highest roll (Fortune III) of every crop', () => {
    for (const c of CROPS) {
      for (let meta = 0; meta <= 63; meta++) {
        const ceiling = possibleBlockDrops(c.id, meta);
        for (let i = 0; i < 300; i++) {
          for (const d of cropDrops(c.id, meta, 3)) {
            const p = ceiling.find((s) => s.id === d.id);
            expect(p && p.count >= d.count, `${c.name}:${meta} ${d.count} x ${d.id}`).toBe(true);
          }
        }
      }
    }
    expect(blockDrop(WHEAT, 0, 7)?.id).toBe(itemId('wheat'));
  });

  it('grass drops wheat seeds 1 in 8, Fortune adds up to 2 × level', () => {
    let seeds = 0, n = 0;
    for (let i = 0; i < 20000; i++) {
      const d = blockDrop(B.TALL_GRASS, 0, 0, { fortune: 2 });
      if (d) { n++; seeds += d.count; expect(d.id).toBe(itemId('wheat_seeds')); expect(d.count).toBeLessThanOrEqual(5); }
    }
    expect(n / 20000).toBeCloseTo(0.125, 2);
    expect(seeds / n).toBeCloseTo(3, 1);
  });
});

describe('items, recipes and breeding', () => {
  it('seeds, carrots and potatoes plant their crop; pick block gives the seed back', () => {
    expect(plantedBy(itemId('wheat_seeds'))).toBe(WHEAT);
    expect(plantedBy(itemId('carrot'))).toBe(CROP_BLOCK.CARROTS);
    expect(plantedBy(itemId('potato'))).toBe(CROP_BLOCK.POTATOES);
    expect(plantedBy(itemId('beetroot_seeds'))).toBe(CROP_BLOCK.BEETROOTS);
    expect(plantedBy(itemId('pumpkin_seeds'))).toBe(CROP_BLOCK.PUMPKIN_STEM);
    expect(plantedBy(itemId('melon_seeds'))).toBe(CROP_BLOCK.MELON_STEM);
    expect(plantedBy(itemId('wheat'))).toBe(0);
    expect(seedItemOf(CROP_BLOCK.MELON_STEM)).toBe(itemId('melon_seeds'));
  });

  it('bread, pumpkin pie, beetroot soup, hay bale and baked potato have their Java 1.21 recipes', () => {
    const find = (name: string) => RECIPES.find((r) => r.result.id === itemId(name));
    expect(find('bread')?.ingredients).toEqual([{ ids: [itemId('wheat')], count: 3 }]);
    expect(find('pumpkin_pie')?.station).toBe('hand');
    expect(find('pumpkin_pie')?.ingredients.map((i) => i.ids[0])).toEqual([CUBE_ID.pumpkin, itemId('sugar'), itemId('egg')]);
    expect(find('beetroot_soup')?.ingredients).toEqual([{ ids: [itemId('beetroot')], count: 6 }, { ids: [itemId('bowl')], count: 1 }]);
    expect(find('hay_block')?.ingredients).toEqual([{ ids: [itemId('wheat')], count: 9 }]);
    expect(find('baked_potato')?.station).toBe('furnace');
  });

  it('food values (minecraft.wiki)', () => {
    const food = (n: string) => getItemDef(itemId(n))?.food;
    expect(food('poisonous_potato')).toMatchObject({ hunger: 2, saturation: 1.2, poison: 100, poisonChance: 0.6 });
    expect(food('beetroot_soup')).toMatchObject({ hunger: 6, saturation: 7.2, returns: 'bowl' });
    expect(food('bread')).toMatchObject({ hunger: 5, saturation: 6 });
    expect(food('baked_potato')).toMatchObject({ hunger: 5, saturation: 6 });
    expect(food('pumpkin_pie')).toMatchObject({ hunger: 8, saturation: 4.8 });
  });

  it('the new crops count as breeding food', () => {
    expect(FOOD_TAGS.seeds).toContain('beetroot_seeds');
    expect(isBreedFood('chicken', itemId('beetroot_seeds'))).toBe(true);
    expect(isBreedFood('pig', itemId('beetroot'))).toBe(true);
    expect(isBreedFood('pig', itemId('carrot'))).toBe(true);
    expect(isBreedFood('cow', itemId('wheat'))).toBe(true);
  });
});

describe('placement guard (multiplayer)', () => {
  const at = { x: 0, y: 61, z: 0 };

  it('a crop is paid for with its seed, at age 0 only', () => {
    expect(placingItem(WHEAT, 0)).toBe(itemId('wheat_seeds'));
    expect(placingItem(CROP_BLOCK.POTATOES, 0)).toBe(itemId('potato'));
    expect(placingItem(WHEAT, 7)).toBe(0);
    const g = new InventoryGuard([{ id: itemId('wheat_seeds'), count: 2 }, { id: itemId('carrot'), count: 1 }]);
    expect(g.authorizeEdit(at, B.AIR, 0, WHEAT, 0, B.AIR)).toBe(true);
    expect(g.authorizeEdit(at, B.AIR, 0, WHEAT, 0, B.AIR)).toBe(true);
    expect(g.authorizeEdit(at, B.AIR, 0, WHEAT, 0, B.AIR)).toBe(false); // no seeds left
    expect(g.authorizeEdit(at, B.AIR, 0, CROP_BLOCK.CARROTS, 0, B.AIR)).toBe(true);
    expect(g.authorizeEdit(at, B.AIR, 0, CROP_BLOCK.BEETROOTS, 0, B.AIR)).toBe(false);
    // A ripe crop out of nothing is never accepted, even with seeds.
    const h = new InventoryGuard([{ id: itemId('wheat_seeds'), count: 64 }]);
    expect(h.authorizeEdit(at, B.AIR, 0, WHEAT, 7, B.AIR)).toBe(false);
  });

  it('tilling and trampling are free (no false refusals), breaking a ripe crop credits its loot', () => {
    const g = new InventoryGuard([]);
    expect(classifyEdit(B.GRASS, 0, FARMLAND, 0, B.AIR)).toMatchObject({ kind: 'tool', tool: 'hoe' });
    expect(g.authorizeEdit(at, B.GRASS, 0, FARMLAND, 0, B.AIR)).toBe(true);
    expect(classifyEdit(FARMLAND, 7, B.DIRT, 0, B.AIR)).toEqual({ kind: 'free' });
    expect(g.authorizeEdit(at, FARMLAND, 3, B.DIRT, 0, WHEAT)).toBe(true);
    g.creditBreak(WHEAT, 7);
    expect(g.authorizeDrop(itemId('wheat'), 1)).toBe(true);
    expect(g.authorizeDrop(itemId('wheat_seeds'), 4)).toBe(true);
    expect(g.authorizeDrop(itemId('wheat'), 1)).toBe(false);
  });
});

describe('crop meshing (one texture per crop)', () => {
  const mesher = new ChunkMesher();
  /** Meshes one chunk holding farmland at y 10 and `id`/`meta` on top of it at (4, 11, 4). */
  function meshCrop(id: number, meta: number, farmMeta = 0): ReturnType<ChunkMesher['mesh']> {
    const chunks = Array.from({ length: 9 }, () => new Uint8Array(CHUNK_VOLUME));
    const metas: (Uint8Array | null)[] = Array.from({ length: 9 }, () => null);
    const c = chunks[4], m = new Uint8Array(CHUNK_VOLUME);
    c[blockIndex(4, 10, 4)] = FARMLAND; m[blockIndex(4, 10, 4)] = farmMeta;
    c[blockIndex(4, 11, 4)] = id; m[blockIndex(4, 11, 4)] = meta;
    metas[4] = m;
    return mesher.mesh(chunks, Array.from({ length: 9 }, () => new Uint8Array(CHUNK_AREA)), true, metas);
  }
  const top = (g: { packed: Uint16Array }): number => {
    let max = 0;
    for (let i = 1; i < g.packed.length; i += 4) max = Math.max(max, g.packed[i]);
    return max / 16;
  };
  const tint = (g: { tint: Uint8Array }, v = 0): number => (g.tint[v * 4] << 16) | (g.tint[v * 4 + 1] << 8) | g.tint[v * 4 + 2];

  it('a crop is four double-sided planes as tall as its stage, tinted per stage', () => {
    const young = meshCrop(WHEAT, 0).cutout!;
    expect(young.index.length).toBe(4 * 12);
    expect(top(young) - 11).toBeCloseTo(CROPS[0].heights[0] / 16);
    expect(top(meshCrop(WHEAT, 7).cutout!) - 11).toBe(1);
    expect(tint(young)).toBe(CROPS[0].tints[0]);
    expect(tint(meshCrop(WHEAT, 7).cutout!)).toBe(CROPS[0].tints[7]);
  });

  it('a stem is a cross; an attached stem one plane in the bent texture with the attached colour', () => {
    expect(meshCrop(CROP_BLOCK.MELON_STEM, 3).cutout!.index.length).toBe(2 * 12);
    const att = meshCrop(CROP_BLOCK.MELON_STEM, attachedStemMeta(3)).cutout!;
    expect(att.index.length).toBe(12);
    expect(att.data[0]).toBe(TEXTURE_NAMES.indexOf('attached_stem'));
    expect(tint(att)).toBe(0xe0c71c);
  });

  it('wet farmland is drawn with the darker tint, dry farmland untinted', () => {
    const tintOfTop = (farmMeta: number): number => {
      const g = meshCrop(B.AIR, 0, farmMeta).opaque!;
      for (let v = 0; v < g.data.length / 4; v++) if ((g.data[v * 4 + 1] & 7) === 2) return tint(g, v);
      return -1;
    };
    expect(tintOfTop(0)).toBe(0xffffff);
    expect(tintOfTop(7)).toBe(FARMLAND_WET_TINT);
  });
});

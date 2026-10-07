import { BLOCK, CUBE_ID, SOLID } from './BlockRegistry';
import { type BlockUpdates, type UpdateGrid, registerBlockUpdate, registerSupportedPlant } from './BlockUpdates';
import {
  CROPS, CROP_AGE_MASK, CROP_BLOCK, CROP_MAX_AGE, CROP_STYLE, FARMLAND, FARMLAND_MOISTURE_MASK, FARMLAND_WET, STEM_ATTACHED_BIT, STEM_DX, STEM_DZ,
  attachedStemMeta, cropSpec, isFarmPlant, stemAttached, stemFacing,
} from './Crops';
import { isSoil, plantCanStand } from './PlantRules';
import { RandomTicker, type TickContext } from './RandomTicks';

/**
 * Farming rules, Minecraft Java 1.21 (CropBlock, StemBlock, FarmBlock; numbers checked against minecraft.wiki):
 *
 *  - crops grow on a random tick when the raw light at the crop is ≥ 9 (sky light counts at night too: Minecraft reads
 *    getRawBrightness(pos, 0)), with chance 1 / (⌊25 / f⌋ + 1), f the growth speed below. Beetroots skip 1 in 3 ticks.
 *  - growth speed f: 1, plus for the 3×3 farmland under and around the crop 1 (dry) or 3 (moist) for the block under
 *    it and a quarter of that for each of the 8 around it; halved when the same crop grows on both axes beside it, or on
 *    a diagonal (so rows grow faster than solid blocks of one crop).
 *  - stems grow the same way; a ripe stem places its fruit on a random side (air, on farmland or a #dirt block) and
 *    becomes an attached stem pointing at it; when the fruit goes it is a ripe stem again.
 *  - farmland: water within 4 blocks horizontally on its own level or one above (or rain on it) sets moisture 7,
 *    otherwise it dries one step per random tick; dry farmland with nothing planted turns into dirt. A solid block on
 *    top turns it into dirt, and so does an entity landing on it with chance fallDistance − 0.5 (players, and mobs of
 *    width² × height > 0.512 while mobGriefing is on).
 *  - bone meal adds 2-5 ages (beetroots ⌊(2-5) / 3⌋); a stem that reaches 7 gets a random tick at once.
 * Simplified: crops do not pop off in darkness (Minecraft: raw light < 8 and no sky).
 */

export const CROP_LIGHT = 9;
/** Water this far away horizontally (and on the farmland's level or one above) keeps farmland moist. */
export const WATER_RANGE = 4;

const AIR = BLOCK.AIR;

// ---------------------------------------------------------------- growth speed

type Reader = Pick<TickContext, 'getBlock' | 'getMeta'>;

/** Is the block at a position the same plant (Minecraft's `is(this)`: an attached stem is another block there). */
function sameCrop(w: Reader, id: number, x: number, y: number, z: number): boolean {
  if (w.getBlock(x, y, z) !== id) return false;
  return CROP_STYLE[id] !== 2 || !stemAttached(w.getMeta(x, y, z));
}

/** Minecraft's CropBlock.getGrowthSpeed for the crop `id` at (x, y, z). Between 1 (bare, dry) and 10 (moist field, lone row). */
export function growthSpeed(w: Reader, id: number, x: number, y: number, z: number): number {
  let f = 1;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      let g = 0;
      if (w.getBlock(x + i, y - 1, z + j) === FARMLAND) g = (w.getMeta(x + i, y - 1, z + j) & FARMLAND_MOISTURE_MASK) > 0 ? 3 : 1;
      if (i !== 0 || j !== 0) g /= 4;
      f += g;
    }
  }
  const west = sameCrop(w, id, x - 1, y, z), east = sameCrop(w, id, x + 1, y, z);
  const north = sameCrop(w, id, x, y, z - 1), south = sameCrop(w, id, x, y, z + 1);
  if ((west || east) && (north || south)) f /= 2;
  else if (sameCrop(w, id, x - 1, y, z - 1) || sameCrop(w, id, x + 1, y, z - 1) || sameCrop(w, id, x + 1, y, z + 1) || sameCrop(w, id, x - 1, y, z + 1)) f /= 2;
  return f;
}

/** The growth roll: one in this many random ticks advances the crop (Minecraft: nextInt((int)(25 / f) + 1) == 0). */
export function growthOdds(speed: number): number {
  return Math.floor(25 / speed) + 1;
}

/** Light a crop reads: max(sky, block) at its own cell, without the time of day (getRawBrightness(pos, 0)). */
function rawLight(w: TickContext, x: number, y: number, z: number): number {
  const l = w.getLight(x, y, z);
  return Math.max(l >> 4, l & 15);
}

// ---------------------------------------------------------------- crops

function cropTick(w: TickContext, x: number, y: number, z: number): void {
  const id = w.getBlock(x, y, z);
  if (id === CROP_BLOCK.BEETROOTS && w.randomInt(3) === 0) return;
  if (rawLight(w, x, y, z) < CROP_LIGHT) return;
  const meta = w.getMeta(x, y, z);
  const mask = CROP_AGE_MASK[id];
  const age = meta & mask;
  if (age >= CROP_MAX_AGE[id]) return;
  if (w.randomInt(growthOdds(growthSpeed(w, id, x, y, z))) !== 0) return;
  w.setBlock(x, y, z, id, (meta & ~mask) | (age + 1));
}

/** Bone meal on a crop: 2-5 ages (beetroots a third of that, rounded down), up to ripe. */
function boneMealCrop(w: TickContext, x: number, y: number, z: number): boolean {
  const id = w.getBlock(x, y, z);
  const meta = w.getMeta(x, y, z);
  const mask = CROP_AGE_MASK[id], max = CROP_MAX_AGE[id];
  const age = meta & mask;
  if (age >= max) return false;
  let inc = 2 + w.randomInt(4);
  if (id === CROP_BLOCK.BEETROOTS) inc = Math.floor(inc / 3);
  const next = Math.min(max, age + inc);
  if (next !== age) w.setBlock(x, y, z, id, (meta & ~mask) | next);
  return true;
}

// ---------------------------------------------------------------- stems

function fruitOf(stem: number): number {
  return CUBE_ID[cropSpec(stem)?.fruit ?? ''] ?? 0;
}

/** A ripe stem tries to put its fruit on one random side; true when it did. */
export function growFruit(w: TickContext, x: number, y: number, z: number): boolean {
  const id = w.getBlock(x, y, z);
  const dir = w.randomInt(4);
  const tx = x + STEM_DX[dir], tz = z + STEM_DZ[dir];
  if (w.getBlock(tx, y, tz) !== AIR) return false;
  const below = w.getBlock(tx, y - 1, tz);
  if (below !== FARMLAND && !isSoil(below)) return false;
  w.setBlock(tx, y, tz, fruitOf(id), 0);
  w.setBlock(x, y, z, id, attachedStemMeta(dir));
  return true;
}

function stemTick(w: TickContext, x: number, y: number, z: number): void {
  const id = w.getBlock(x, y, z);
  const meta = w.getMeta(x, y, z);
  if (stemAttached(meta)) return; // attached stems do nothing on their own
  if (rawLight(w, x, y, z) < CROP_LIGHT) return;
  if (w.randomInt(growthOdds(growthSpeed(w, id, x, y, z))) !== 0) return;
  const age = meta & 7;
  if (age < 7) w.setBlock(x, y, z, id, age + 1);
  else growFruit(w, x, y, z);
}

function boneMealStem(w: TickContext, x: number, y: number, z: number): boolean {
  const id = w.getBlock(x, y, z);
  const meta = w.getMeta(x, y, z);
  if (stemAttached(meta) || (meta & 7) >= 7) return false;
  const next = Math.min(7, (meta & 7) + 2 + w.randomInt(4));
  w.setBlock(x, y, z, id, next);
  // Minecraft then gives the ripe stem a random tick (which may grow the fruit).
  if (next === 7) stemTick(w, x, y, z);
  return true;
}

/** Can bone meal do anything to this crop or stem in this state (the client asks before it uses the item up)? */
export function farmBoneMealValid(id: number, meta: number): boolean {
  if (CROP_STYLE[id] === 1) return (meta & CROP_AGE_MASK[id]) < CROP_MAX_AGE[id];
  if (CROP_STYLE[id] === 2) return !stemAttached(meta) && (meta & 7) < 7;
  return false;
}

// ---------------------------------------------------------------- farmland

/** Water within 4 blocks horizontally, on the farmland's level or one above (Minecraft's FarmBlock.isNearWater). */
export function isNearWater(w: Pick<TickContext, 'getBlock'>, x: number, y: number, z: number): boolean {
  for (let dy = 0; dy <= 1; dy++) {
    for (let dz = -WATER_RANGE; dz <= WATER_RANGE; dz++) {
      for (let dx = -WATER_RANGE; dx <= WATER_RANGE; dx++) if (w.getBlock(x + dx, y + dy, z + dz) === BLOCK.WATER) return true;
    }
  }
  return false;
}

/** Blocks that keep dry farmland from turning back into dirt (Minecraft's #maintains_farmland: crops and stems). */
export function maintainsFarmland(id: number): boolean {
  return isFarmPlant(id);
}

function setMoisture(w: TickContext, x: number, y: number, z: number, from: number, to: number): void {
  // Only "wet" or "not wet" shows: the steps in between change the state quietly (saved, not sent or remeshed).
  if (from === FARMLAND_WET || to === FARMLAND_WET) w.setBlock(x, y, z, FARMLAND, to);
  else w.setMeta(x, y, z, to);
}

function farmlandTick(w: TickContext, x: number, y: number, z: number): void {
  const moisture = w.getMeta(x, y, z) & FARMLAND_MOISTURE_MASK;
  if (!isNearWater(w, x, y, z) && !w.rainingAt(x, y + 1, z)) {
    if (moisture > 0) setMoisture(w, x, y, z, moisture, moisture - 1);
    else if (!maintainsFarmland(w.getBlock(x, y + 1, z))) w.setBlock(x, y, z, BLOCK.DIRT, 0);
  } else if (moisture < FARMLAND_WET) setMoisture(w, x, y, z, moisture, FARMLAND_WET);
}

/** Minecraft's FarmBlock.fallOn: the chance that landing after falling `fall` blocks tramples farmland. */
export function trampleChance(fall: number): number {
  return Math.max(0, Math.min(1, fall - 0.5));
}

/** Big enough to trample (Minecraft: bounding box width² × height > 0.512; players 0.648, chickens 0.112). */
export function canTrample(width: number, height: number): boolean {
  return width * width * height > 0.512;
}

/**
 * An entity landed on the block at (x, y, z) after falling `fall` blocks: farmland turns into dirt with
 * {@link trampleChance} (`roll` in [0, 1)). The crop on top pops off by the usual block update. True when trampled.
 */
export function trample(
  world: { getBlock(x: number, y: number, z: number): number; setBlock(x: number, y: number, z: number, id: number, meta?: number): unknown },
  x: number, y: number, z: number, fall: number, roll: number,
): boolean {
  if (world.getBlock(x, y, z) !== FARMLAND || roll >= trampleChance(fall)) return false;
  const r = world.setBlock(x, y, z, BLOCK.DIRT, 0);
  return r !== false && r !== -1;
}

// ---------------------------------------------------------------- neighbour updates

/** A solid block on top of farmland turns it into dirt (FarmBlock.canSurvive). */
function farmlandUpdate(_sim: BlockUpdates, grid: UpdateGrid, x: number, y: number, z: number): void {
  if (grid.getBlock(x, y, z) !== FARMLAND) return;
  const above = grid.getBlock(x, y + 1, z);
  if (above !== BLOCK.UNLOADED && SOLID[above]) grid.setState(x, y, z, BLOCK.DIRT, 0);
}

/** Stems: off when the farmland goes; an attached stem whose fruit is gone is a ripe stem again. */
function stemUpdate(sim: BlockUpdates, grid: UpdateGrid, x: number, y: number, z: number): void {
  const id = grid.getBlock(x, y, z);
  const meta = grid.getMeta(x, y, z);
  if (!plantCanStand(id, (a, b, c) => grid.getBlock(a, b, c), x, y, z)) {
    grid.setState(x, y, z, AIR, 0);
    sim.onBroken?.(x, y, z, id, meta);
    return;
  }
  if (!stemAttached(meta)) return;
  const f = stemFacing(meta);
  const fruit = grid.getBlock(x + STEM_DX[f], y, z + STEM_DZ[f]);
  if (fruit !== BLOCK.UNLOADED && fruit !== fruitOf(id)) grid.setState(x, y, z, id, 7);
}

registerBlockUpdate(FARMLAND, farmlandUpdate);
for (const c of CROPS) {
  if (c.style === 2) registerBlockUpdate(c.id, stemUpdate);
  else registerSupportedPlant(c.id);
}

// ---------------------------------------------------------------- registration

type BoneMealFn = (w: TickContext, x: number, y: number, z: number) => boolean;

/** Random tick handlers (registered on RandomTicker) and the bone meal handlers, for Growth.registerGrowthRules. */
export function registerFarmingRules(registerBoneMeal: (id: number, fn: BoneMealFn, valid: (meta: number) => boolean) => void): void {
  RandomTicker.register(FARMLAND, farmlandTick);
  for (const c of CROPS) {
    RandomTicker.register(c.id, c.style === 2 ? stemTick : cropTick);
    registerBoneMeal(c.id, c.style === 2 ? boneMealStem : boneMealCrop, (meta) => farmBoneMealValid(c.id, meta));
  }
}

/** Block state as Minecraft's F3 lists it ("age: 3" ...), or null for blocks without farming state. */
export function farmStateText(id: number, meta: number): string | null {
  if (id === FARMLAND) return `moisture: ${meta & FARMLAND_MOISTURE_MASK}`;
  const style = CROP_STYLE[id];
  if (style === 0) return null;
  if (style === 2 && (meta & STEM_ATTACHED_BIT)) return `attached, facing: ${['north', 'south', 'west', 'east'][stemFacing(meta)]}`;
  return `age: ${meta & CROP_AGE_MASK[id]} (of ${CROP_MAX_AGE[id]})`;
}

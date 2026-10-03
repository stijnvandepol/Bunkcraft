import {
  BLOCK, CUBE_ID, LEAVES_PERSISTENT_BIT, OPAQUE, SAPLING_STAGE_BIT, SHAPE, SHAPE_CROSS,
} from './BlockRegistry';
import { CHUNK_HEIGHT } from './constants';
import { liquidAmount } from './Liquids';
import { isLeaves, isLog, plantCanStand } from './PlantRules';
import { type RandomTickHost, type RandomTickOptions, RandomTicker, type TickContext } from './RandomTicks';
import { SAPLING_TYPES, type TreeSink, placeTree, planTree } from './Trees';
import { Precip, precipitationFor } from './Weather';

/**
 * What grows, spreads and decays on a random tick (Minecraft 1.21 rules; see docs/research/MECHANICS.md §3.3).
 * Every rule is a RandomTickHandler registered on RandomTicker, so another system (farming) adds its own the same way.
 *
 * Numbers that come from Minecraft and are fine: sapling 1/7 per random tick per stage, leaf decay beyond 6 blocks
 * from a log, grass spread to dirt within (±1, −3..+1, ±1) four times per tick at light ≥ 9, cane and cactus 3 high
 * with age 0-15, mushrooms 1/25 and at most 4 others within 9×3×9. Uncertain or simplified:
 *  - sapling light: Minecraft 1.21 wants raw brightness ≥ 9 (older versions 8); 9 is used;
 *  - dark oak and jungle grow from one sapling (Minecraft needs 2×2) and have no big variants;
 *  - leaves are persistent when placed by a player (state bit 0) instead of Minecraft's `distance` property: the
 *    distance is recomputed on the random tick, which also covers logs removed by explosions.
 */

export const SAPLING_LIGHT = 9;
export const SAPLING_GROW_ODDS = 7;
/** Leaves further than this many steps (through other leaves) from a log decay. */
export const LEAF_REACH = 6;
export const CANE_MAX_HEIGHT = 3;
export const BONE_MEAL_SAPLING_CHANCE = 0.45;

const B = BLOCK;

// ---------------------------------------------------------------- trees

const probeCells: number[] = [];
let probeBlocked = false;

/** Collects the trunk cells of a planned tree and notes leaf cells in chunks that are not loaded. */
function probeSink(w: TickContext): TreeSink {
  return {
    leaf: (x, y, z) => { if (w.getBlock(x, y, z) === B.UNLOADED) probeBlocked = true; },
    log: (x, y, z) => { probeCells.push(x, y, z); },
    trunkBase: () => undefined,
  };
}

function replaceable(id: number): boolean {
  return id === B.AIR || isLeaves(id) || SHAPE[id] === SHAPE_CROSS;
}

function worldSink(w: TickContext): TreeSink {
  return {
    leaf: (x, y, z, id) => {
      const cur = w.getBlock(x, y, z);
      if (cur === B.AIR || SHAPE[cur] === SHAPE_CROSS) w.setBlock(x, y, z, id, 0);
    },
    log: (x, y, z, id) => {
      if (replaceable(w.getBlock(x, y, z))) w.setBlock(x, y, z, id, 0);
    },
    trunkBase: (x, y, z) => {
      const under = w.getBlock(x, y - 1, z);
      if (under === B.GRASS || under === B.SNOWY_GRASS) w.setBlock(x, y - 1, z, B.DIRT, 0);
    },
  };
}

/**
 * Grows the sapling at (x, y, z) into a tree if the trunk has room (its cells hold air, leaves or small plants).
 * Returns true when the tree was placed.
 */
export function growTree(w: TickContext, x: number, y: number, z: number): boolean {
  const meta = w.getMeta(x, y, z);
  let variant = meta & 7;
  if (variant >= SAPLING_TYPES.length) variant = 0;
  const plan = planTree(variant, () => w.random());
  probeCells.length = 0;
  probeBlocked = false;
  placeTree(probeSink(w), plan, x, y, z, CHUNK_HEIGHT);
  if (probeBlocked || probeCells.length === 0) return false;
  for (let i = 0; i < probeCells.length; i += 3) {
    const id = w.getBlock(probeCells[i], probeCells[i + 1], probeCells[i + 2]);
    if (!replaceable(id)) return false;
  }
  // The sapling stands in the trunk's first cell: clear it so the log replaces it.
  placeTree(worldSink(w), plan, x, y, z, CHUNK_HEIGHT);
  return w.getBlock(x, y, z) !== B.SAPLING;
}

/** One growth step of a sapling: stage 0 → 1, then the tree. Returns true when something changed. */
export function advanceSapling(w: TickContext, x: number, y: number, z: number): boolean {
  const meta = w.getMeta(x, y, z);
  if ((meta & SAPLING_STAGE_BIT) === 0) {
    w.setMeta(x, y, z, meta | SAPLING_STAGE_BIT);
    return true;
  }
  return growTree(w, x, y, z);
}

function saplingTick(w: TickContext, x: number, y: number, z: number): void {
  if (w.brightness(x, y + 1, z) < SAPLING_LIGHT) return;
  if (w.randomInt(SAPLING_GROW_ODDS) !== 0) return;
  advanceSapling(w, x, y, z);
}

// ---------------------------------------------------------------- leaves

/** Search window around a leaf: ±LEAF_REACH on every axis. */
const WIN = 2 * LEAF_REACH + 1;
const stamp = new Uint32Array(WIN * WIN * WIN);
const queue = new Int32Array(WIN * WIN * WIN * 4);
let stampEpoch = 0;

/**
 * Is the leaf at (x, y, z) connected to a log by at most LEAF_REACH steps through leaves (Minecraft's leaf `distance`
 * ≤ 6)? Cells of chunks that are not loaded count as "maybe": the leaf stays until it can be judged.
 */
export function leafSupported(w: Pick<TickContext, 'getBlock'>, x: number, y: number, z: number): boolean {
  if (++stampEpoch === 0xffffffff) { stamp.fill(0); stampEpoch = 1; }
  const epoch = stampEpoch;
  let head = 0, tail = 0;
  const cell = (dx: number, dy: number, dz: number): number => ((dx + LEAF_REACH) * WIN + (dy + LEAF_REACH)) * WIN + (dz + LEAF_REACH);
  stamp[cell(0, 0, 0)] = epoch;
  queue[tail++] = 0; queue[tail++] = 0; queue[tail++] = 0; queue[tail++] = 0;
  while (head < tail) {
    const dx = queue[head++], dy = queue[head++], dz = queue[head++], depth = queue[head++];
    for (let f = 0; f < 6; f++) {
      const nx = dx + (f === 0 ? 1 : f === 1 ? -1 : 0);
      const ny = dy + (f === 2 ? 1 : f === 3 ? -1 : 0);
      const nz = dz + (f === 4 ? 1 : f === 5 ? -1 : 0);
      const id = w.getBlock(x + nx, y + ny, z + nz);
      if (isLog(id) || id === B.UNLOADED) return true;
      if (depth + 1 >= LEAF_REACH || !isLeaves(id)) continue;
      const c = cell(nx, ny, nz);
      if (stamp[c] === epoch) continue;
      stamp[c] = epoch;
      queue[tail++] = nx; queue[tail++] = ny; queue[tail++] = nz; queue[tail++] = depth + 1;
    }
  }
  return false;
}

function leavesTick(w: TickContext, x: number, y: number, z: number): void {
  if ((w.getMeta(x, y, z) & LEAVES_PERSISTENT_BIT) !== 0) return;
  if (leafSupported(w, x, y, z)) return;
  w.breakBlock(x, y, z);
}

// ---------------------------------------------------------------- grass, mycelium

/** Can grass live at (x, y, z): nothing opaque and no full water on top (Minecraft's canBeGrass). */
function canBeGrass(w: TickContext, x: number, y: number, z: number): boolean {
  const above = w.getBlock(x, y + 1, z);
  if (above === B.UNLOADED) return true;
  if (above === B.WATER && liquidAmount(w.getMeta(x, y + 1, z)) === 8) return false;
  return OPAQUE[above] === 0;
}

function spreadingTick(self: number): (w: TickContext, x: number, y: number, z: number) => void {
  return (w, x, y, z) => {
    if (!canBeGrass(w, x, y, z)) {
      w.setBlock(x, y, z, B.DIRT, 0);
      return;
    }
    if (w.brightness(x, y + 1, z) < 9) return;
    for (let i = 0; i < 4; i++) {
      const tx = x + w.randomInt(3) - 1, ty = y + w.randomInt(5) - 3, tz = z + w.randomInt(3) - 1;
      if (w.getBlock(tx, ty, tz) === B.DIRT && canBeGrass(w, tx, ty, tz) && w.getBlock(tx, ty + 1, tz) !== B.WATER) w.setBlock(tx, ty, tz, self, 0);
    }
  };
}

// ---------------------------------------------------------------- sugar cane, cactus

function stackHeight(w: TickContext, id: number, x: number, y: number, z: number): number {
  let h = 1;
  while (w.getBlock(x, y - h, z) === id) h++;
  return h;
}

/** Cane and cactus: age 0-15 in the state; at 15 with air above and fewer than three in the stack, one grows on top. */
function stackTick(id: number): (w: TickContext, x: number, y: number, z: number) => void {
  return (w, x, y, z) => {
    if (!plantCanStand(id, (a, b, c) => w.getBlock(a, b, c), x, y, z)) {
      w.breakBlock(x, y, z);
      return;
    }
    if (w.getBlock(x, y + 1, z) !== B.AIR) return;
    if (stackHeight(w, id, x, y, z) >= CANE_MAX_HEIGHT) return;
    const age = w.getMeta(x, y, z) & 15;
    if (age < 15) {
      w.setMeta(x, y, z, age + 1);
      return;
    }
    // The new block must be able to stand there too (a cactus beside a wall would pop off at once).
    if (!plantCanStand(id, (a, b, c) => w.getBlock(a, b, c), x, y + 1, z)) return;
    w.setBlock(x, y + 1, z, id, 0);
    w.setMeta(x, y, z, 0);
  };
}

// ---------------------------------------------------------------- mushrooms

function mushroomCanStand(w: TickContext, x: number, y: number, z: number): boolean {
  const below = w.getBlock(x, y - 1, z);
  if (below === CUBE_ID.mycelium || below === CUBE_ID.podzol) return true;
  return OPAQUE[below] === 1 && w.brightness(x, y, z) < 13;
}

function mushroomTick(id: number): (w: TickContext, x: number, y: number, z: number) => void {
  return (w, x, y, z) => {
    if (w.randomInt(25) !== 0) return;
    // At most four others within 9 x 3 x 9.
    let left = 5;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) if (w.getBlock(x + dx, y + dy, z + dz) === id && --left <= 0) return;
      }
    }
    // Minecraft: a short random walk that only moves onto valid cells, then one last try from where it ended.
    let px = x, py = y, pz = z;
    let tx = px + w.randomInt(3) - 1, ty = py + w.randomInt(2) - w.randomInt(2), tz = pz + w.randomInt(3) - 1;
    for (let i = 0; i < 4; i++) {
      if (w.getBlock(tx, ty, tz) === B.AIR && mushroomCanStand(w, tx, ty, tz)) { px = tx; py = ty; pz = tz; }
      tx = px + w.randomInt(3) - 1; ty = py + w.randomInt(2) - w.randomInt(2); tz = pz + w.randomInt(3) - 1;
    }
    if (w.getBlock(tx, ty, tz) === B.AIR && mushroomCanStand(w, tx, ty, tz)) w.setBlock(tx, ty, tz, id, 0);
  };
}

// ---------------------------------------------------------------- ice

/** Water freezes at the shore in cold biomes (Minecraft's shouldFreeze): a surface source with a non-water neighbour, block light < 10. */
function freezeSurface(w: TickContext, x: number, y: number, z: number, id: number): void {
  if (id !== B.WATER || w.getMeta(x, y, z) !== 0) return;
  if (precipitationFor(w.biomeAt(x, z), y) !== Precip.SNOW) return;
  if ((w.getLight(x, y + 1, z) & 15) >= 10) return;
  if (w.getBlock(x + 1, y, z) === B.WATER && w.getBlock(x - 1, y, z) === B.WATER
    && w.getBlock(x, y, z + 1) === B.WATER && w.getBlock(x, y, z - 1) === B.WATER) return;
  w.setBlock(x, y, z, CUBE_ID.ice, 0);
}

/** Ice melts next to a strong light (block light above 11) back into a water source. */
function iceTick(w: TickContext, x: number, y: number, z: number): void {
  if ((w.getLight(x, y, z) & 15) > 11) w.setBlock(x, y, z, B.WATER, 0);
}

// ---------------------------------------------------------------- bone meal

const BONE_MEAL_FLOWERS = [B.DANDELION, B.POPPY];

/** What bone meal can do to this block (the item is only used up when this is true). */
export function canBoneMeal(id: number): boolean {
  return id === B.SAPLING || id === B.GRASS;
}

/**
 * Bone meal on the block at (x, y, z). A sapling advances with a 45% chance; grass scatters tall grass and the odd
 * flower around it. Returns true when the item is used up (also when a sapling fails to grow, like Minecraft).
 * Crops and other blocks can register their own with `registerBoneMeal`.
 */
export function useBoneMeal(w: TickContext, x: number, y: number, z: number): boolean {
  const id = w.getBlock(x, y, z);
  const custom = BONE_MEAL[id];
  if (custom) return custom(w, x, y, z);
  if (id === B.SAPLING) {
    if (w.random() < BONE_MEAL_SAPLING_CHANCE) advanceSapling(w, x, y, z);
    return true;
  }
  if (id === B.GRASS) {
    if (w.getBlock(x, y + 1, z) !== B.AIR) return false;
    for (let i = 0; i < 40; i++) {
      const tx = x + w.randomInt(7) - 3, tz = z + w.randomInt(7) - 3, ty = y + w.randomInt(3) - 1;
      if (w.getBlock(tx, ty, tz) !== B.GRASS || w.getBlock(tx, ty + 1, tz) !== B.AIR) continue;
      w.setBlock(tx, ty + 1, tz, w.randomInt(8) === 0 ? BONE_MEAL_FLOWERS[w.randomInt(BONE_MEAL_FLOWERS.length)] : B.TALL_GRASS, 0);
    }
    return true;
  }
  return false;
}

const BONE_MEAL: (((w: TickContext, x: number, y: number, z: number) => boolean) | undefined)[] = [];
const BONE_MEAL_IDS = new Set<number>();

/** Teaches bone meal to act on another block (crops): return true when the item was used. */
export function registerBoneMeal(blockId: number, fn: (w: TickContext, x: number, y: number, z: number) => boolean): void {
  BONE_MEAL[blockId] = fn;
  BONE_MEAL_IDS.add(blockId);
}

/** Can bone meal do anything to this block (client side check before it asks the server)? */
export function boneMealTarget(id: number): boolean {
  return canBoneMeal(id) || BONE_MEAL_IDS.has(id);
}

// ---------------------------------------------------------------- registration

let registered = false;

/** Registers every growth rule on RandomTicker (idempotent). */
export function registerGrowthRules(): void {
  if (registered) return;
  registered = true;
  RandomTicker.register(B.SAPLING, saplingTick);
  for (let id = 0; id < 256; id++) if (isLeaves(id)) RandomTicker.register(id, leavesTick);
  RandomTicker.register(B.GRASS, spreadingTick(B.GRASS));
  RandomTicker.register(CUBE_ID.mycelium, spreadingTick(CUBE_ID.mycelium));
  RandomTicker.register(CUBE_ID.sugar_cane, stackTick(CUBE_ID.sugar_cane));
  RandomTicker.register(B.CACTUS, stackTick(B.CACTUS));
  RandomTicker.register(CUBE_ID.brown_mushroom, mushroomTick(CUBE_ID.brown_mushroom));
  RandomTicker.register(CUBE_ID.red_mushroom, mushroomTick(CUBE_ID.red_mushroom));
  RandomTicker.register(CUBE_ID.ice, iceTick);
  RandomTicker.registerSurface(freezeSurface);
}

/** A ticker with all growth rules registered. */
export function createRandomTicker(host: RandomTickHost, opts?: RandomTickOptions): RandomTicker {
  registerGrowthRules();
  return new RandomTicker(host, opts);
}

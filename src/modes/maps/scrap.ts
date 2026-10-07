import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, jumpPad, turn, turned } from './helpers';
import { C, car, crates, lamp, steps } from './props';

/**
 * "Scrapyard": a junkyard (60 × 42). Walls of crushed cars stacked two and three high make a maze of
 * narrow lanes; a gantry crane straddles the middle with a car hanging from its magnet over the centre.
 * Each team spawns behind the sheet-metal fence of its gate yard; next to it stands the yard office on
 * stilts, whose windows look down the lanes.
 *
 * Three lanes: the tyre lane (a climbable tyre mountain, the office), the crusher lane through the middle
 * (the car crusher, oil drums, the gantry), and the stack lane (rows of crushed cars, a camper van).
 * Point symmetric: one team's tyre lane is the other team's stack lane.
 */

interface Side { fence: number; van: number }

const WEST: Side = { fence: C.RAW_IRON_BLOCK, van: BLOCK.WHITE_WOOL };
const EAST: Side = { fence: C.RAW_COPPER_BLOCK, van: C.CALCITE };

const RED_SPAWNS: [number, number][] = [[-28, -8], [-25, -5], [-28, -2], [-25, 1], [-28, 4], [-25, 7]];
const FFA_WEST: [number, number][] = [[-26, -17], [-27, 16], [-18, -3], [-18, -14], [-15, 16], [-4, -7]];

/** Crushed cars: flat slabs of colour, one block high each, in a stack. */
const CRUSHED = [C.LAPIS_BLOCK, BLOCK.YELLOW_WOOL, C.RAW_COPPER_BLOCK, BLOCK.WHITE_WOOL, BLOCK.GREEN_WOOL, C.COPPER_BLOCK, C.RAW_IRON_BLOCK, C.CHERRY_PLANKS];

/** A stack of crushed cars over a box of cells, `h` high, every layer a different colour. */
function stack(b: LayoutBuilder, x0: number, x1: number, z0: number, z1: number, h: number, seed: number): void {
  for (let i = 0; i < h; i++) b.box(x0, x1, z0, z1, i + 1, i + 1, CRUSHED[(seed + i * 3) % CRUSHED.length]);
}

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Gate yard (spawn): a sheet-metal fence with two gaps, baffles, a guard hut -----------
  paint(-29, -23, -10, 9, BLOCK.GRAVEL);
  paint(-29, -29, -2, 1, TEAM);
  box(-22, -22, -10, 9, 1, 3, p.fence);
  box(-22, -22, -10, 9, 4, 4, TEAM);
  box(-29, -22, -11, -11, 1, 3, p.fence);
  box(-29, -22, 10, 10, 1, 3, p.fence);
  box(-22, -22, -8, -7, 1, 4, AIR);
  box(-22, -22, 5, 6, 1, 4, AIR);
  box(-26, -25, -11, -11, 1, 3, AIR);
  box(-27, -26, 10, 10, 1, 3, AIR);
  stack(t, -24, -24, -9, -6, 2, 1);
  stack(t, -24, -24, 4, 7, 2, 4);
  // Guard hut with a barrier arm.
  box(-29, -27, 6, 8, 1, 3, BLOCK.WHITE_WOOL);
  box(-28, -28, 7, 7, 1, 2, AIR);
  box(-28, -28, 6, 6, 1, 2, AIR);
  box(-29, -27, 6, 8, 4, 4, C.RAW_IRON_BLOCK);
  box(-27, -27, 7, 7, 2, 2, BLOCK.GLASS);
  lamp(t, -23, -2, 4);

  // --- The yard office on stilts, stairs up, windows over the tyre lane and the yard ---------
  for (const [x, z] of [[-28, -19], [-22, -19], [-28, -14], [-22, -14]]) box(x, x, z, z, 1, 3, C.STRIPPED_SPRUCE_LOG);
  box(-28, -22, -19, -14, 4, 4, BLOCK.SPRUCE_PLANKS);
  box(-28, -22, -19, -14, 5, 7, C.RAW_IRON_BLOCK);
  box(-27, -23, -18, -15, 5, 7, AIR);
  box(-28, -22, -19, -14, 8, 8, C.RAW_COPPER_BLOCK);
  box(-22, -22, -18, -16, 5, 6, AIR);
  box(-26, -24, -14, -14, 5, 6, AIR);
  box(-25, -24, -19, -19, 6, 6, BLOCK.GLASS);
  box(-28, -28, -16, -15, 5, 5, AIR);
  box(-27, -26, -18, -18, 5, 5, BLOCK.CRAFTING_TABLE);
  box(-23, -23, -15, -15, 5, 6, BLOCK.CHEST);
  box(-25, -25, -16, -16, 7, 7, BLOCK.GLOWSTONE);
  steps(t, -29, -12, 0, -1, 3, 1, BLOCK.SPRUCE_PLANKS);
  box(-29, -29, -15, -15, 1, 4, BLOCK.SPRUCE_PLANKS);
  box(-29, -29, -16, -16, 4, 4, BLOCK.SPRUCE_PLANKS);

  // --- Tyre lane (north): a tyre mountain to climb, stacks, a forklift ---------------------
  paint(-21, -1, -20, -12, C.COARSE_DIRT);
  for (let h = 1; h <= 3; h++) box(-17 + h, -10 - h, -19 + h - 1, -14 - h + 1, h, h, C.COAL_BLOCK);
  box(-14, -14, -17, -17, 4, 4, C.COAL_BLOCK);
  stack(t, -20, -18, -12, -12, 3, 2);
  stack(t, -8, -4, -12, -12, 2, 5);
  stack(t, -4, -2, -20, -18, 3, 6);
  box(-7, -6, -19, -18, 1, 1, BLOCK.YELLOW_WOOL);
  box(-7, -7, -19, -18, 2, 3, BLOCK.IRON_BARS);
  box(-6, -6, -19, -18, 2, 2, BLOCK.GLASS);
  jumpPad(t, -9, -15);

  // --- Crusher lane (middle): the car crusher, oil drums, a pile of engines ------------------
  paint(-21, -1, -6, 5, C.PACKED_MUD);
  box(-17, -12, -6, -3, 1, 4, C.IRON_BLOCK);
  box(-16, -13, -5, -4, 1, 2, AIR);
  box(-16, -13, -5, -4, 1, 1, C.LAPIS_BLOCK);
  box(-17, -12, -6, -3, 5, 5, BLOCK.YELLOW_WOOL);
  box(-15, -14, -5, -4, 5, 6, C.IRON_BLOCK);
  box(-17, -17, -3, -3, 1, 2, BLOCK.REDSTONE_LAMP);
  for (const [x, z] of [[-8, 2], [-7, 3], [-9, 3], [-19, 3]]) box(x, x, z, z, 1, 2, x === -19 ? BLOCK.GREEN_WOOL : C.COPPER_BLOCK);
  crates(t, -11, 2, 2, 2, 1, C.RAW_IRON_BLOCK);
  box(-4, -3, -3, -3, 1, 1, BLOCK.ANVIL);
  stack(t, -20, -20, -2, 0, 2, 7);
  car(t, -9, -10, true, C.CHERRY_PLANKS);

  // --- Junk around the gantry: short stacks, a wreck, tyres and drums (the ring round the middle)
  stack(t, -7, -5, -8, -8, 2, 2);
  stack(t, -9, -9, 4, 7, 3, 5);
  car(t, -6, 7, true, C.RAW_COPPER_BLOCK);
  box(-4, -3, -10, -9, 1, 2, C.COAL_BLOCK);
  box(-8, -8, -3, -2, 1, 1, C.COPPER_BLOCK);
  box(-6, -6, 3, 3, 1, 1, C.IRON_BLOCK);
  stack(t, -11, -11, -9, -7, 2, 3);

  // --- Stack lane (south): rows of crushed cars, a camper van, a shed ------------------------
  paint(-21, -1, 11, 19, BLOCK.GRAVEL);
  stack(t, -20, -15, 11, 11, 3, 3);
  stack(t, -12, -8, 11, 11, 2, 0);
  stack(t, -20, -17, 15, 15, 2, 6);
  stack(t, -13, -10, 15, 16, 3, 1);
  // Camper van: a cab, a boxy body with a window, a door to hide in.
  box(-7, -1, 17, 19, 1, 3, p.van);
  box(-6, -2, 18, 18, 1, 2, AIR);
  box(-4, -3, 17, 17, 1, 2, AIR);
  box(-7, -7, 18, 18, 2, 2, BLOCK.GLASS);
  box(-1, -1, 17, 19, 2, 2, BLOCK.GLASS);
  box(-5, -5, 19, 19, 2, 2, BLOCK.GLASS);
  box(-7, -1, 17, 19, 3, 3, C.COPPER_BLOCK);
  box(-6, -6, 17, 17, 1, 1, C.COAL_BLOCK);
  box(-2, -2, 19, 19, 1, 1, C.COAL_BLOCK);
  box(-21, -19, 18, 19, 1, 2, C.RAW_COPPER_BLOCK);
  lamp(t, -14, 19, 4);
  box(-1, -1, 13, 14, 1, 2, BLOCK.TNT);
}

export const SCRAP: FreeArenaMapDef = {
  layout: 'free',
  id: 'scrap',
  name: 'Scrapyard',
  description: 'A junkyard maze: crushed-car walls, a tyre mountain, a car crusher and a gantry crane',
  halfX: 30,
  halfZ: 21,
  wallHeight: 13,
  wallBlock: C.RAW_IRON_BLOCK,
  floorBlock: C.COARSE_DIRT,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-14, -17], turn([-14, -17]), [-6, -12], turn([-6, -12])],
  objectives: {
    zones: [
      { name: 'Gantry', x: 0, z: 0, r: 5, level: 0 },
      { name: 'Crusher', x: -15.5, z: 0.5, r: 4 },
      { name: 'Press', x: 15.5, z: -0.5, r: 4 },
      { name: 'Tyres', x: -10.5, z: -9.5, r: 4 },
      { name: 'Stacks', x: 10.5, z: 9.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -27.5, z: 15.5 }, { team: 'blue', x: 27.5, z: -15.5 }],
  },
  build(_variant, b) {
    const { box } = b;
    half(b, 1, WEST);
    half(b, -1, EAST);
    // The gantry crane over the middle: two legs, a beam, the magnet and the car hanging from it.
    for (const s of [1, -1] as const) {
      const t = turned(b, s);
      t.box(-9, -9, -1, 0, 1, 8, BLOCK.YELLOW_WOOL);
      t.box(-9, -9, -1, 0, 1, 1, C.COAL_BLOCK);
    }
    box(-9, 8, -1, 0, 9, 9, BLOCK.YELLOW_WOOL);
    box(-1, 0, -1, 0, 8, 8, BLOCK.FENCE);
    box(-1, 0, -1, 0, 7, 7, C.IRON_BLOCK);
    box(-2, 1, -1, 0, 6, 6, C.LAPIS_BLOCK);
    box(-1, 0, -1, 0, 5, 5, BLOCK.GLASS);
  },
};

import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, jumpPad, turn, turned } from './helpers';
import { C, crates, lamp, steps } from './props';

/**
 * "Rebar": a building site (64 × 44). In the middle stands the concrete shell of an office block: open
 * columns on the ground floor, a first-floor slab with a big atrium hole over the middle, and a small top
 * deck in two corners, reached by a ramp outside, a stair core inside and a jump pad. Each team spawns in
 * its own fenced site compound with an office container; between the compound and the shell lies the
 * material yard (pallets, brick stacks, cable drums, a cement silo).
 *
 * Three lanes: the excavation lane along one side (a gravel mound to climb, an excavator, a timber
 * stack), the shell itself through the middle (ground floor or slab), and the scaffold lane along the
 * other side, where a scaffold along a half-built brick wall is a raised walkway. Point symmetric: one
 * team's excavation lane is the other team's scaffold lane. A tower crane stands over each lane.
 */

interface Side {
  machine: number;
  container: number;
  potty: number;
}

const WEST: Side = { machine: BLOCK.YELLOW_WOOL, container: C.COPPER_BLOCK, potty: BLOCK.GREEN_WOOL };
const EAST: Side = { machine: BLOCK.YELLOW_WOOL, container: C.LAPIS_BLOCK, potty: C.EMERALD_BLOCK };

const RED_SPAWNS: [number, number][] = [[-30, -8], [-27, -6], [-30, -3], [-26, -1], [-30, 1], [-28, 8]];
const FFA_WEST: [number, number][] = [[-29, -18], [-29, 17], [-18, -4], [-14, -20], [-18, 16], [-6, 2]];

const CONCRETE = C.SMOOTH_STONE;
const BLOCKWORK = C.POLISHED_ANDESITE;

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Site compound (spawn): hoarding in the team colour, gates with baffles, an office ----
  paint(-31, -25, -11, 10, BLOCK.GRAVEL);
  paint(-31, -31, -2, 1, TEAM);
  box(-24, -24, -11, 10, 1, 3, BLOCK.BIRCH_PLANKS);
  box(-24, -24, -11, 10, 4, 4, TEAM);
  box(-31, -24, -12, -12, 1, 3, BLOCK.BIRCH_PLANKS);
  box(-31, -24, -12, -12, 4, 4, TEAM);
  box(-31, -24, 11, 11, 1, 3, BLOCK.BIRCH_PLANKS);
  box(-31, -24, 11, 11, 4, 4, TEAM);
  box(-24, -24, -9, -8, 1, 4, AIR);
  box(-24, -24, 7, 8, 1, 4, AIR);
  box(-28, -27, -12, -12, 1, 4, AIR);
  box(-30, -29, 11, 11, 1, 4, AIR);
  // Baffles inside the gates: porta-potties and a pallet stack.
  box(-26, -26, -9, -8, 1, 3, p.potty);
  box(-26, -26, -9, -8, 2, 2, BLOCK.WHITE_WOOL);
  crates(t, -26, 7, 1, 2, 2, BLOCK.SPRUCE_PLANKS);
  box(-28, -27, -10, -10, 1, 2, BLOCK.BRICKS);
  box(-30, -29, 9, 9, 1, 1, BLOCK.BRICKS);
  // Office container: a door, a window, a desk inside, a roof with a railing reached by steps.
  box(-31, -27, 3, 5, 1, 2, p.container);
  box(-30, -28, 4, 4, 1, 2, AIR);
  box(-31, -27, 3, 5, 3, 3, BLOCK.WHITE_WOOL);
  box(-29, -29, 3, 3, 1, 2, AIR);
  box(-27, -27, 4, 4, 2, 2, BLOCK.GLASS);
  box(-30, -30, 4, 4, 1, 1, BLOCK.CRAFTING_TABLE);
  steps(t, -27, 0, 0, 1, 3, 1, BLOCK.SPRUCE_PLANKS);
  box(-31, -31, 3, 5, 4, 4, BLOCK.FENCE);
  box(-31, -27, 5, 5, 4, 4, BLOCK.FENCE);
  lamp(t, -25, -11, 4);
  lamp(t, -25, 10, 4);

  // --- The shell: columns, the first-floor slab with the atrium hole, a top deck -------------
  paint(-9, -1, -9, 8, CONCRETE);
  for (const x of [-9, -5]) for (const z of [-9, -5, 4, 8]) box(x, x, z, z, 1, 3, CONCRETE);
  box(-9, -1, -9, 8, 4, 4, CONCRETE);
  box(-4, -1, -3, 2, 4, 4, AIR);
  // Blockwork infill between some columns (half built), with openings.
  box(-9, -9, -8, -6, 1, 2, BLOCKWORK);
  box(-9, -9, 5, 7, 1, 1, BLOCKWORK);
  box(-8, -6, 8, 8, 1, 3, BLOCKWORK);
  box(-7, -7, 8, 8, 1, 2, AIR);
  box(-4, -2, -9, -9, 1, 1, BLOCKWORK);
  // Ground floor clutter: drywall stacks, a scissor lift, cable drums, bags of cement.
  box(-7, -6, -3, -2, 1, 2, C.CALCITE);
  box(-3, -2, 5, 6, 1, 1, p.machine);
  box(-3, -3, 5, 5, 2, 3, BLOCK.IRON_BARS);
  box(-3, -2, 5, 6, 3, 3, p.machine);
  box(-8, -8, 1, 1, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-4, -4, -6, -5, 1, 1, C.PACKED_MUD);
  box(-6, -6, -7, -7, 3, 3, BLOCK.GLOWSTONE);
  box(-6, -6, 6, 6, 3, 3, BLOCK.GLOWSTONE);
  // Stair core inside (three steps, a hole in the slab above them).
  box(-8, -7, 5, 5, 1, 1, BLOCKWORK);
  box(-8, -7, 6, 6, 1, 2, BLOCKWORK);
  box(-8, -7, 7, 7, 1, 3, BLOCKWORK);
  box(-8, -7, 5, 7, 4, 4, AIR);
  // Ramp outside along the north face up to the slab.
  steps(t, -13, -9, 1, 0, 4, 2, CONCRETE);
  box(-13, -10, -10, -10, 1, 1, BLOCK.FENCE);
  // First floor: blockwork walls along the edge with window holes, a site hut under the top deck.
  box(-9, -1, -9, -9, 5, 6, BLOCKWORK);
  for (const x of [-7, -3]) box(x, x + 1, -9, -9, 6, 6, AIR);
  box(-9, -9, -9, 8, 5, 5, BLOCKWORK);
  box(-9, -9, -3, 2, 5, 5, AIR);
  box(-9, -6, -9, -6, 5, 7, BLOCK.SPRUCE_PLANKS);
  box(-8, -7, -8, -7, 5, 6, AIR);
  box(-6, -6, -8, -7, 5, 6, AIR);
  box(-9, -6, -9, -6, 8, 8, CONCRETE);
  box(-8, -8, -8, -8, 7, 7, BLOCK.GLOWSTONE);
  // Steps up to the top deck, rebar sticking out of it.
  box(-3, -3, -8, -7, 5, 5, CONCRETE);
  box(-4, -4, -8, -7, 5, 6, CONCRETE);
  box(-5, -5, -8, -7, 5, 7, CONCRETE);
  box(-9, -9, -9, -9, 9, 9, BLOCK.IRON_BARS);
  box(-9, -9, -6, -6, 9, 9, BLOCK.IRON_BARS);
  // Pallets and a wheelbarrow on the slab, a railing round the atrium on one side.
  box(-8, -7, 1, 2, 5, 5, BLOCK.BRICKS);
  box(-4, -4, 3, 4, 5, 5, BLOCK.FENCE);
  box(-2, -2, 6, 7, 5, 5, C.HAY);
  // A jump pad at the atrium's edge launches onto the slab.
  jumpPad(t, -3, 0);

  // --- Material yard between the compound and the shell -------------------------------------
  paint(-23, -10, -11, 10, C.COARSE_DIRT);
  crates(t, -21, -6, 2, 2, 2, BLOCK.BRICKS);
  crates(t, -21, -6, 1, 1, 3, BLOCK.BRICKS);
  crates(t, -17, 2, 3, 2, 1, BLOCK.SPRUCE_PLANKS);
  box(-16, -16, 2, 3, 2, 2, C.CALCITE);
  box(-15, -14, -3, -2, 1, 2, BLOCK.SPRUCE_LOG);
  box(-20, -20, 5, 6, 1, 2, C.IRON_BLOCK);
  box(-20, -20, 5, 5, 3, 3, BLOCK.IRON_BARS);
  // Cement silo on legs.
  for (const [x, z] of [[-13, 4], [-12, 4], [-13, 5], [-12, 5]]) box(x, x, z, z, 1, 2, BLOCK.FENCE);
  box(-13, -12, 4, 5, 3, 7, C.CALCITE);
  box(-13, -12, 4, 5, 8, 8, C.SMOOTH_STONE);
  box(-12, -12, 3, 3, 3, 4, C.IRON_BLOCK);
  box(-18, -17, -10, -9, 1, 1, C.PACKED_MUD);
  box(-12, -11, -6, -6, 1, 1, BLOCK.SPRUCE_SLAB);

  // --- Excavation lane (north): a gravel mound, an excavator, a timber stack, a dumpster ------
  paint(-23, -1, -21, -12, C.COARSE_DIRT);
  for (let h = 1; h <= 3; h++) box(-21 + h, -14 - h, -20 + h - 1, -15 - h + 1, h, h, BLOCK.GRAVEL);
  // Excavator: tracks, body, a glass cab, the arm and bucket reaching over the mound.
  box(-10, -6, -19, -19, 1, 1, C.COAL_BLOCK);
  box(-10, -6, -16, -16, 1, 1, C.COAL_BLOCK);
  box(-10, -6, -18, -17, 1, 1, C.COAL_BLOCK);
  box(-10, -6, -19, -16, 2, 3, p.machine);
  box(-9, -8, -18, -17, 2, 3, AIR);
  box(-9, -9, -18, -17, 2, 3, BLOCK.GLASS);
  box(-8, -8, -18, -17, 2, 2, BLOCK.SPRUCE_SLAB);
  box(-10, -6, -19, -16, 4, 4, p.machine);
  box(-6, -6, -19, -16, 2, 4, C.COAL_BLOCK);
  box(-11, -12, -18, -18, 5, 5, p.machine);
  box(-13, -13, -18, -18, 4, 6, p.machine);
  box(-14, -14, -18, -18, 3, 4, C.IRON_BLOCK);
  // Timber stack and a dumpster.
  box(-4, -2, -14, -13, 1, 1, BLOCK.OAK_LOG);
  box(-4, -3, -14, -13, 2, 2, BLOCK.OAK_LOG);
  box(-23, -22, -16, -14, 1, 2, p.potty === BLOCK.GREEN_WOOL ? C.EMERALD_BLOCK : BLOCK.GREEN_WOOL);
  box(-3, -3, -20, -20, 1, 1, BLOCK.WALL);
  lamp(t, -12, -13, 5);

  // --- Scaffold lane (south): a half-built brick wall with a scaffold walkway ----------------
  paint(-23, -1, 11, 20, C.PACKED_MUD);
  box(-22, -11, 20, 20, 1, 6, BLOCK.BRICKS);
  for (const x of [-20, -16, -13]) box(x, x + 1, 20, 20, 2, 3, AIR);
  box(-22, -11, 20, 20, 5, 6, AIR);
  box(-22, -19, 20, 20, 5, 5, BLOCK.BRICKS);
  box(-22, -11, 18, 19, 3, 3, BLOCK.OAK_PLANKS);
  for (const x of [-22, -18, -14, -11]) box(x, x, 18, 18, 1, 2, BLOCK.FENCE);
  for (const x of [-22, -14]) box(x, x, 18, 18, 4, 5, BLOCK.FENCE);
  steps(t, -9, 18, -1, 0, 2, 2, BLOCK.OAK_PLANKS);
  box(-22, -22, 17, 17, 1, 1, BLOCK.OAK_PLANKS);
  box(-22, -22, 16, 16, 1, 2, BLOCK.OAK_PLANKS);
  // Pallets of bricks, rebar bundles, a cement mixer truck.
  crates(t, -19, 13, 2, 2, 1, BLOCK.BRICKS);
  box(-14, -12, 13, 13, 1, 1, BLOCK.IRON_BARS);
  box(-8, -6, 12, 14, 1, 1, C.COAL_BLOCK);
  box(-8, -6, 12, 14, 2, 2, p.machine);
  box(-7, -7, 13, 13, 2, 2, BLOCK.GLASS);
  box(-5, -2, 12, 14, 1, 1, C.COAL_BLOCK);
  box(-5, -2, 12, 14, 2, 3, C.CALCITE);
  box(-4, -3, 12, 14, 4, 4, C.CALCITE);
  box(-5, -2, 13, 13, 4, 4, p.machine);
  // The tower crane: mast, cab, jib and a hanging load.
  box(-15, -14, 9, 10, 1, 9, p.machine);
  box(-15, -14, 9, 10, 10, 10, p.machine);
  box(-14, -14, 10, 10, 9, 9, BLOCK.GLASS);
  box(-24, -2, 10, 10, 10, 10, p.machine);
  box(-22, -20, 9, 11, 10, 10, CONCRETE);
  box(-6, -6, 10, 10, 7, 9, BLOCK.FENCE);
  box(-6, -6, 10, 10, 6, 6, BLOCK.SPRUCE_PLANKS);
  lamp(t, -11, 15, 4);
}

export const SITE: FreeArenaMapDef = {
  layout: 'free',
  id: 'site',
  name: 'Rebar',
  description: 'A building site: a concrete shell with an atrium, ramps, a scaffold walkway and an excavator',
  halfX: 32,
  halfZ: 22,
  wallHeight: 13,
  wallBlock: BLOCK.BIRCH_PLANKS,
  floorBlock: C.PACKED_MUD,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-6, -3], turn([-6, -3]), [-7, -7], turn([-7, -7]), [-17, -17], turn([-17, -17]), [-15, 19], turn([-15, 19])],
  objectives: {
    zones: [
      { name: 'Atrium', x: 0, z: 0, r: 5, level: 0 },
      { name: 'Excavator', x: -9.5, z: -12.5, r: 4 },
      { name: 'Mixer', x: 9.5, z: 12.5, r: 4 },
      { name: 'West Yard', x: -17.5, z: -1.5, r: 4 },
      { name: 'East Yard', x: 17.5, z: 1.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -28.5, z: -18.5 }, { team: 'blue', x: 28.5, z: 18.5 }],
    // Search and destroy: bomb sites in the blue (defenders') half, placed with scripts/site-scan.ts.
    sites: [{ name: 'A', x: 23.5, z: -16.5, r: 3 }, { name: 'B', x: 24.5, z: 16.5, r: 3 }],
  },
  build(_variant, b) {
    half(b, 1, WEST);
    half(b, -1, EAST);
  },
};

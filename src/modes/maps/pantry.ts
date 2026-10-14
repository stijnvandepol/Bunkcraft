import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, turn, turned } from './helpers';
import { C, crates } from './props';
import { can, chair, checker, disc, ramp, socket, table } from './giant';

/**
 * "Pantry Panic": the players are mice in a normal kitchen, so the kitchen is the level. A giant table with a
 * gingham cloth stands in the middle (the legs are pillars, the cereal box and the plates are cover on top), a
 * long counter with a sink and a toaster runs along one wall, a fridge (red side) and a stove (blue side) are
 * the landmarks, grocery boxes make a skyline along the other wall, and a socket on the wall shows how small
 * everybody is. The floor is a checkerboard of tiles 4 blocks wide.
 *
 * Three lanes: the counter lane under the sink (north-west) with a book ramp up to the counter, the middle under
 * the table (the cloth is a platform on top, reached by the book ramps and by rolling-pin bridges from the
 * counters), and the pantry lane behind the grocery boxes (south-west) with a flank alley.
 *
 * The layout is point symmetric (the east half is the west half turned 180°): the counter and the pantry swap
 * places, the fridge is the stove, red breakfast against blue dinner.
 */

interface Palette {
  floorA: number;
  floorB: number;
  cloth: number;
  cloth2: number;
  cabinet: number;
  counter: number;
  books: number[];
  box1: number;
  box2: number;
  box3: number;
  mug: number;
  wood: number;
}

const BREAKFAST: Palette = {
  floorA: C.CALCITE, floorB: C.TERRACOTTA, cloth: BLOCK.RED_WOOL, cloth2: BLOCK.WHITE_WOOL, cabinet: C.CHERRY_PLANKS,
  counter: C.POLISHED_GRANITE, books: [BLOCK.RED_WOOL, BLOCK.YELLOW_WOOL, BLOCK.GREEN_WOOL, C.MANGROVE_PLANKS],
  box1: BLOCK.YELLOW_WOOL, box2: BLOCK.RED_WOOL, box3: C.PUMPKIN, mug: C.TERRACOTTA, wood: C.JUNGLE_PLANKS,
};
const DINNER: Palette = {
  floorA: C.CALCITE, floorB: C.TUFF, cloth: BLOCK.BLUE_WOOL, cloth2: BLOCK.WHITE_WOOL, cabinet: C.DARK_OAK_PLANKS,
  counter: C.POLISHED_ANDESITE, books: [BLOCK.BLUE_WOOL, C.LAPIS_BLOCK, BLOCK.GREEN_WOOL, C.DEEPSLATE_TILES],
  box1: C.DIAMOND_BLOCK, box2: C.LAPIS_BLOCK, box3: C.MELON, mug: C.COPPER_BLOCK, wood: C.DARK_OAK_PLANKS,
};

const RED_SPAWNS: [number, number][] = [[-31, -6], [-29, -3], [-31, 0], [-29, 3], [-31, 5], [-29, 6]];
const FFA_WEST: [number, number][] = [[-27, -11], [-19, -9], [-30, 18], [-20, 11], [-14, 2], [-5, -12]];

/** One half of the kitchen, drawn for the west side. */
function half(b: LayoutBuilder, s: 1 | -1, p: Palette): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Floor: tiles 4 wide, a team-coloured mat in the spawn, a power cord across the lane -----------
  checker(t, -33, -1, -21, 20, 4, p.floorA, p.floorB);
  paint(-33, -27, -8, 7, TEAM);
  for (let x = -24; x <= -8; x++) paint(x, x, 12 + ((x >> 1) & 1), 12 + ((x >> 1) & 1), C.COAL_BLOCK);
  // Skirting board along the walls (not through the spawn).
  box(-33, -33, -20, -10, 1, 1, p.cabinet);
  box(-33, -33, 9, 19, 1, 1, p.cabinet);
  box(-32, -2, 20, 20, 1, 1, p.cabinet);

  // --- Spawn: a mouse hole under the cabinet, exits north and south --------------------------------
  box(-26, -25, -9, 8, 1, 8, p.cabinet);
  box(-33, -26, -9, -9, 1, 8, p.cabinet);
  box(-33, -26, 8, 8, 1, 8, p.cabinet);
  box(-33, -27, -8, 7, 1, 8, AIR);
  box(-31, -29, -9, -9, 1, 3, AIR);
  box(-31, -29, 8, 8, 1, 3, AIR);
  box(-26, -26, -3, -2, 4, 4, C.IRON_BLOCK); // door handle
  box(-28, -27, -1, 0, 1, 2, C.HAY); // a sugar cube pile to hide behind
  box(-31, -30, -4, -4, 1, 1, C.HAY);

  // --- Counter along the north wall: sink, toaster, knife block ----------------------------------------
  box(-33, -1, -21, -17, 1, 4, p.cabinet);
  box(-33, -1, -21, -17, 5, 5, p.counter);
  box(-22, -18, -20, -18, 3, 5, AIR);
  box(-22, -18, -20, -18, 2, 2, C.ICE); // the water in the sink
  box(-17, -17, -20, -18, 3, 3, p.counter);
  box(-16, -16, -20, -18, 3, 4, p.counter);
  box(-15, -15, -20, -18, 3, 5, p.counter);
  box(-20, -20, -20, -20, 3, 8, C.IRON_BLOCK); // tap
  box(-20, -20, -19, -19, 8, 8, C.IRON_BLOCK);
  box(-11, -8, -20, -18, 6, 8, C.IRON_BLOCK); // toaster
  box(-10, -9, -19, -19, 8, 8, C.COAL_BLOCK);
  box(-6, -5, -20, -19, 6, 9, C.DARK_OAK_PLANKS); // knife block
  box(-5, -5, -18, -18, 6, 6, C.COAL_BLOCK);
  box(-27, -25, -20, -19, 6, 6, BLOCK.WHITE_WOOL); // a bread slice
  box(-29, -28, -19, -19, 6, 7, C.PUMPKIN);
  socket(t, 'z', -22, 1, -14, 7, C.CALCITE);
  // The cookbook ramp up to the counter, climbing west along the counter face.
  ramp(t, 'x', -15, -1, -16, -14, 5, p.books);
  // A rolling pin across the north lane to the table.
  box(-7, -3, -16, -8, 5, 5, C.STRIPPED_OAK_LOG);
  box(-7, -7, -16, -8, 6, 6, C.STRIPPED_OAK_LOG);
  box(-3, -3, -16, -8, 6, 6, C.STRIPPED_OAK_LOG);
  box(-7, -3, -17, -17, 5, 5, C.STRIPPED_OAK_LOG);

  // --- North lane: cans, a mug, a chair, crumbs --------------------------------------------------
  can(t, -24, -13, 3, C.IRON_BLOCK, BLOCK.WHITE_WOOL);
  can(t, -23, -10, 2, C.COPPER_BLOCK);
  box(-13, -11, -14, -12, 1, 3, p.mug);
  box(-10, -10, -13, -13, 2, 3, p.mug);
  box(-12, -12, -13, -13, 3, 3, C.COAL_BLOCK);
  chair(t, -3, -12, 'n', p.wood);
  box(-2, -2, -14, -14, 1, 1, C.HAY);
  crates(t, -29, -14, 3, 2, 2, p.box3);

  // --- Fridge (red) / stove (blue) between the spawn and the table ------------------------------------
  if (s > 0) {
    box(-21, -16, 3, 8, 1, 7, C.IRON_BLOCK);
    box(-16, -16, 5, 5, 1, 7, C.COAL_BLOCK);
    box(-16, -16, 3, 8, 6, 6, C.COAL_BLOCK);
    box(-15, -15, 4, 4, 3, 5, C.COAL_BLOCK);
    box(-15, -15, 6, 6, 7, 7, C.COAL_BLOCK);
    box(-21, -20, 3, 8, 8, 8, BLOCK.WHITE_WOOL);
  } else {
    box(-21, -16, 3, 8, 1, 6, C.IRON_BLOCK);
    box(-21, -16, 3, 8, 7, 7, C.COAL_BLOCK);
    for (const [x, z] of [[-20, 4], [-20, 7], [-17, 4], [-17, 7]]) box(x, x + 1, z, z + 1, 7, 7, C.REDSTONE_BLOCK);
    box(-16, -16, 4, 7, 2, 4, BLOCK.GLASS);
    for (const z of [3, 5, 6, 8]) box(-15, -15, z, z, 5, 5, C.COAL_BLOCK);
  }

  // --- The table: gingham cloth, pillars for legs, book ramp from the spawn side -------------------------
  table(t, -10, -1, -7, 6, 5, p.cloth, p.wood, 3);
  for (let x = -10; x <= -1; x++) for (let z = -7; z <= 6; z++) if (((x >> 1) + (z >> 1)) & 1) box(x, x, z, z, 5, 5, p.cloth2);
  ramp(t, 'x', -21, 1, -3, 0, 5, p.books);
  disc(t, -6, -3, 2.6, 6, C.CALCITE, 1);
  box(-9, -7, 3, 4, 6, 9, s > 0 ? BLOCK.YELLOW_WOOL : BLOCK.WHITE_WOOL); // cereal box / milk carton
  box(-8, -8, 3, 3, 8, 9, s > 0 ? BLOCK.RED_WOOL : BLOCK.BLUE_WOOL);
  box(-3, -2, 3, 4, 6, 8, BLOCK.GLASS); // salt shaker
  box(-3, -2, 3, 4, 9, 9, C.COAL_BLOCK);
  box(-7, -4, -7, -7, 6, 6, C.IRON_BLOCK); // fork on the edge of the cloth
  // The legs get a coaster ring so they read as turned wood.
  for (const z of [-7, 4]) box(-10, -8, z, z + 2, 4, 4, p.cabinet);

  // --- Pantry along the south wall: boxes, a flank alley behind them, shelves on the wall ----------
  const row = (x0: number, x1: number, h: number, id: number) => box(x0, x1, 14, 16, 1, h, id);
  row(-24, -21, 2, p.box1);
  row(-18, -15, 3, p.box2);
  row(-12, -9, 4, p.box1);
  row(-6, -3, 2, p.box3);
  box(-26, -25, 14, 16, 1, 1, C.HAY);
  box(-33, -26, 19, 20, 1, 3, p.box3);
  box(-24, -2, 19, 20, 1, 3, p.cabinet);
  box(-20, -18, 19, 20, 4, 5, p.box2);
  box(-12, -10, 19, 20, 4, 6, p.box1);
  box(-6, -4, 19, 20, 4, 4, p.box3);
  box(-23, -23, 17, 18, 1, 1, C.HAY);
  // Flour sack and a jar in the lane.
  box(-8, -6, 10, 11, 1, 2, BLOCK.WHITE_WOOL);
  box(-7, -7, 10, 10, 3, 3, BLOCK.WHITE_WOOL);
  can(t, -18, 11, 3, BLOCK.GLASS, C.GOLD_BLOCK);
  chair(t, -9, 8, 's', p.wood);
  box(-4, -4, 12, 12, 1, 1, C.HAY);
}

export const PANTRY: FreeArenaMapDef = {
  layout: 'free',
  id: 'pantry',
  name: 'Pantry Panic',
  description: 'Mice in a giant kitchen: a gingham table, a sink, a fridge and a stove',
  halfX: 34,
  halfZ: 22,
  wallHeight: 14,
  wallBlock: C.CUT_SANDSTONE,
  floorBlock: C.CALCITE,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-25, -19], turn([-25, -19]), [-5, 0], turn([-5, 0])],
  objectives: {
    zones: [
      { name: 'Tablecloth', x: 0, z: 0, r: 5 },
      { name: 'Sink', x: -17.5, z: -10.5, r: 4 },
      { name: 'Dish Rack', x: 17.5, z: 10.5, r: 4 },
      { name: 'Fridge Door', x: -12.5, z: 11.5, r: 4 },
      { name: 'Stove Top', x: 12.5, z: -11.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -30.5, z: 15.5 }, { team: 'blue', x: 30.5, z: -15.5 }],
    sites: [{ name: 'A', x: 12.5, z: -13.5, r: 3 }, { name: 'B', x: 22.5, z: 4.5, r: 3 }],
  },
  build(_variant, b) {
    half(b, 1, BREAKFAST);
    half(b, -1, DINNER);
  },
};

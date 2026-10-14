import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, turn, turned } from './helpers';
import { C } from './props';
import { disc, ramp, socket, table } from './giant';
import { type Wall, ceiling, centerLamp, clock, curtain, doorway, poster, sock, toyBrick, windowPane } from './giantRoom';

/**
 * "Couch Canyon": the players are mice in a normal living room. A giant sofa (red half) and a TV unit (the same
 * footprint turned around, in the blue half) line the long walls; both stand on legs or cubbies, so a low tunnel runs
 * under them, and their seats and tops are high ground that a ramp of magazines leads up to. A coffee table on a huge
 * rug is the middle (popcorn bowl, a soda can and a remote as cover, a tunnel under it), floor lamps, a potted fern,
 * pillows and a slipper break up the lanes, a wall socket and a skirting board give the scale away.
 *
 * Three lanes: under and in front of the sofa (north-west), the rug with the coffee table, and the TV lane
 * (south-west) with the cubbies. The layout is point symmetric (the east half is the west half turned 180°), the
 * palettes differ: warm red and wood against cool blue and dark wood.
 */

interface Palette {
  floorA: number;
  floorB: number;
  rug1: number;
  rug2: number;
  rug3: number;
  fabric: number;
  fabric2: number;
  wood: number;
  pot: number;
  slipper: number;
}

const WARM: Palette = {
  floorA: BLOCK.OAK_PLANKS, floorB: BLOCK.BIRCH_PLANKS, rug1: BLOCK.RED_WOOL, rug2: C.RED_SANDSTONE, rug3: BLOCK.YELLOW_WOOL,
  fabric: BLOCK.RED_WOOL, fabric2: C.PUMPKIN, wood: C.JUNGLE_PLANKS, pot: C.TERRACOTTA, slipper: BLOCK.YELLOW_WOOL,
};
const COOL: Palette = {
  floorA: C.DARK_OAK_PLANKS, floorB: BLOCK.SPRUCE_PLANKS, rug1: BLOCK.BLUE_WOOL, rug2: C.LAPIS_BLOCK, rug3: BLOCK.WHITE_WOOL,
  fabric: BLOCK.BLUE_WOOL, fabric2: C.DIAMOND_BLOCK, wood: C.DARK_OAK_PLANKS, pot: C.COPPER_BLOCK, slipper: BLOCK.GREEN_WOOL,
};

/** The living room is 40 blocks high (the walls); the ceiling is the layer above. */
const ROOM_H = 40;

const RED_SPAWNS: [number, number][] = [[-31, -6], [-29, -3], [-31, 0], [-29, 3], [-31, 5], [-29, 6]];
const FFA_WEST: [number, number][] = [[-27, -11], [-19, -9], [-30, 17], [-20, 11], [-12, -3], [-6, -12]];

function half(b: LayoutBuilder, s: 1 | -1, p: Palette): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Floor: boards in two tones, a rug with a border, a team mat in the spawn ----------------
  for (let z = -21; z <= 20; z++) paint(-33, -1, z, z, ((z >> 1) & 1) ? p.floorA : p.floorB);
  paint(-14, -1, -8, 7, p.rug1);
  paint(-12, -1, -6, 5, p.rug2);
  paint(-10, -1, -4, 3, p.rug1);
  paint(-7, -1, -1, 0, p.rug3);
  paint(-33, -27, -8, 7, TEAM);
  // Skirting board along the walls (not through the spawn).
  box(-33, -33, -20, -10, 1, 1, p.wood);
  box(-33, -33, 9, 19, 1, 1, p.wood);

  // --- Spawn: under the armchair, exits north and south ------------------------------------------
  box(-26, -25, -9, 8, 1, 8, p.fabric);
  box(-33, -26, -9, -9, 1, 5, p.fabric2);
  box(-33, -26, 8, 8, 1, 5, p.fabric2);
  box(-33, -27, -8, 7, 1, 8, AIR);
  box(-31, -29, -9, -9, 1, 3, AIR);
  box(-31, -29, 8, 8, 1, 3, AIR);
  box(-26, -25, -9, 8, 9, 9, p.fabric2); // the cushion on the back of the chair
  box(-28, -27, -1, 0, 1, 2, p.wood); // a footstool
  box(-31, -30, -4, -4, 1, 1, p.fabric2);

  // --- The sofa along the north wall: legs, a low tunnel under the seat, cushions, a back ----------
  box(-24, -3, -21, -15, 3, 3, p.wood);
  for (const x of [-24, -14, -4]) for (const z of [-21, -16]) box(x, x + 1, z, z + 1, 1, 2, p.wood);
  box(-24, -3, -19, -15, 4, 4, p.fabric);
  box(-24, -3, -21, -20, 4, 7, p.fabric);
  box(-26, -25, -21, -15, 3, 5, p.fabric2);
  box(-2, -1, -21, -15, 3, 5, p.fabric2);
  for (const x of [-14, -13]) box(x, x, -19, -15, 4, 4, p.fabric2); // the seam between two cushions
  box(-19, -17, -18, -16, 5, 5, BLOCK.WHITE_WOOL); // throw pillows
  box(-9, -7, -18, -16, 5, 6, p.fabric2);
  ramp(t, 'x', -12, -1, -14, -12, 4, [BLOCK.WHITE_WOOL, BLOCK.GREEN_WOOL, BLOCK.YELLOW_WOOL, BLOCK.RED_WOOL]);

  // --- The TV unit along the south wall: cubbies, a screen, a console --------------------------------
  box(-24, -3, 15, 20, 3, 3, p.wood);
  box(-24, -23, 15, 20, 1, 2, p.wood);
  box(-4, -3, 15, 20, 1, 2, p.wood);
  for (const x of [-17, -10]) box(x, x, 15, 20, 1, 2, p.wood);
  box(-24, -3, 20, 20, 1, 2, p.wood);
  box(-17, -8, 19, 20, 4, 9, C.IRON_BLOCK);
  box(-16, -9, 19, 19, 5, 8, C.SEA_LANTERN);
  box(-6, -4, 17, 19, 4, 5, C.COAL_BLOCK); // games console
  socket(t, 'z', 21, -1, -23, 6, C.CALCITE);
  box(-22, -19, 17, 18, 4, 4, p.fabric2);
  ramp(t, 'x', -12, -1, 13, 14, 3, [BLOCK.WHITE_WOOL, BLOCK.GREEN_WOOL, BLOCK.YELLOW_WOOL]);

  // --- Lanes: floor lamp, fern, pillows, a slipper, crumbs ---------------------------------------
  box(-9, -8, -13, -12, 1, 1, p.wood);
  box(-9, -9, -12, -12, 2, 9, C.IRON_BLOCK);
  box(-10, -7, -13, -10, 9, 9, BLOCK.YELLOW_WOOL);
  box(-9, -8, -12, -11, 10, 10, BLOCK.YELLOW_WOOL);
  box(-27, -25, 11, 13, 1, 2, p.pot);
  box(-28, -24, 10, 14, 3, 5, C.MOSS);
  box(-25, -23, -14, -12, 1, 1, BLOCK.WHITE_WOOL);
  box(-24, -24, -13, -13, 2, 2, BLOCK.WHITE_WOOL);
  box(-7, -4, 10, 11, 1, 2, p.slipper); // a slipper
  box(-4, -4, 10, 11, 3, 3, p.slipper);
  box(-20, -18, 8, 10, 1, 1, BLOCK.WHITE_WOOL);
  box(-17, -17, -10, -10, 1, 1, C.HAY);
  box(-22, -21, -7, -6, 1, 2, p.fabric2);
  box(-20, -20, 4, 5, 1, 1, C.HAY);
  box(-18, -15, 4, 7, 1, 3, p.fabric2); // pouf
  box(-17, -16, 5, 6, 4, 4, p.fabric2);
  box(-22, -20, -6, -4, 1, 3, p.fabric);
  box(-4, -2, -12, -9, 1, 8, BLOCK.BOOKSHELF); // a bookcase
  box(-4, -2, 9, 12, 1, 8, C.COAL_BLOCK); // a speaker
  box(-4, -2, 9, 12, 5, 5, C.IRON_BLOCK);
  box(-3, -3, 9, 9, 2, 3, C.SEA_LANTERN);
  box(-17, -15, 11, 13, 1, 3, C.TERRACOTTA); // a shoe box
  box(-12, -10, -7, -5, 1, 2, p.fabric);
  box(-12, -10, 4, 6, 1, 2, p.fabric);

  // --- The coffee table on the rug: popcorn bowl, a can, a remote ---------------------------------------
  table(t, -9, -1, -4, 3, 3, p.wood, p.wood, 2);
  ramp(t, 'x', -15, 1, -1, 2, 3, [BLOCK.WHITE_WOOL, BLOCK.GREEN_WOOL, BLOCK.YELLOW_WOOL]);
  box(-1, -1, -3, 2, 1, 2, p.fabric2); // a toy box under the table
  disc(t, -6, -1, 2.4, 4, BLOCK.WHITE_WOOL, 1);
  box(-7, -5, -2, 0, 5, 5, C.HAY);
  box(-3, -2, 1, 2, 4, 7, BLOCK.RED_WOOL);
  box(-3, -2, 1, 2, 8, 8, C.IRON_BLOCK);
  box(-8, -8, -3, 2, 4, 4, C.COAL_BLOCK);
  box(-8, -8, -2, -2, 5, 5, C.REDSTONE_BLOCK);
  box(-4, -3, -4, -4, 4, 5, p.fabric2);
  dress(t, p);
}

/** The room itself: ceiling, a window with curtains over the sofa, door, clock, posters and a few giant everyday things. */
function dress(t: LayoutBuilder, p: Palette): void {
  const N: Wall = { axis: 'z', at: -22, dir: 1 }, W: Wall = { axis: 'x', at: -34, dir: 1 }, S: Wall = { axis: 'z', at: 21, dir: -1 };
  ceiling(t, -34, -1, -22, 21, ROOM_H + 1, [[-26, -14, 2], [-12, -14, 2], [-26, 0, 2], [-26, 14, 2], [-12, 14, 2], [-4, 14, 2], [-4, -14, 2]]);
  windowPane(t, N, -20, -8, 14, 32, BLOCK.WHITE_WOOL);
  curtain(t, N, -25, -22, 13, 34, p.fabric, p.fabric2);
  curtain(t, N, -6, -3, 13, 34, p.fabric, p.fabric2);
  doorway(t, W, 10, 17, 26, p.wood, C.DARK_OAK_PLANKS);
  clock(t, W, 13, 33, 4, BLOCK.WHITE_WOOL, p.wood);
  poster(t, W, -20, -12, 16, 28, p.wood, BLOCK.WHITE_WOOL, p.fabric);
  poster(t, S, -22, -12, 16, 28, C.DARK_OAK_PLANKS, p.fabric2, BLOCK.WHITE_WOOL);
  poster(t, S, -9, -3, 18, 27, p.wood, C.CALCITE, p.fabric);
  // Giant everyday things: toy bricks and a sock on the floor.
  toyBrick(t, -31, -16, 4, 2, 1, BLOCK.RED_WOOL);
  toyBrick(t, -29, -14, 2, 2, 2, BLOCK.YELLOW_WOOL);
  sock(t, -23, 3, 6, BLOCK.WHITE_WOOL, p.fabric);
}

export const COUCH: FreeArenaMapDef = {
  layout: 'free',
  id: 'couch',
  name: 'Couch Canyon',
  description: 'Mice in a giant living room: tunnels under the sofa, a coffee table on a rug and a TV unit',
  halfX: 34,
  halfZ: 22,
  wallHeight: ROOM_H,
  room: { ceiling: ROOM_H + 2, playHeight: 14 },
  wallBlock: C.POLISHED_DIORITE,
  floorBlock: BLOCK.OAK_PLANKS,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-20, -17], turn([-20, -17]), [-18, 17], turn([-18, 17])],
  objectives: {
    zones: [
      { name: 'Rug', x: 0, z: 0, r: 5 },
      { name: 'Lamp', x: -16.5, z: -8.5, r: 4 },
      { name: 'Slipper', x: 16.5, z: 8.5, r: 4 },
      { name: 'Fern', x: -11.5, z: 11.5, r: 4 },
      { name: 'Remote', x: 11.5, z: -11.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -30.5, z: 15.5 }, { team: 'blue', x: 30.5, z: -15.5 }],
    sites: [{ name: 'A', x: 20.5, z: -16.5, r: 3 }, { name: 'B', x: 23.5, z: 16.5, r: 3 }],
  },
  build(_variant, b) {
    half(b, 1, WARM);
    half(b, -1, COOL);
    centerLamp(b, ROOM_H, 31, 7, BLOCK.YELLOW_WOOL);
  },
};

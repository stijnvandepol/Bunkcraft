import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, jumpPad, turn, turned } from './helpers';
import { C } from './props';
import { can, disc, ramp, socket, table } from './giant';
import { type Wall, ceiling, centerLamp, clock, curtain, doorway, pencil, poster, windowPane } from './giantRoom';

/**
 * "Workbench Run": the players are mice in a normal garage, so the garage is the level. A toy car the size of a
 * house stands in the middle (a tunnel runs under it between the wheels, its hood and roof are a stepped platform), a
 * workbench with a vise and a pegboard runs along one wall (a tyre with a jump pad is the spring board up to it), a steel
 * rack with two shelves of cartons along the other (cartons are the stairs to the upper shelf), and a toolbox
 * (red half) / paint cabinet (blue half) is the landmark between the spawn and the car. Paint cans, tyres, a tape
 * measure, a hammer and a wall socket with its cord give the scale away.
 *
 * Three lanes: the workbench lane (north-west), the toy car (middle: under it, over it) and the rack lane
 * (south-west). The layout is point symmetric (the east half is the west half turned 180°), the palettes differ:
 * red tools on a dark floor against blue tools on a light floor.
 */

interface Palette {
  floorA: number;
  floorB: number;
  metal: number;
  metal2: number;
  wood: number;
  can1: number;
  can2: number;
  car: number;
  light: number;
}

const RED_SHOP: Palette = {
  floorA: C.ANDESITE, floorB: C.POLISHED_ANDESITE, metal: BLOCK.RED_WOOL, metal2: C.REDSTONE_BLOCK, wood: BLOCK.OAK_PLANKS,
  can1: BLOCK.YELLOW_WOOL, can2: BLOCK.GREEN_WOOL, car: BLOCK.RED_WOOL, light: C.SEA_LANTERN,
};
const BLUE_SHOP: Palette = {
  floorA: C.SMOOTH_STONE, floorB: C.CALCITE, metal: BLOCK.BLUE_WOOL, metal2: C.LAPIS_BLOCK, wood: BLOCK.SPRUCE_PLANKS,
  can1: C.PUMPKIN, can2: BLOCK.WHITE_WOOL, car: BLOCK.BLUE_WOOL, light: C.REDSTONE_BLOCK,
};

/** The garage is 40 blocks high (the walls); the ceiling is the layer above. */
const ROOM_H = 40;

const RED_SPAWNS: [number, number][] = [[-31, -6], [-29, -3], [-31, 0], [-29, 3], [-31, 5], [-29, 6]];
const FFA_WEST: [number, number][] = [[-27, -11], [-19, -9], [-30, 18], [-20, 11], [-14, 2], [-6, -12]];

function half(b: LayoutBuilder, s: 1 | -1, p: Palette): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Floor: slabs of two greys, yellow safety lines, an oil stain, the cord ------------------------
  for (let x = -33; x <= -1; x++) for (let z = -21; z <= 20; z++) paint(x, x, z, z, (((x >> 2) + (z >> 2)) & 1) ? p.floorA : p.floorB);
  paint(-33, -27, -8, 7, TEAM);
  paint(-24, -1, -9, -9, BLOCK.YELLOW_WOOL);
  paint(-24, -1, 8, 8, BLOCK.YELLOW_WOOL);
  paint(-14, -12, 2, 4, C.COAL_BLOCK);
  paint(-12, -11, 5, 10, C.COAL_BLOCK);
  box(-33, -33, -20, -10, 1, 1, C.IRON_BLOCK);
  box(-33, -33, 9, 12, 1, 1, C.IRON_BLOCK);

  // --- Spawn: inside the toolbox, exits north and south ----------------------------------------------
  box(-26, -25, -9, 8, 1, 8, p.metal);
  box(-33, -26, -9, -9, 1, 8, p.metal);
  box(-33, -26, 8, 8, 1, 8, p.metal);
  box(-33, -27, -8, 7, 1, 8, AIR);
  box(-31, -29, -9, -9, 1, 3, AIR);
  box(-31, -29, 8, 8, 1, 3, AIR);
  box(-26, -25, -9, 8, 5, 5, C.COAL_BLOCK); // drawer seams
  box(-26, -26, -2, 1, 6, 7, C.IRON_BLOCK); // handle
  box(-33, -26, -9, 8, 9, 9, p.metal2);
  box(-28, -27, -1, 0, 1, 2, p.wood);
  box(-31, -30, -4, -4, 1, 1, C.IRON_BLOCK);

  // --- The workbench along the north wall: vise, hammer, jar, pegboard, tools below ------------------
  table(t, -24, -1, -21, -16, 5, p.wood, C.IRON_BLOCK, 3);
  box(-24, -1, -21, -21, 6, 9, BLOCK.OAK_PLANKS); // the pegboard
  for (let x = -23; x <= -3; x += 4) box(x, x, -21, -21, 7, 7, C.COAL_BLOCK);
  box(-18, -17, -21, -21, 8, 8, C.IRON_BLOCK); // spanner hanging on the board
  box(-18, -18, -21, -21, 9, 9, C.IRON_BLOCK);
  box(-11, -11, -21, -21, 8, 9, C.COPPER_BLOCK);
  box(-20, -18, -20, -19, 6, 7, C.IRON_BLOCK); // vise
  box(-20, -20, -18, -17, 6, 6, C.IRON_BLOCK);
  box(-12, -5, -18, -18, 6, 6, BLOCK.SPRUCE_PLANKS); // hammer lying on the bench
  box(-5, -4, -19, -17, 6, 7, C.IRON_BLOCK);
  box(-9, -8, -20, -19, 6, 8, BLOCK.GLASS); // jar of screws
  box(-9, -8, -20, -19, 9, 9, C.GOLD_BLOCK);
  box(-14, -9, -20, -17, 1, 4, p.metal); // drawer unit under the bench
  box(-14, -9, -17, -17, 2, 2, C.COAL_BLOCK);
  box(-24, -22, -20, -18, 1, 3, C.COAL_BLOCK); // tyres under the bench
  box(-23, -23, -19, -19, 4, 4, C.COAL_BLOCK);
  socket(t, 'z', 21, -1, -31, 6, C.CALCITE);
  // The spring board: a tyre with a jump pad on it throws you onto the bench.
  box(-17, -14, -14, -11, 1, 1, C.COAL_BLOCK);
  jumpPad(t, -16, -13, 2, -15, -12);

  // --- Mid-lane landmark: toolbox (red) / paint cabinet (blue), tall and solid ---------------------------
  box(-22, -16, 2, 7, 1, 6, p.metal);
  for (const h of [2, 4]) box(-16, -16, 2, 7, h, h, C.COAL_BLOCK);
  box(-15, -15, 3, 3, 2, 2, C.IRON_BLOCK);
  box(-15, -15, 6, 6, 4, 4, C.IRON_BLOCK);
  if (s > 0) {
    box(-22, -16, 2, 7, 7, 7, C.IRON_BLOCK);
    box(-20, -18, 3, 6, 8, 8, C.IRON_BLOCK);
  } else {
    box(-22, -16, 2, 7, 7, 7, C.COAL_BLOCK);
    can(t, -21, 3, 3, BLOCK.WHITE_WOOL, p.metal2);
    box(-19, -18, 5, 6, 8, 9, BLOCK.WHITE_WOOL);
  }

  // --- The toy car: wheels, a tunnel under the body, hood and roof as a stair of platforms -------------------
  box(-7, -5, -5, -3, 1, 2, C.COAL_BLOCK);
  box(-7, -5, 2, 4, 1, 2, C.COAL_BLOCK);
  box(-6, -6, -5, -5, 2, 2, C.IRON_BLOCK);
  box(-8, -1, -4, 3, 3, 3, p.car); // the chassis
  box(-8, -8, -3, 2, 3, 3, C.IRON_BLOCK); // bumper
  box(-7, -6, -4, 3, 4, 4, p.car); // hood
  box(-7, -7, -2, -1, 4, 4, p.light);
  box(-7, -7, 0, 1, 4, 4, p.light);
  box(-5, -5, -3, 2, 4, 5, BLOCK.GLASS); // windscreen
  box(-4, -1, -4, 3, 4, 5, p.car); // the cabin
  box(-4, -1, -4, -4, 4, 4, BLOCK.GLASS);
  box(-4, -1, 3, 3, 4, 4, BLOCK.GLASS);
  box(-3, -2, -1, 0, 6, 6, C.IRON_BLOCK); // roof rack
  box(-1, -1, -3, 2, 1, 2, C.IRON_BLOCK); // the drive shaft
  ramp(t, 'x', -14, 1, -2, 1, 3, [C.IRON_BLOCK, p.wood, C.COAL_BLOCK]);

  // --- North lane: paint cans, a hose, a crate ----------------------------------------------------
  can(t, -31, -15, 3, p.can1, BLOCK.WHITE_WOOL);
  box(-30, -29, -14, -13, 1, 1, p.can1);
  box(-9, -7, -13, -11, 1, 4, p.can2);
  box(-9, -7, -13, -11, 5, 5, BLOCK.WHITE_WOOL);
  box(-8, -7, -12, -11, 6, 7, p.can1);
  disc(t, -24, -12, 2.4, 1, C.COPPER_BLOCK, 0);
  box(-25, -23, -13, -11, 2, 2, C.COPPER_BLOCK);
  box(-4, -2, -14, -12, 1, 2, BLOCK.SPRUCE_PLANKS);

  // --- South lane: the steel rack with cartons for stairs, a tape measure, a hammer --------------------------
  for (const x of [-25, -15, -5]) for (const z of [16, 20]) box(x, x, z, z, 1, 8, C.IRON_BLOCK);
  box(-25, -5, 16, 20, 3, 3, BLOCK.SPRUCE_PLANKS);
  box(-25, -5, 18, 20, 6, 6, BLOCK.SPRUCE_PLANKS);
  box(-12, -10, 16, 16, 4, 4, BLOCK.OAK_PLANKS);
  box(-12, -10, 17, 17, 4, 5, BLOCK.OAK_PLANKS);
  box(-22, -19, 17, 19, 4, 6, BLOCK.OAK_PLANKS);
  box(-8, -6, 18, 20, 7, 8, p.can1);
  box(-20, -16, 19, 20, 7, 7, p.metal);
  ramp(t, 'x', -29, 1, 16, 17, 2, [BLOCK.OAK_PLANKS, C.IRON_BLOCK]);
  disc(t, -14, 11, 2.2, 1, BLOCK.YELLOW_WOOL, 0);
  box(-14, -14, 11, 11, 2, 2, C.IRON_BLOCK);
  box(-24, -17, 12, 12, 1, 1, BLOCK.SPRUCE_PLANKS); // hammer handle
  box(-18, -16, 11, 13, 2, 2, C.IRON_BLOCK);
  box(-20, -18, -6, -4, 1, 3, C.COAL_BLOCK); // oil drums
  box(-20, -18, -6, -4, 4, 4, C.IRON_BLOCK);
  box(-4, -2, -12, -9, 1, 7, C.COAL_BLOCK); // stacked drums
  box(-4, -2, -12, -9, 8, 8, C.IRON_BLOCK);
  for (const h of [2, 4, 6]) box(-4, -2, -12, -9, h, h, C.IRON_BLOCK);
  box(-4, -2, 9, 12, 1, 7, C.COAL_BLOCK); // a stack of tyres
  box(-5, -1, 9, 12, 2, 2, C.COAL_BLOCK);
  box(-4, -2, 9, 12, 8, 8, p.metal);
  box(-11, -9, 5, 7, 1, 2, BLOCK.OAK_PLANKS);
  box(-23, -21, -2, 0, 1, 2, BLOCK.OAK_PLANKS);
  box(-10, -8, 11, 13, 1, 3, BLOCK.OAK_PLANKS);
  dress(t, p);
}

/** The room itself: ceiling with strip lights, a window over the bench, a roller door, clock, posters and a few giant things. */
function dress(t: LayoutBuilder, p: Palette): void {
  const N: Wall = { axis: 'z', at: -22, dir: 1 }, W: Wall = { axis: 'x', at: -34, dir: 1 }, S: Wall = { axis: 'z', at: 21, dir: -1 };
  ceiling(t, -34, -1, -22, 21, ROOM_H + 1, [[-26, -14, 2], [-12, -14, 2], [-26, 0, 2], [-26, 14, 2], [-12, 14, 2], [-4, 14, 2], [-4, -14, 2]]);
  windowPane(t, N, -22, -8, 14, 30, C.IRON_BLOCK);
  curtain(t, N, -27, -25, 13, 20, p.metal, p.metal2);
  curtain(t, N, -5, -3, 13, 20, p.metal, p.metal2);
  doorway(t, W, -19, -10, 30, C.SMOOTH_STONE, C.IRON_BLOCK);
  clock(t, W, 14, 30, 4, BLOCK.WHITE_WOOL, C.IRON_BLOCK);
  poster(t, W, 9, 19, 14, 24, C.IRON_BLOCK, BLOCK.WHITE_WOOL, p.metal);
  poster(t, S, -22, -12, 16, 28, C.COAL_BLOCK, p.metal2, BLOCK.YELLOW_WOOL);
  poster(t, S, -9, -3, 18, 27, C.IRON_BLOCK, BLOCK.WHITE_WOOL, p.metal);
  // Giant everyday things: a pencil.
  pencil(t, -32, -18, 8, true);
}

export const WORKSHOP: FreeArenaMapDef = {
  layout: 'free',
  id: 'workshop',
  name: 'Workbench Run',
  description: 'Mice in a giant garage: a toy car, a workbench with a tyre spring board and a steel rack',
  halfX: 34,
  halfZ: 22,
  wallHeight: ROOM_H,
  room: { ceiling: ROOM_H + 2, playHeight: 14 },
  wallBlock: C.ANDESITE,
  floorBlock: C.POLISHED_ANDESITE,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-15, -17], turn([-15, -17]), [-15, 19], turn([-15, 19])],
  objectives: {
    zones: [
      { name: 'Car', x: 0, z: 0, r: 5 },
      { name: 'Tyre', x: -12.5, z: -9.5, r: 4 },
      { name: 'Paint', x: 12.5, z: 9.5, r: 4 },
      { name: 'Tape', x: -12.5, z: 11.5, r: 4 },
      { name: 'Cabinet', x: 12.5, z: -11.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -31.5, z: 15.5 }, { team: 'blue', x: 31.5, z: -15.5 }],
    sites: [{ name: 'A', x: 17.5, z: -16.5, r: 3 }, { name: 'B', x: 19.5, z: 16.5, r: 3 }],
  },
  build(_variant, b) {
    half(b, 1, RED_SHOP);
    half(b, -1, BLUE_SHOP);
    centerLamp(b, ROOM_H, 31, 7, C.IRON_BLOCK);
  },
};

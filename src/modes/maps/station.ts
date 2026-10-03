import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, car, turn, turned } from './helpers';

/**
 * "Terminus": a railway station (inspired by the classic express-train map). Two tracks run
 * north-south through the middle, each with a train standing at a platform; the trains are
 * staggered so the tracks cross in the middle as a level crossing, and every carriage has doors
 * on both sides to run through. Each track ends in a tunnel in the arena wall. Raised platforms
 * with canopies, two footbridges over the tracks (with a drop onto the train roofs), and on each
 * side a big hall with a balcony: the brick station hall (red) and the stone freight hall (blue).
 * The teams spawn on the forecourt behind their hall.
 *
 * Point symmetric: each half is the other turned 180°, with its own colours and furniture.
 */

interface Side {
  /** The passenger hall (true) or the freight hall (false). */
  passenger: boolean;
  hall: number;
  trim: number;
  livery: number;
  car: number;
}

const WEST: Side = { passenger: true, hall: BLOCK.BRICKS, trim: BLOCK.STONE_BRICKS, livery: BLOCK.YELLOW_WOOL, car: BLOCK.WHITE_WOOL };
const EAST: Side = { passenger: false, hall: BLOCK.STONE_BRICKS, trim: BLOCK.SPRUCE_PLANKS, livery: BLOCK.GREEN_WOOL, car: BLOCK.YELLOW_WOOL };

const PLATFORM = BLOCK.STONE;
const BODY = BLOCK.CONCRETE;

const RED_SPAWNS: [number, number][] = [[-40, -6], [-37, -4], [-40, -1], [-37, 2], [-40, 4], [-36, 6]];
const FFA_WEST: [number, number][] = [[-38, -9], [-38, 9], [-36, -29], [-24, -22], [-23, 6], [-20, 20]];

/** A lamp post: a fence pole with a glowstone head. */
function lamp(box: LayoutBuilder['box'], x: number, z: number, h0: number, h1: number): void {
  box(x, x, z, z, h0, h1, BLOCK.FENCE);
  box(x, x, z, z, h1 + 1, h1 + 1, BLOCK.GLOWSTONE);
}

/**
 * One carriage on the west track (x -5..-2), from z0 to z1: floor at 1, walls 2-3, a roof at 4,
 * windows on both sides and a door on each side at `door`.
 */
function carriage(box: LayoutBuilder['box'], z0: number, z1: number, door: number, livery: number): void {
  box(-5, -2, z0, z1, 1, 1, BLOCK.OBSIDIAN);
  box(-5, -2, z0, z1, 2, 3, BODY);
  box(-5, -5, z0, z1, 2, 2, livery);
  box(-2, -2, z0, z1, 2, 2, livery);
  box(-4, -3, z0 + 1, z1 - 1, 2, 3, AIR);
  box(-5, -2, z0, z1, 4, 4, BLOCK.STONE);
  for (let z = z0 + 1; z < z1; z += 2) {
    box(-5, -5, z, z, 3, 3, BLOCK.GLASS);
    box(-2, -2, z, z, 3, 3, BLOCK.GLASS);
  }
  box(-5, -5, door, door + 1, 2, 3, AIR);
  box(-2, -2, door, door + 1, 2, 3, AIR);
  box(-4, -3, z0, z0, 2, 3, AIR);
  box(-4, -3, z1, z1, 2, 3, AIR);
}

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Track bed: gravel, sleepers and rails (paint only); a gravel strip between the tracks --
  paint(-5, -1, -33, 32, BLOCK.GRAVEL);
  for (let z = -33; z <= 32; z += 2) paint(-5, -2, z, z, BLOCK.SPRUCE_PLANKS);
  paint(-4, -4, -33, 32, BLOCK.COBBLESTONE);
  paint(-3, -3, -33, 32, BLOCK.COBBLESTONE);
  // Level crossing in the middle: planks over the tracks.
  paint(-5, -1, -3, 2, BLOCK.OAK_PLANKS);

  // --- Platform: raised one block, a yellow edge, a canopy, benches and lamps ----------------
  box(-16, -6, -27, 26, 1, 1, PLATFORM);
  box(-6, -6, -27, 26, 1, 1, BLOCK.YELLOW_WOOL);
  for (const z of [-11, -5, 1, 7, 12]) box(-11, -11, z, z, 2, 4, BLOCK.WALL);
  box(-15, -7, -12, 12, 5, 5, p.trim);
  box(-14, -8, -10, 10, 5, 5, BLOCK.STAINED_GLASS);
  for (const z of [-8, 4]) box(-11, -11, z, z, 4, 4, BLOCK.GLOWSTONE);
  for (const z of [-9, -3, 3, 9]) box(-14, -13, z, z, 2, 2, BLOCK.SPRUCE_SLAB);
  // A ticket machine, a newsstand, a luggage cart, a departure sign.
  box(-15, -15, -1, -1, 2, 3, BLOCK.WHITE_WOOL);
  box(-15, -15, -1, -1, 3, 3, BLOCK.GLASS);
  box(-9, -8, -15, -14, 2, 3, p.livery);
  box(-9, -8, -15, -14, 4, 4, BLOCK.WHITE_WOOL);
  box(-9, -9, 15, 17, 2, 2, BLOCK.OAK_SLAB);
  box(-11, -11, -2, 2, 4, 4, BLOCK.OBSIDIAN);
  box(-11, -11, 0, 0, 4, 4, BLOCK.GLOWSTONE);
  lamp(box, -15, -20, 2, 4);
  lamp(box, -15, 21, 2, 4);
  lamp(box, -7, 18, 2, 4);

  // --- The train on the west track: a locomotive coming out of the north tunnel, two carriages --
  carriage(box, -19, -12, -16, p.livery);
  carriage(box, -10, -4, -8, p.livery);
  box(-4, -3, -11, -11, 1, 1, BLOCK.OBSIDIAN);
  box(-4, -3, -20, -20, 1, 1, BLOCK.OBSIDIAN);
  for (const z of [-17, -13, -9, -6]) box(-4, -4, z, z, 2, 2, p.passenger ? BLOCK.RED_WOOL : BLOCK.SPRUCE_SLAB);
  for (const z of [-15, -7]) box(-3, -3, z, z, 4, 4, BLOCK.GLOWSTONE);
  // Locomotive: a closed engine, a cab with a windscreen facing the tunnel.
  box(-5, -2, -27, -21, 1, 1, BLOCK.OBSIDIAN);
  box(-5, -2, -27, -21, 2, 4, p.livery);
  box(-5, -2, -27, -27, 2, 2, BODY);
  box(-4, -3, -26, -24, 2, 3, AIR);
  box(-4, -3, -27, -27, 3, 3, BLOCK.GLASS);
  box(-5, -5, -25, -24, 2, 3, AIR);
  box(-2, -2, -25, -24, 2, 3, AIR);
  box(-4, -4, -26, -26, 2, 2, BLOCK.FURNACE);
  box(-5, -2, -23, -21, 5, 5, BLOCK.STONE_SLAB);
  box(-4, -3, -22, -22, 5, 5, BLOCK.OBSIDIAN);

  // --- Tunnel portals at both ends of the tracks (the other half carves the other track) ------
  for (const [z0, z1] of [[-33, -28], [27, 32]]) {
    box(-16, -1, z0, z1, 1, 7, BLOCK.STONE_BRICKS);
    box(-5, -1, z0, z1, 1, 4, AIR);
    box(-16, -1, z0, z1, 8, 8, BLOCK.GRASS);
    box(-14, -8, z0 + 1, z1 - 1, 9, 9, BLOCK.OAK_LEAVES);
    const face = z0 < 0 ? z1 : z0;
    box(-6, -6, face, face, 1, 5, p.trim);
    box(-5, -1, face, face, 5, 5, p.trim);
    box(-3, -3, z0 < 0 ? z0 + 1 : z1 - 1, z0 < 0 ? z0 + 1 : z1 - 1, 4, 4, BLOCK.GLOWSTONE);
  }

  // --- Footbridges over the tracks (west halves of both), stairs up from the platform --------
  for (const [z0, rail0, rail1] of [[16, 16, 19], [-20, -20, -17]] as const) {
    box(-16, -1, z0, z0 + 3, 5, 5, p.trim);
    box(-16, -1, rail0, rail0, 6, 6, BLOCK.IRON_BARS);
    box(-16, -1, rail1, rail1, 6, 6, BLOCK.IRON_BARS);
    box(-5, -2, z0 < 0 ? rail0 : rail1, z0 < 0 ? rail0 : rail1, 6, 6, AIR);
    box(-16, -16, z0, z0 + 3, 6, 6, BLOCK.IRON_BARS);
    box(-8, -8, z0 + 1, z0 + 1, 7, 7, BLOCK.GLOWSTONE);
  }
  // Stairs: south bridge from the south, north bridge from the north.
  box(-15, -14, 13, 13, 2, 2, PLATFORM);
  box(-15, -14, 14, 14, 2, 3, PLATFORM);
  box(-15, -14, 15, 15, 2, 4, PLATFORM);
  box(-15, -14, 16, 16, 6, 6, AIR);
  box(-15, -14, -24, -24, 2, 2, PLATFORM);
  box(-15, -14, -23, -23, 2, 3, PLATFORM);
  box(-15, -14, -22, -22, 2, 4, PLATFORM);
  box(-15, -14, -21, -21, 2, 4, PLATFORM);
  box(-15, -14, -20, -20, 6, 6, AIR);

  // --- The hall: brick (or stone) walls, a skylight roof, a balcony along the forecourt side ---
  box(-31, -17, -14, 13, 1, 7, p.hall);
  box(-30, -18, -13, 12, 1, 6, AIR);
  paint(-30, -18, -13, 12, p.passenger ? BLOCK.STONE_BRICKS : BLOCK.STONE);
  box(-31, -17, -14, 13, 7, 7, p.trim);
  box(-30, -18, -13, 12, 7, 7, AIR);
  box(-32, -16, -15, 14, 8, 8, p.hall);
  box(-28, -20, -11, 10, 8, 8, BLOCK.STAINED_GLASS);
  // Doors: two to the forecourt (outside the spawn band), three big arches to the platform.
  box(-31, -31, -12, -11, 1, 3, AIR);
  box(-31, -31, 10, 11, 1, 3, AIR);
  for (const [z0, z1] of [[-10, -8], [-1, 0], [7, 9]]) box(-17, -17, z0, z1, 1, 3, AIR);
  // The forecourt façade: pilasters, a clock and canopies over the two doors.
  for (const z of [-14, -9, -4, 3, 8, 13]) box(-32, -32, z, z, 1, 6, p.trim);
  box(-32, -32, -2, 1, 5, 6, p.trim);
  box(-32, -32, -1, 0, 5, 6, BLOCK.WHITE_WOOL);
  for (const z of [-13, 9]) box(-33, -32, z, z + 3, 4, 4, p.trim);
  box(-33, -33, -11, -11, 3, 3, BLOCK.GLOWSTONE);
  box(-33, -33, 10, 10, 3, 3, BLOCK.GLOWSTONE);
  // Windows.
  for (const z of [-6, -2, 2, 6]) box(-31, -31, z, z + 1, 5, 6, BLOCK.GLASS);
  for (const z of [-5, 3]) box(-17, -17, z, z + 1, 2, 5, BLOCK.GLASS);
  box(-17, -17, -12, 11, 5, 6, BLOCK.GLASS);
  // The façade clock over the middle arch.
  box(-17, -17, -1, 0, 5, 6, BLOCK.WHITE_WOOL);
  box(-16, -16, -1, 0, 6, 6, BLOCK.GLOWSTONE);
  // Balcony: a floor at 4 along the west wall, a railing, stairs up at the north end.
  box(-30, -27, -10, 12, 4, 4, p.trim);
  box(-26, -26, -10, 12, 5, 5, BLOCK.IRON_BARS);
  box(-26, -26, 4, 5, 5, 5, AIR);
  box(-30, -29, -13, -13, 1, 1, p.trim);
  box(-30, -29, -12, -12, 1, 2, p.trim);
  box(-30, -29, -11, -11, 1, 3, p.trim);
  box(-30, -27, -11, -11, 4, 4, p.trim);
  box(-28, -27, -12, -11, 5, 5, BLOCK.IRON_BARS);
  // Under the balcony: the ticket office (red) or the freight office (blue), benches in the hall.
  box(-27, -27, -6, 8, 1, 1, p.passenger ? BLOCK.SPRUCE_PLANKS : BLOCK.OAK_PLANKS);
  box(-27, -27, -6, 8, 3, 3, p.passenger ? BLOCK.GLASS : AIR);
  box(-27, -27, -1, 1, 1, 3, AIR);
  box(-30, -30, -5, 7, 1, 2, p.passenger ? BLOCK.BOOKSHELF : BLOCK.SPRUCE_PLANKS);
  box(-29, -29, 2, 2, 1, 1, BLOCK.CHEST);
  if (p.passenger) {
    for (const z of [-11, -5, 4, 10]) box(-22, -20, z, z, 1, 1, BLOCK.SPRUCE_SLAB);
    box(-19, -19, -13, -13, 1, 2, BLOCK.WHITE_WOOL);
    box(-19, -19, 12, 12, 1, 2, BLOCK.WHITE_WOOL);
  } else {
    box(-22, -20, -12, -10, 1, 2, BLOCK.SPRUCE_PLANKS);
    box(-21, -20, 9, 11, 1, 1, BLOCK.OAK_PLANKS);
    box(-21, -21, 10, 10, 2, 2, BLOCK.OAK_PLANKS);
    box(-20, -19, -6, -5, 1, 1, BLOCK.CHEST);
  }
  // The departure board on the north wall and chandeliers.
  box(-24, -20, -13, -13, 4, 5, BLOCK.OBSIDIAN);
  box(-23, -21, -13, -13, 5, 5, BLOCK.GLOWSTONE);
  for (const z of [-7, 6]) box(-23, -23, z, z, 7, 7, BLOCK.GLOWSTONE);

  // --- Forecourt: the spawn on a taxi rank, cars, a bus shelter, planters ---------------------
  paint(-41, -32, -14, 13, BLOCK.STONE_BRICKS);
  paint(-41, -41, -3, 2, TEAM);
  car(t, -41, -14, true, p.car);
  car(t, -41, 10, true, BLOCK.YELLOW_WOOL);
  for (const z of [-9, 8]) {
    box(-35, -34, z, z + 1, 1, 1, p.trim);
    box(-35, -34, z, z + 1, 2, 2, BLOCK.OAK_LEAVES);
  }
  lamp(box, -33, -12, 1, 3);
  lamp(box, -33, 11, 1, 3);
  // North: a car park with a newsstand; south: a bus stop with a bus.
  paint(-41, -17, -27, -16, BLOCK.STONE);
  for (const x of [-38, -33, -28, -23]) paint(x, x, -26, -22, BLOCK.WHITE_WOOL);
  car(t, -37, -26, false, p.livery);
  car(t, -27, -26, false, BLOCK.WHITE_WOOL);
  box(-22, -20, -18, -17, 1, 3, BLOCK.SPRUCE_PLANKS);
  box(-21, -21, -18, -17, 1, 2, AIR);
  box(-23, -19, -19, -16, 4, 4, p.livery);
  box(-41, -38, -33, -30, 1, 2, BLOCK.OAK_PLANKS);
  box(-41, -41, -33, -31, 3, 3, BLOCK.OAK_PLANKS);
  paint(-41, -17, 16, 32, BLOCK.STONE);
  box(-36, -24, 22, 24, 1, 3, BLOCK.WHITE_WOOL);
  box(-35, -25, 23, 23, 1, 2, AIR);
  box(-36, -24, 22, 24, 1, 1, BLOCK.OBSIDIAN);
  box(-35, -25, 22, 22, 2, 2, BLOCK.GLASS);
  box(-35, -25, 24, 24, 2, 2, BLOCK.GLASS);
  box(-24, -24, 23, 23, 2, 2, BLOCK.GLASS);
  box(-31, -30, 22, 22, 2, 2, AIR);
  box(-36, -24, 22, 24, 3, 3, p.livery);
  box(-36, -36, 23, 23, 2, 2, AIR);
  box(-31, -27, 18, 18, 1, 1, BLOCK.SPRUCE_SLAB);
  for (const x of [-32, -26]) box(x, x, 19, 19, 1, 3, BLOCK.FENCE);
  box(-32, -26, 18, 19, 4, 4, BLOCK.GLASS);
  box(-39, -38, 28, 29, 1, 1, p.trim);
  box(-39, -38, 28, 29, 2, 2, BLOCK.OAK_LEAVES);
  lamp(box, -20, 28, 1, 3);
}

export const STATION: FreeArenaMapDef = {
  layout: 'free',
  id: 'station',
  name: 'Terminus',
  description: 'A railway station: two trains to run through, platforms, footbridges, tunnels and two halls with balconies',
  halfX: 42,
  halfZ: 34,
  wallHeight: 13,
  wallBlock: BLOCK.STONE_BRICKS,
  floorBlock: BLOCK.GRAVEL,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-8, 17], turn([-8, 17]), [-3, -24], turn([-3, -24])],
  objectives: {
    zones: [
      { name: 'Crossing', x: 0, z: 0, r: 4 },
      { name: 'West Platform', x: -9.5, z: 4, r: 4, level: 1 },
      { name: 'East Platform', x: 9.5, z: -4, r: 4, level: 1 },
      { name: 'Station Hall', x: -23, z: 0, r: 5, level: 0 },
      { name: 'Freight Hall', x: 23, z: 0, r: 5, level: 0 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -32.5, z: -21.5 }, { team: 'blue', x: 32.5, z: 21.5 }],
  },
  build(_variant, b) {
    half(b, 1, WEST);
    half(b, -1, EAST);
  },
};

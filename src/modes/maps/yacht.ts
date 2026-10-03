import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, turn, turned } from './helpers';

/**
 * "Riptide": a superyacht moored in a marina (inspired by the classic hijacked-yacht map). The
 * ship lies along the middle of the arena on a walkable blue "sea": a teak main deck with a
 * railing, a lower deck with a corridor and cabins inside the hull, a salon amidships whose roof
 * is a sun deck, a bridge on top of it at the bow end and a sky lounge at the stern end, a hot tub
 * on the bow and a helipad with a helicopter on the stern. The teams spawn on the marina docks
 * behind the bow (red) and the stern (blue); jetties, speedboats and rocks give cover on the water.
 *
 * Point symmetric except for the bow/stern shape and their decks, so the routes are fair.
 */

interface Side {
  /** The bow end (pointed, hot tub, bridge) or the stern end (square, helipad, sky lounge). */
  bow: boolean;
  boat: number;
  cushion: number;
}

const BOW: Side = { bow: true, boat: BLOCK.WHITE_WOOL, cushion: BLOCK.YELLOW_WOOL };
const STERN: Side = { bow: false, boat: BLOCK.YELLOW_WOOL, cushion: BLOCK.GREEN_WOOL };

const HULL = BLOCK.CONCRETE;
const DECK = BLOCK.OAK_PLANKS;
const RAIL = BLOCK.IRON_BARS;
const SEA = BLOCK.BLUE_WOOL;

const RED_SPAWNS: [number, number][] = [[-42, -6], [-39, -4], [-42, -2], [-39, 2], [-42, 4], [-38, 6]];
const FFA_WEST: [number, number][] = [[-40, -4], [-41, 6], [-38, -20], [-24, -22], [-18, 1], [-30, 17]];

/** Lowest z of the hull at column x (west-half coordinates); the hull is symmetric about z = -0.5. */
function hullMin(x: number, bow: boolean): number {
  return bow && x < -28 ? -8 + (-28 - x) : -8;
}

/** A speedboat: a hull with a pointed nose, a windscreen and seats. Nose towards +x. */
function speedboat(box: LayoutBuilder['box'], x: number, z: number, color: number, seat: number): void {
  box(x, x + 5, z, z + 2, 1, 1, color);
  box(x + 6, x + 6, z + 1, z + 1, 1, 1, color);
  box(x + 1, x + 4, z + 1, z + 1, 1, 1, AIR);
  box(x + 4, x + 4, z, z + 2, 2, 2, BLOCK.STAINED_GLASS);
  box(x + 1, x + 1, z + 1, z + 1, 1, 1, seat);
}

/** A buoy: a post with a coloured float. */
function buoy(box: LayoutBuilder['box'], x: number, z: number, color: number): void {
  box(x, x, z, z, 1, 1, color);
  box(x, x, z, z, 2, 2, BLOCK.FENCE);
  box(x, x, z, z, 3, 3, BLOCK.GLOWSTONE);
}

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const { box, paint } = turned(b, s);

  // --- The marina dock behind the ship: the team's spawn, with boat sheds on both flanks ----
  paint(-43, -36, -12, 11, BLOCK.SPRUCE_PLANKS);
  paint(-43, -43, -3, 2, TEAM);
  for (const z of [-12, 11]) for (const x of [-42, -38]) box(x, x, z, z, 1, 1, BLOCK.SPRUCE_LOG);
  // North shed: a hollow plank hut with a door to the dock and one to the sea.
  box(-43, -37, -19, -13, 1, 3, BLOCK.SPRUCE_PLANKS);
  box(-42, -38, -18, -14, 1, 2, AIR);
  box(-43, -37, -19, -13, 4, 4, BLOCK.SPRUCE_SLAB);
  box(-40, -39, -13, -13, 1, 2, AIR);
  box(-37, -37, -17, -16, 1, 2, AIR);
  box(-42, -42, -18, -16, 1, 2, BLOCK.CHEST);
  box(-40, -40, -16, -16, 3, 3, BLOCK.GLOWSTONE);
  // South: stacked crates and a dock crane post.
  box(-43, -42, 13, 15, 1, 2, BLOCK.OAK_PLANKS);
  box(-41, -40, 13, 14, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-38, -38, 13, 13, 1, 4, BLOCK.SPRUCE_LOG);
  box(-38, -36, 13, 13, 5, 5, BLOCK.SPRUCE_PLANKS);
  box(-36, -36, 13, 13, 3, 4, BLOCK.FENCE);
  // Cargo crates stacked along the south edge of the dock.
  box(-35, -34, 5, 11, 1, 2, BLOCK.OAK_PLANKS);
  box(-35, -35, 7, 9, 3, 3, BLOCK.SPRUCE_PLANKS);
  box(-34, -34, 10, 10, 1, 2, BLOCK.CRAFTING_TABLE);
  // Lamps on the dock corners.
  for (const z of [-11, 10]) {
    box(-36, -36, z, z, 1, 2, BLOCK.FENCE);
    box(-36, -36, z, z, 3, 3, BLOCK.GLOWSTONE);
  }

  // --- Hull: white sides with a dark waterline, the lower deck inside, the teak deck on top --
  for (let x = -34; x <= -1; x++) {
    const z0 = hullMin(x, p.bow), z1 = -1 - z0;
    box(x, x, z0, z1, 1, 1, BLOCK.OBSIDIAN);
    box(x, x, z0, z1, 2, 2, HULL);
    box(x, x, z0, z1, 3, 3, DECK);
    box(x, x, z0, z0, 3, 3, HULL);
    box(x, x, z1, z1, 3, 3, HULL);
    box(x, x, z0, z0, 4, 4, RAIL);
    box(x, x, z1, z1, 4, 4, RAIL);
    if (x > -34) box(x, x, z0 + 1, z1 - 1, 1, 2, AIR);
    else box(x, x, z0, z1, 4, 4, RAIL);
  }
  paint(-33, -1, -7, 6, BLOCK.BIRCH_PLANKS);
  // Lower deck: a corridor along the middle, cabins on both sides, lights in the deck above.
  box(-30, -1, -3, -3, 1, 2, BLOCK.BIRCH_PLANKS);
  box(-30, -1, 2, 2, 1, 2, BLOCK.BIRCH_PLANKS);
  for (const x of [-28, -20, -13, -5]) {
    box(x, x, -3, -3, 1, 2, AIR);
    box(x - 1, x - 1, 2, 2, 1, 2, AIR);
  }
  for (const x of [-24, -16, -8]) {
    box(x, x, -7, -4, 1, 2, BLOCK.BIRCH_PLANKS);
    box(x, x, 3, 6, 1, 2, BLOCK.BIRCH_PLANKS);
  }
  box(-23, -21, -7, -6, 1, 1, p.cushion);
  box(-23, -23, -7, -6, 1, 2, BLOCK.WHITE_WOOL);
  box(-15, -14, 5, 6, 1, 1, BLOCK.WHITE_WOOL);
  box(-12, -10, 6, 6, 1, 2, BLOCK.BOOKSHELF);
  box(-7, -6, -7, -6, 1, 1, BLOCK.FURNACE);
  box(-4, -2, -7, -7, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-30, -29, 4, 5, 1, 2, BLOCK.CHEST);
  for (const x of [-26, -18, -11, -3]) box(x, x, -1, -1, 3, 3, BLOCK.GLOWSTONE);
  // Side doors from the water into the lower deck.
  box(-17, -16, -8, -8, 1, 2, AIR);
  box(-27, -26, 7, 7, 1, 2, AIR);
  // Stairs from the corridor up into the salon.
  box(-9, -9, -1, 0, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-10, -10, -1, 0, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-10, -9, -1, 0, 3, 3, AIR);

  // Gangways from the water up onto the main deck (gaps in the railing).
  box(-24, -23, -10, -10, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-24, -23, -9, -9, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-24, -23, -8, -8, 4, 4, AIR);
  box(-11, -10, 9, 9, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-11, -10, 8, 8, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-11, -10, 7, 7, 4, 4, AIR);
  // From the dock onto the bow / the stern.
  box(-36, -36, -1, 0, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-35, -35, -1, 0, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-34, -34, -1, 0, 4, 4, AIR);

  // --- Salon amidships (x -12..-1 here, the stern half continues it) -------------------------
  box(-12, -1, -5, 4, 4, 6, HULL);
  box(-11, -1, -4, 3, 4, 6, AIR);
  box(-12, -1, -5, 4, 7, 7, HULL);
  box(-12, -12, -1, 0, 4, 5, AIR);
  box(-11, -2, -5, -5, 5, 6, BLOCK.STAINED_GLASS);
  box(-11, -2, 4, 4, 5, 6, BLOCK.STAINED_GLASS);
  box(-4, -3, -5, -5, 4, 5, AIR);
  box(-12, -12, -4, -3, 5, 6, BLOCK.STAINED_GLASS);
  box(-12, -12, 2, 3, 5, 6, BLOCK.STAINED_GLASS);
  // Sofas, a bar and lights.
  box(-11, -11, -4, -2, 4, 4, p.cushion);
  box(-11, -11, 1, 3, 4, 4, p.cushion);
  box(-8, -6, 3, 3, 4, 4, BLOCK.SPRUCE_PLANKS);
  box(-7, -7, 3, 3, 5, 5, BLOCK.STAINED_GLASS);
  box(-8, -6, -4, -4, 4, 4, BLOCK.WHITE_WOOL);
  for (const x of [-9, -3]) box(x, x, -1, -1, 7, 7, BLOCK.GLOWSTONE);
  // Steps from the fore deck up onto the sun deck, a railing round the sun deck.
  box(-15, -15, -4, -3, 4, 4, DECK);
  box(-14, -14, -4, -3, 4, 5, DECK);
  box(-13, -13, -4, -3, 4, 6, DECK);
  box(-12, -1, -5, -5, 8, 8, RAIL);
  box(-12, -1, 4, 4, 8, 8, RAIL);
  box(-12, -12, -2, 3, 8, 8, RAIL);
  box(-4, -2, 2, 3, 8, 8, BLOCK.WHITE_WOOL);

  // --- The bridge (bow end) or the sky lounge (stern end) on the sun deck -----------------
  if (p.bow) {
    box(-10, -6, -3, 1, 8, 9, HULL);
    box(-9, -7, -2, 0, 8, 9, AIR);
    box(-10, -10, -2, 0, 9, 9, BLOCK.STAINED_GLASS);
    box(-9, -7, -3, -3, 9, 9, BLOCK.STAINED_GLASS);
    box(-9, -7, 1, 1, 9, 9, BLOCK.STAINED_GLASS);
    box(-6, -6, -1, 0, 8, 9, AIR);
    box(-10, -6, -3, 1, 10, 10, HULL);
    box(-9, -9, -2, 0, 8, 8, BLOCK.FURNACE);
    box(-9, -9, -1, -1, 8, 8, BLOCK.NOTE_BLOCK);
    box(-8, -8, 0, 0, 10, 10, BLOCK.GLOWSTONE);
  } else {
    for (const [x, z] of [[-10, -3], [-10, 1], [-6, -3], [-6, 1]]) box(x, x, z, z, 8, 9, BLOCK.FENCE);
    box(-10, -6, -3, 1, 10, 10, BLOCK.WHITE_WOOL);
    box(-9, -9, -2, 0, 8, 8, p.cushion);
    box(-8, -8, -1, -1, 8, 8, BLOCK.SPRUCE_SLAB);
    box(-8, -8, -1, -1, 10, 10, BLOCK.GLOWSTONE);
  }

  // --- Fore deck: loungers along the rails; the bow gets a hot tub, the stern a helipad ----
  for (const x of [-26, -21, -17]) {
    box(x, x + 1, -7, -7, 4, 4, BLOCK.WHITE_WOOL);
    box(x, x + 1, 6, 6, 4, 4, p.cushion);
  }
  if (p.bow) {
    box(-32, -29, -3, 2, 4, 4, HULL);
    box(-31, -30, -2, 1, 4, 4, SEA);
    box(-28, -28, -1, 0, 4, 4, BLOCK.SPRUCE_SLAB);
  } else {
    // Helipad: a grey pad with a white H, a small helicopter parked on its edge.
    box(-33, -27, -6, 5, 3, 3, BLOCK.STONE);
    box(-31, -31, -3, 2, 3, 3, BLOCK.WHITE_WOOL);
    box(-29, -29, -3, 2, 3, 3, BLOCK.WHITE_WOOL);
    box(-30, -30, -1, 0, 3, 3, BLOCK.WHITE_WOOL);
    box(-33, -33, -6, 5, 3, 3, BLOCK.YELLOW_WOOL);
    box(-32, -29, 3, 4, 4, 5, p.boat);
    box(-32, -32, 3, 4, 5, 5, BLOCK.STAINED_GLASS);
    box(-28, -26, 4, 4, 5, 5, p.boat);
    box(-30, -30, 4, 4, 6, 6, BLOCK.FENCE);
    box(-33, -27, 4, 4, 7, 7, BLOCK.SPRUCE_SLAB);
  }

  // --- The water around the ship: a jetty, speedboats, buoys and rocks ---------------------
  // North: a floating jetty with a moored speedboat and a dinghy.
  paint(-32, -14, -21, -20, BLOCK.SPRUCE_PLANKS);
  paint(-20, -19, -27, -21, BLOCK.SPRUCE_PLANKS);
  for (const x of [-32, -26, -20, -14]) box(x, x, -21, -21, 1, 1, BLOCK.SPRUCE_LOG);
  speedboat(box, -31, -25, p.boat, p.cushion);
  box(-16, -14, -25, -24, 1, 1, BLOCK.YELLOW_WOOL);
  box(-15, -15, -25, -24, 1, 1, AIR);
  box(-28, -26, -17, -16, 1, 2, BLOCK.OAK_PLANKS);
  box(-27, -27, -16, -16, 3, 3, BLOCK.OAK_PLANKS);
  buoy(box, -8, -14, BLOCK.RED_WOOL);
  buoy(box, -35, -24, BLOCK.WHITE_WOOL);
  // South: a rocky islet with a lighthouse post, a fishing boat and a fuel pontoon.
  box(-22, -17, 15, 19, 1, 1, BLOCK.COBBLESTONE);
  box(-21, -18, 16, 18, 2, 2, BLOCK.MOSSY_COBBLESTONE);
  box(-20, -19, 16, 17, 3, 3, BLOCK.COBBLESTONE);
  paint(-23, -16, 14, 20, BLOCK.GRAVEL);
  box(-35, -26, 22, 24, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-34, -27, 23, 23, 1, 1, AIR);
  box(-32, -30, 22, 24, 2, 3, BLOCK.WHITE_WOOL);
  box(-32, -30, 23, 23, 2, 2, AIR);
  box(-31, -31, 22, 22, 3, 3, BLOCK.STAINED_GLASS);
  box(-28, -28, 23, 23, 2, 4, BLOCK.FENCE);
  paint(-13, -6, 22, 26, BLOCK.SPRUCE_PLANKS);
  box(-12, -11, 24, 24, 1, 2, BLOCK.FURNACE);
  box(-8, -7, 25, 26, 1, 1, BLOCK.OAK_PLANKS);
  box(-8, -8, 25, 25, 2, 2, BLOCK.OAK_PLANKS);
  buoy(box, -4, 14, BLOCK.WHITE_WOOL);
  buoy(box, -36, 18, BLOCK.YELLOW_WOOL);
  // Foam along the hull.
  paint(-33, -12, -9, -9, BLOCK.WHITE_WOOL);
  paint(-30, -18, 8, 8, BLOCK.WHITE_WOOL);
}

export const YACHT: FreeArenaMapDef = {
  layout: 'free',
  id: 'yacht',
  name: 'Riptide',
  description: 'A superyacht in a marina: a long deck, a lower deck, a bridge and a helipad over open water',
  halfX: 44,
  halfZ: 28,
  wallHeight: 13,
  wallBlock: BLOCK.STONE_BRICKS,
  floorBlock: SEA,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-3, -4], turn([-3, -4]), [-20, 0]],
  objectives: {
    zones: [
      { name: 'Salon', x: 0, z: 0, r: 4, level: 3 },
      { name: 'North Jetty', x: -20, z: -17, r: 5 },
      { name: 'South Jetty', x: 20, z: 17, r: 5 },
      { name: 'Fore Deck', x: -21, z: 0, r: 4, level: 3 },
      { name: 'Aft Deck', x: 21, z: 0, r: 4, level: 3 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -34.5, z: -17.5 }, { team: 'blue', x: 34.5, z: 17.5 }],
  },
  build(_variant, b) {
    half(b, 1, BOW);
    half(b, -1, STERN);
  },
};

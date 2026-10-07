import { BLOCK } from '../../world/BlockRegistry';
import { type ArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { building, door, glass, stairs } from './helpers';

/** A one block high parapet on the roof edges that are listed (the side with the stairs stays open). */
function parapet(b: LayoutBuilder, u0: number, u1: number, v0: number, v1: number, h: number, sides: ('u0' | 'u1' | 'v0' | 'v1')[], id: number): void {
  if (sides.includes('u0')) b.box(u0, u0, v0, v1, h + 1, h + 1, id);
  if (sides.includes('u1')) b.box(u1, u1, v0, v1, h + 1, h + 1, id);
  if (sides.includes('v0')) b.box(u0, u1, v0, v0, h + 1, h + 1, id);
  if (sides.includes('v1')) b.box(u0, u1, v1, v1, h + 1, h + 1, id);
}

/**
 * "Old Quarter": a mid-size urban map (80 × 64). A cobbled courtyard with a fountain in the middle,
 * a gatehouse north of it, tall brick blocks with balconies and roof stairs, 4-wide alleys running
 * between the blocks and a walled plaza for each team at the far end.
 */
export const QUARTER: ArenaMapDef = {
  id: 'quarter',
  name: 'Old Quarter',
  description: 'Urban: a courtyard in the middle, balconies, roof stairs and alley flanks',
  halfX: 40,
  halfZ: 32,
  wallHeight: 13,
  wallBlock: BLOCK.BRICKS,
  floorBlock: BLOCK.COBBLESTONE,
  variants: 1,
  teamSpawns: [[34, 3], [36, 6], [33, 8], [37, 9]],
  ffaSpawns: [[8, 4], [22, 5], [22, 20], [34, 18], [5, 22]],
  highGround: [[5, 20], [20, 5], [20, 20], [13, 20], [34, 20]],
  objectives: {
    // Hardpoint order: the courtyard, the two gatehouse streets, then the two back squares.
    zones: [
      { name: 'Courtyard', x: 0, z: 6, r: 5 },
      { name: 'West Gate', x: -12.5, z: 4.5, r: 5 },
      { name: 'East Gate', x: 12.5, z: 4.5, r: 5 },
      { name: 'West Square', x: -18.5, z: 26, r: 4 },
      { name: 'East Square', x: 18.5, z: 26, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -36.5, z: 28.5 }, { team: 'blue', x: 36.5, z: 28.5 }],
    // Search and destroy: bomb sites in the blue half (see scripts/site-scan.ts).
    sites: [{ name: 'A', x: 16.5, z: -18.5, r: 3 }, { name: 'B', x: 16.5, z: 18.5, r: 3 }],
  },
  build(_variant, b) {
    const { box, paint } = b;

    // Courtyard paving, the team plazas and a stripe down the alleys.
    paint(0, 10, 0, 10, BLOCK.STONE_BRICKS);
    paint(30, 38, 0, 10, TEAM);
    paint(11, 14, 0, 30, BLOCK.GRAVEL);
    paint(0, 38, 11, 14, BLOCK.GRAVEL);
    paint(26, 29, 0, 30, BLOCK.GRAVEL);

    // Courtyard: a low fountain in the middle, arcade pillars and planters.
    box(0, 2, 0, 2, 1, 1, BLOCK.STONE_BRICKS);
    box(0, 0, 0, 0, 2, 3, BLOCK.STONE_BRICKS);
    for (const [pu, pv] of [[5, 1], [1, 5], [8, 8]]) box(pu, pu, pv, pv, 1, 3, BLOCK.STONE_BRICKS);
    box(6, 7, 3, 4, 1, 1, BLOCK.GREEN_WOOL);
    box(3, 4, 7, 8, 1, 1, BLOCK.GREEN_WOOL);

    // The gatehouse north of the courtyard: a passage through the middle, windows, a roof with stairs.
    building(b, 0, 10, 15, 25, 5, BLOCK.BRICKS, [
      door('v0', 0, 2), door('v1', 0, 2), door('u1', 19, 21),
      glass('v0', 6, 8), glass('v1', 6, 8), glass('u1', 16, 17), glass('u1', 23, 24),
    ], BLOCK.BIRCH_PLANKS);
    box(0, 10, 15, 15, 4, 4, TEAM);
    box(5, 5, 20, 21, 1, 2, BLOCK.BOOKSHELF);
    box(8, 9, 22, 22, 1, 1, BLOCK.OAK_PLANKS);
    box(3, 3, 18, 18, 1, 4, BLOCK.STONE_BRICKS);
    stairs(b, 'v', 26, -1, 4, 11, 12, BLOCK.OAK_PLANKS);
    parapet(b, 0, 10, 15, 25, 5, ['v0', 'v1'], BLOCK.BRICKS);

    // East block next to the courtyard: doors on both sides, a ramp-like stair on the south alley.
    building(b, 15, 25, 0, 10, 5, BLOCK.STONE_BRICKS, [
      door('u0', 3, 5), door('u1', 7, 9),
      glass('u0', 8, 9), glass('u0', 0, 0), glass('u1', 1, 2), glass('v1', 18, 19), glass('v1', 22, 23),
    ], BLOCK.SPRUCE_PLANKS);
    box(20, 20, 3, 4, 1, 4, BLOCK.STONE_BRICKS);
    box(17, 18, 7, 8, 1, 2, BLOCK.BOOKSHELF);
    box(22, 23, 1, 2, 1, 1, BLOCK.OAK_PLANKS);
    stairs(b, 'u', 16, 1, 4, 11, 12, BLOCK.OAK_PLANKS);
    parapet(b, 15, 25, 0, 10, 5, ['u0', 'u1'], BLOCK.STONE_BRICKS);

    // The balcony block: ledges over the west alley, reached from the gatehouse stairs.
    building(b, 15, 25, 15, 25, 5, BLOCK.BRICKS, [
      door('u0', 19, 21), door('v0', 22, 24), door('u1', 17, 18),
      glass('u0', 16, 17), glass('u0', 23, 24), glass('v1', 18, 19), glass('v1', 22, 23), glass('u1', 22, 23),
    ], BLOCK.BIRCH_PLANKS);
    box(13, 14, 16, 24, 3, 3, BLOCK.SPRUCE_PLANKS);
    box(14, 14, 24, 24, 4, 4, BLOCK.OAK_PLANKS);
    box(20, 21, 20, 21, 1, 2, BLOCK.OAK_PLANKS);
    box(17, 17, 17, 18, 1, 2, BLOCK.BOOKSHELF);
    parapet(b, 15, 25, 15, 25, 5, ['u1', 'v1', 'v0'], BLOCK.BRICKS);

    // Team plaza: a low wall with openings to the alleys, crates in the team colour, a cart.
    box(30, 30, 0, 2, 1, 2, BLOCK.STONE_BRICKS);
    box(30, 30, 7, 10, 1, 2, BLOCK.STONE_BRICKS);
    box(34, 35, 11, 12, 1, 2, TEAM);
    box(37, 38, 12, 13, 1, 1, BLOCK.OAK_PLANKS);
    box(32, 33, 1, 1, 1, 1, BLOCK.OAK_PLANKS);
    box(38, 38, 0, 0, 1, 3, BLOCK.STONE_BRICKS);

    // The cafe behind the plaza: hollow, with a stair up its roof from the north alley.
    building(b, 30, 38, 15, 25, 5, BLOCK.SPRUCE_PLANKS, [
      door('u0', 19, 21), door('v0', 33, 35), door('v0', 37, 37),
      glass('u0', 16, 17), glass('u0', 23, 24), glass('v1', 31, 32), glass('v1', 36, 37),
    ], BLOCK.OAK_PLANKS);
    box(33, 36, 20, 21, 1, 1, BLOCK.OAK_PLANKS);
    box(31, 31, 23, 24, 1, 2, BLOCK.BOOKSHELF);
    box(30, 38, 15, 15, 4, 4, TEAM);
    stairs(b, 'u', 30, 1, 4, 26, 27, BLOCK.OAK_PLANKS);
    parapet(b, 30, 38, 15, 25, 5, ['u0', 'u1', 'v0'], BLOCK.SPRUCE_PLANKS);

    // Cover in the alleys breaks the long sight lines: staggered crates and carts.
    box(19, 20, 11, 12, 1, 2, BLOCK.OAK_PLANKS);
    box(23, 24, 13, 14, 1, 2, BLOCK.OAK_PLANKS);
    box(31, 32, 13, 14, 1, 1, BLOCK.OAK_PLANKS);
    box(12, 13, 12, 13, 1, 2, BLOCK.BIRCH_PLANKS);
    box(27, 28, 18, 19, 1, 2, BLOCK.OAK_PLANKS);
    box(26, 27, 5, 6, 1, 1, BLOCK.OAK_PLANKS);
    box(13, 14, 28, 29, 1, 1, BLOCK.OAK_PLANKS);
    box(27, 28, 28, 29, 1, 2, BLOCK.OAK_PLANKS);
    box(7, 8, 12, 13, 1, 1, BLOCK.YELLOW_WOOL);
    box(12, 12, 3, 4, 1, 1, BLOCK.YELLOW_WOOL);
  },
};

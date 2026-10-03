import { BLOCK } from '../../world/BlockRegistry';
import { type ArenaMapDef, TEAM } from './ArenaMap';
import { building, car, door, glass, stairs } from './helpers';

/**
 * "Maple Court": a small, frantic suburban map (64 × 40). Each team owns a brick house with its
 * back garden behind it; between the houses is the street with parked cars and a van. Garages sit
 * at the street corners, trees and a shed fill the gardens. Tight sight lines everywhere.
 */
export const SUBURB: ArenaMapDef = {
  id: 'suburb',
  name: 'Maple Court',
  description: 'Small and frantic: two facing houses, a street, garages and gardens',
  halfX: 32,
  halfZ: 20,
  wallHeight: 9,
  wallBlock: BLOCK.BIRCH_PLANKS,
  floorBlock: BLOCK.GRASS,
  variants: 1,
  teamSpawns: [[28, 3], [26, 6], [28, 8], [27, 14]],
  ffaSpawns: [[10, 5], [20, 7], [21, 16], [6, 16]],
  highGround: [[21, 4]],
  objectives: {
    // Small map: hills on the street only, never in the gardens next to the spawns.
    zones: [
      { name: 'Van', x: 0, z: 6, r: 5 },
      { name: 'West Kerb', x: -9.5, z: 10.5, r: 4 },
      { name: 'East Kerb', x: 9.5, z: 10.5, r: 4 },
      { name: 'West Corner', x: -8.5, z: -12.5, r: 4 },
      { name: 'East Corner', x: 8.5, z: -12.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
  },
  build(_variant, b) {
    const { box, paint } = b;

    // Street with a dashed centre line, a pavement in front of each house, a team-coloured patio.
    paint(0, 13, 0, 18, BLOCK.STONE);
    for (let v = 0; v <= 18; v += 3) paint(0, 0, v, v + 1, BLOCK.YELLOW_WOOL);
    paint(12, 13, 0, 18, BLOCK.GRAVEL);
    paint(25, 29, 4, 9, TEAM);

    // The house: brick, flat roof, team-coloured band above the front door.
    building(b, 14, 23, 0, 11, 4, BLOCK.BRICKS, [
      door('u0', 2, 4), glass('u0', 7, 9), glass('u0', 0, 0),
      door('u1', 7, 9), glass('u1', 1, 2),
      glass('v1', 16, 17), glass('v1', 20, 21),
    ]);
    box(14, 14, 0, 11, 4, 4, TEAM);
    // Inside: a dividing wall with two doorways, a sofa, a table and a bookcase, lamps in the ceiling.
    box(18, 18, 0, 10, 1, 3, BLOCK.BRICKS);
    box(18, 18, 4, 6, 1, 2, BLOCK.AIR);
    box(18, 18, 0, 1, 1, 2, BLOCK.AIR);
    box(16, 17, 9, 10, 1, 2, BLOCK.BOOKSHELF);
    box(15, 15, 8, 10, 1, 1, BLOCK.GREEN_WOOL);
    box(21, 22, 2, 3, 1, 1, BLOCK.OAK_PLANKS);
    box(20, 20, 9, 10, 1, 1, BLOCK.CRAFTING_TABLE);
    box(16, 16, 2, 2, 4, 4, BLOCK.GLOWSTONE);
    box(21, 21, 8, 8, 4, 4, BLOCK.GLOWSTONE);
    box(19, 19, 5, 5, 4, 4, BLOCK.GLASS);
    // Stairs in the back garden up to the flat roof, with a low parapet on the street side.
    stairs(b, 'u', 27, -1, 4, 9, 11, BLOCK.OAK_PLANKS);
    box(14, 14, 0, 11, 5, 5, BLOCK.BRICKS);
    box(14, 23, 11, 11, 5, 5, BLOCK.BRICKS);

    // The garage on the street corner: a door to the street, a door to the garden, a car inside.
    building(b, 16, 24, 12, 18, 3, BLOCK.STONE_BRICKS, [door('u0', 14, 17), door('u1', 13, 14), glass('v0', 20, 21, 2, 2)]);
    box(17, 19, 13, 14, 1, 1, BLOCK.YELLOW_WOOL);
    box(22, 23, 17, 18, 1, 2, BLOCK.OAK_PLANKS);
    box(16, 16, 12, 18, 3, 3, TEAM);

    // Back garden: shed, hedge, two trees, a bin.
    box(29, 30, 12, 14, 1, 2, BLOCK.SPRUCE_PLANKS);
    box(25, 28, 12, 12, 1, 1, BLOCK.GREEN_WOOL);
    for (const [tu, tv] of [[29, 6], [27, 16]]) {
      box(tu, tu, tv, tv, 1, 3, BLOCK.OAK_LOG);
      box(tu - 1, tu + 1, tv - 1, tv + 1, 4, 5, BLOCK.OAK_LEAVES);
    }
    box(30, 30, 2, 2, 1, 1, BLOCK.COBBLESTONE);

    // The street: a van across the centre, parked cars, hedges and bins.
    box(0, 3, 0, 1, 1, 2, BLOCK.WHITE_WOOL);
    box(1, 2, 0, 1, 3, 3, BLOCK.GLASS);
    car(b, 6, 4, true, BLOCK.YELLOW_WOOL);
    car(b, 4, 9, false, BLOCK.GREEN_WOOL);
    car(b, 9, 14, true, BLOCK.WHITE_WOOL);
    car(b, 2, 15, true, BLOCK.YELLOW_WOOL);
    box(11, 11, 6, 8, 1, 1, BLOCK.GREEN_WOOL);
    box(7, 8, 1, 1, 1, 1, BLOCK.COBBLESTONE);
    box(12, 12, 10, 11, 1, 2, BLOCK.OAK_PLANKS);
  },
};

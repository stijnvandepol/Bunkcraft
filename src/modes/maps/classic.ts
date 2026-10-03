import { BLOCK } from '../../world/BlockRegistry';
import { type ArenaMapDef, TEAM } from './ArenaMap';

/** The original arena: raised centre platform, two corridors, a side perch and a sniper nest per base. */
export const CLASSIC: ArenaMapDef = {
  id: 'classic',
  name: 'Classic',
  description: 'Balanced all-rounder: centre platform, corridors and cover',
  halfX: 48,
  halfZ: 48,
  wallHeight: 12,
  wallBlock: BLOCK.STONE_BRICKS,
  floorBlock: BLOCK.STONE,
  variants: 3,
  teamSpawns: [[36, 2], [40, 1], [36, 9], [41, 6]],
  ffaSpawns: [[28, 10], [30, 28], [12, 40]],
  objectives: {
    // Hardpoint order: the middle lane, then the two lanes beside the platform, then the two far flanks.
    zones: [
      { name: 'Centre Platform', x: 0, z: 6.5, r: 5 },
      { name: 'West Lane', x: -22, z: 4, r: 5 },
      { name: 'East Lane', x: 22, z: 4, r: 5 },
      { name: 'South West', x: -27, z: -27, r: 5 },
      { name: 'South East', x: 27, z: -27, r: 5 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -44, z: 18 }, { team: 'blue', x: 44, z: 18 }],
  },
  build(variant, b) {
    const { box, paint } = b;
    // Floor markings: white centre lines and the team bases.
    paint(0, 0, 7, 46, BLOCK.WHITE_WOOL);
    paint(7, 46, 0, 0, BLOCK.WHITE_WOOL);
    paint(33, 46, 0, 16, TEAM);

    // Centre platform (3 high, planks on top) with steps on all four sides and corner cover.
    box(0, 6, 0, 6, 1, 2, BLOCK.STONE_BRICKS);
    box(0, 6, 0, 6, 3, 3, BLOCK.OAK_PLANKS);
    box(7, 7, 0, 3, 1, 2, BLOCK.OAK_PLANKS);
    box(8, 8, 0, 3, 1, 1, BLOCK.OAK_PLANKS);
    box(0, 3, 7, 7, 1, 2, BLOCK.OAK_PLANKS);
    box(0, 3, 8, 8, 1, 1, BLOCK.OAK_PLANKS);
    box(0, 1, 0, 1, 4, 5, BLOCK.STONE_BRICKS);
    box(6, 6, 4, 6, 4, 5, BLOCK.STONE_BRICKS);
    box(4, 5, 6, 6, 4, 5, BLOCK.STONE_BRICKS);

    // Team base: a front wall with a gap towards the centre, pillars and a raised sniper nest.
    box(33, 33, 8, 16, 1, 4, BLOCK.STONE_BRICKS);
    box(38, 39, 4, 5, 1, 4, TEAM);
    box(42, 42, 8, 14, 1, 1, BLOCK.OAK_PLANKS);
    box(43, 46, 8, 14, 1, 2, BLOCK.OAK_PLANKS);
    box(43, 46, 15, 15, 3, 3, BLOCK.STONE_BRICKS);

    // Two corridors (4 wide) with windows, one per quadrant edge.
    box(14, 30, 19, 19, 1, 4, BLOCK.STONE_BRICKS);
    box(14, 30, 24, 24, 1, 4, BLOCK.STONE_BRICKS);
    box(20, 23, 19, 19, 3, 4, BLOCK.GLASS);
    box(20, 23, 24, 24, 3, 4, BLOCK.GLASS);

    // Raised side perch with steps and a rail.
    box(20, 27, 36, 44, 1, 2, BLOCK.OAK_PLANKS);
    box(19, 19, 38, 42, 1, 1, BLOCK.OAK_PLANKS);
    box(22, 25, 35, 35, 1, 1, BLOCK.OAK_PLANKS);
    box(20, 27, 44, 44, 3, 3, BLOCK.STONE_BRICKS);

    // Cover that differs per variant.
    const crate = (u: number, v: number, w: number, d: number, h: number, id: number) =>
      box(u, u + w - 1, v, v + d - 1, 1, h, id);
    if (variant === 0) {
      crate(10, 14, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(22, 8, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(26, 28, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(34, 24, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(28, 3, 3, 1, 2, BLOCK.STONE_BRICKS);
      crate(11, 28, 1, 3, 2, BLOCK.STONE_BRICKS);
      crate(14, 8, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(32, 36, 2, 1, 1, BLOCK.YELLOW_WOOL);
      crate(8, 20, 1, 1, 1, BLOCK.YELLOW_WOOL);
    } else if (variant === 1) {
      crate(12, 11, 3, 3, 2, BLOCK.OAK_PLANKS);
      crate(24, 12, 2, 2, 3, BLOCK.STONE_BRICKS);
      crate(32, 28, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(8, 30, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(30, 3, 1, 3, 2, BLOCK.STONE_BRICKS);
      crate(15, 33, 3, 1, 2, BLOCK.STONE_BRICKS);
      crate(10, 22, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(34, 40, 1, 2, 1, BLOCK.YELLOW_WOOL);
      crate(20, 4, 2, 1, 1, BLOCK.YELLOW_WOOL);
    } else {
      crate(11, 10, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(26, 9, 4, 1, 2, BLOCK.STONE_BRICKS);
      crate(35, 22, 2, 3, 2, BLOCK.OAK_PLANKS);
      crate(9, 27, 3, 3, 2, BLOCK.OAK_PLANKS);
      crate(16, 14, 1, 3, 3, BLOCK.STONE_BRICKS);
      crate(31, 34, 2, 2, 2, BLOCK.STONE_BRICKS);
      crate(6, 18, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(36, 31, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(21, 29, 2, 1, 1, BLOCK.YELLOW_WOOL);
    }
  },
};

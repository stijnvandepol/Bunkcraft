import { BLOCK } from '../../world/BlockRegistry';
import { type ArenaMapDef, TEAM } from './ArenaMap';
import { AIR, jumpPad } from './helpers';

/**
 * The original arena, tightened to 72 × 72 (it was 96 × 96 and the most open, slowest map): a raised centre platform,
 * a walled corridor and a perch per quadrant, and a closed base per team with its doors in the side walls, so nothing
 * on the enemy half looks into a spawn. Plenty of low cover on every lane (the long north-south lane in the middle is
 * cut into short stretches) and a jump pad per quadrant from the back field to the perch.
 */
export const CLASSIC: ArenaMapDef = {
  id: 'classic',
  name: 'Classic',
  description: 'Compact all-rounder: centre platform, corridors, a perch and cover on every lane',
  halfX: 36,
  halfZ: 36,
  wallHeight: 12,
  wallBlock: BLOCK.STONE_BRICKS,
  floorBlock: BLOCK.STONE,
  variants: 3,
  teamSpawns: [[27, 2], [30, 1], [27, 7], [31, 5]],
  ffaSpawns: [[19, 9], [21, 25], [9, 30]],
  objectives: {
    // Hardpoint order: the middle lane, then the two lanes beside the platform, then the two far flanks.
    zones: [
      { name: 'Centre Platform', x: 0, z: 6.5, r: 5 },
      { name: 'West Lane', x: -15, z: 4, r: 5 },
      { name: 'East Lane', x: 15, z: 4, r: 5 },
      { name: 'South West', x: -22, z: -25, r: 5 },
      { name: 'South East', x: 22, z: -25, r: 5 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -31, z: 18 }, { team: 'blue', x: 31, z: 18 }],
    // Search and destroy: bomb sites in the blue half.
    sites: [{ name: 'A', x: 16.5, z: -10.5, r: 3 }, { name: 'B', x: 16.5, z: 10.5, r: 3 }],
  },
  build(variant, b) {
    const { box, paint } = b;
    // Floor markings: white centre lines and the team bases.
    paint(0, 0, 7, 34, BLOCK.WHITE_WOOL);
    paint(7, 34, 0, 0, BLOCK.WHITE_WOOL);
    paint(24, 34, 0, 13, TEAM);

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

    // Team base: a closed room (front wall, side wall with a door, back wall is the arena wall). Inside: baffles
    // and the team colours; the doors face the field behind it, away from the enemy half.
    box(24, 24, 0, 13, 1, 5, BLOCK.STONE_BRICKS);
    box(24, 34, 13, 13, 1, 5, BLOCK.STONE_BRICKS);
    box(25, 26, 13, 13, 1, 3, AIR);
    // A second door in the front wall, high up: its sight lines run into the corridor wall, never to the enemy half.
    box(24, 24, 10, 11, 1, 3, AIR);
    box(29, 30, 3, 3, 1, 3, TEAM);
    box(27, 27, 10, 12, 1, 2, BLOCK.OAK_PLANKS);
    box(32, 34, 9, 9, 1, 2, BLOCK.OAK_PLANKS);

    // Corridors (4 wide) with windows, one per quadrant edge.
    box(9, 22, 14, 14, 1, 4, BLOCK.STONE_BRICKS);
    box(9, 22, 19, 19, 1, 4, BLOCK.STONE_BRICKS);
    box(15, 18, 14, 14, 3, 4, BLOCK.GLASS);
    box(15, 18, 19, 19, 3, 4, BLOCK.GLASS);

    // Raised side perch with steps and a rail, and a jump pad from the back field.
    box(15, 20, 27, 32, 1, 2, BLOCK.OAK_PLANKS);
    box(14, 14, 28, 31, 1, 1, BLOCK.OAK_PLANKS);
    box(16, 19, 26, 26, 1, 1, BLOCK.OAK_PLANKS);
    box(15, 20, 32, 32, 3, 3, BLOCK.STONE_BRICKS);
    jumpPad(b, 24, 29);

    // Cover that differs per variant.
    const crate = (u: number, v: number, w: number, d: number, h: number, id: number) =>
      box(u, u + w - 1, v, v + d - 1, 1, h, id);
    // Cover every variant has: breaks the long lanes (north-south in the middle, east-west beside the platform).
    crate(4, 16, 3, 1, 2, BLOCK.STONE_BRICKS);
    crate(8, 25, 1, 3, 2, BLOCK.STONE_BRICKS);
    crate(12, 9, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(19, 4, 1, 3, 2, BLOCK.STONE_BRICKS);
    crate(1, 28, 2, 1, 1, BLOCK.YELLOW_WOOL);
    if (variant === 0) {
      crate(8, 11, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(17, 23, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(23, 20, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(29, 25, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(21, 7, 3, 1, 2, BLOCK.STONE_BRICKS);
      crate(7, 31, 1, 3, 2, BLOCK.STONE_BRICKS);
      crate(12, 20, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(26, 17, 2, 1, 1, BLOCK.YELLOW_WOOL);
      crate(5, 21, 1, 1, 1, BLOCK.YELLOW_WOOL);
    } else if (variant === 1) {
      crate(9, 11, 3, 2, 2, BLOCK.OAK_PLANKS);
      crate(18, 23, 2, 2, 3, BLOCK.STONE_BRICKS);
      crate(26, 22, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(7, 22, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(20, 8, 1, 3, 2, BLOCK.STONE_BRICKS);
      crate(10, 29, 3, 1, 2, BLOCK.STONE_BRICKS);
      crate(7, 17, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(28, 30, 1, 2, 1, BLOCK.YELLOW_WOOL);
      crate(17, 7, 2, 1, 1, BLOCK.YELLOW_WOOL);
    } else {
      crate(10, 10, 2, 2, 2, BLOCK.OAK_PLANKS);
      crate(17, 4, 3, 1, 2, BLOCK.STONE_BRICKS);
      crate(27, 20, 2, 3, 2, BLOCK.OAK_PLANKS);
      crate(8, 27, 3, 2, 2, BLOCK.OAK_PLANKS);
      crate(12, 22, 1, 3, 3, BLOCK.STONE_BRICKS);
      crate(24, 32, 2, 2, 2, BLOCK.STONE_BRICKS);
      crate(4, 12, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(30, 22, 1, 1, 1, BLOCK.YELLOW_WOOL);
      crate(14, 31, 2, 1, 1, BLOCK.YELLOW_WOOL);
    }
  },
};

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BLOCK, LIGHT_COLUMN, OPAQUE, SOLID } from '../src/world/BlockRegistry';
import { ARENA_FLOOR_Y, MAPS } from '../src/modes/maps';

/**
 * Room support (tall walls + a ceiling) must not touch any other map: golden hashes of every block (floor - 1 up to
 * 40 above the floor, one block outside the arena, all variants) of the maps that are not rooms, taken before the
 * room code existed. Change a map on purpose: update its hash here.
 */
const GOLDEN: Record<string, string> = {
  classic: '04d47434e256', suburb: 'f6f99ce44608', quarter: '3787eb232306', dockyard: 'bff0f22f8d79', desert: '8356b591a0ac',
  atomic: '4a30a283c3da', bunker: '67d399dc5eea', villa: '1414c0c7aee1', yacht: '1f1342073a9d', town: '4330945592b5',
  station: 'ee4656d147bb', plaza: '50af2d641269', site: '60c9db94bfea', carrier: '620f8947a628', shanty: '680449f8f44c',
  mall: '596348f93638', scrap: '3e235fb0a96d',
};

describe('room maps', () => {
  it('leave every other map byte-identical', () => {
    for (const m of MAPS) {
      if (m.room) continue;
      if (!GOLDEN[m.id]) continue; // the giant-house maps are rebuilt on purpose
      const h = createHash('sha1');
      const b = m.bounds;
      for (let v = 0; v < m.variants; v++) {
        for (let x = b.minX - 1; x <= b.maxX; x++) {
          for (let z = b.minZ - 1; z <= b.maxZ; z++) {
            const col = Buffer.alloc(42);
            for (let y = ARENA_FLOOR_Y - 1; y <= ARENA_FLOOR_Y + 40; y++) col[y - ARENA_FLOOR_Y + 1] = m.blockAt(v, x, y, z);
            h.update(col);
          }
        }
      }
      expect(h.digest('hex').slice(0, 12), m.id).toBe(GOLDEN[m.id]);
    }
    expect(Object.keys(GOLDEN).every((id) => MAPS.some((m) => m.id === id))).toBe(true);
  }, 120000);

  it('the ceiling tile is solid, looks opaque but passes sky light', () => {
    expect(SOLID[BLOCK.CEILING]).toBe(1);
    expect(OPAQUE[BLOCK.CEILING]).toBe(0);
    expect(LIGHT_COLUMN[BLOCK.CEILING]).toBe(0);
  });

  const rooms = MAPS.filter((m) => m.room);

  for (const map of rooms) {
    it(`${map.id}: closed by a ceiling over the walls, nothing above it`, () => {
      const room = map.room!, b = map.bounds, top = ARENA_FLOOR_Y + map.wallHeight + 1;
      expect(map.wallHeight + 1).toBeLessThanOrEqual(room.ceiling);
      expect(ARENA_FLOOR_Y + room.ceiling).toBeLessThan(127);
      for (let v = 0; v < map.variants; v++) {
        for (let x = b.minX; x < b.maxX; x++) {
          for (let z = b.minZ; z < b.maxZ; z++) {
            expect(SOLID[map.blockAt(v, x, top, z)], `ceiling at ${x},${z}`).toBe(1);
            for (let y = ARENA_FLOOR_Y + room.ceiling + 1; y <= ARENA_FLOOR_Y + room.ceiling + 3; y++) expect(map.blockAt(v, x, y, z)).toBe(BLOCK.AIR);
          }
        }
      }
    });
  }
});

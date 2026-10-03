import { describe, expect, it } from 'vitest';
import { ARENA_FLOOR_Y, ARENA_SPAWNS, ArenaGenerator } from '../src/modes/arena';
import { TEAM } from '../src/modes/maps/ArenaMap';
import { DEFAULT_MAP, MAPS, MAP_IDS, getMap, nextMap, parseMapId, parseMapSetting } from '../src/modes/maps';
import { traceBlocks } from '../server/Combat';
import { BLOCK, BLOCK_DEFS, SOLID } from '../src/world/BlockRegistry';
import { CHUNK_SIZE, CHUNK_VOLUME, blockIndex } from '../src/world/constants';
import { arenaMapOf, arenaWorldType, createGenerator, isArenaWorld } from '../src/world/WorldGenerator';

const mirrorX = (x: number) => -1 - x;
const swapTeam = (id: number) => (id === BLOCK.RED_WOOL ? BLOCK.BLUE_WOOL : id === BLOCK.BLUE_WOOL ? BLOCK.RED_WOOL : id);

describe('arena maps', () => {
  it('has at least three maps with unique ids and a default', () => {
    expect(MAPS.length).toBe(7);
    expect(new Set(MAP_IDS).size).toBe(MAP_IDS.length);
    expect(MAP_IDS).toContain(DEFAULT_MAP);
    expect(MAP_IDS).toEqual(['classic', 'suburb', 'quarter', 'dockyard', 'desert', 'atomic', 'bunker']);
  });

  for (const map of MAPS) {
    for (let variant = 0; variant < map.variants; variant++) {
      const label = `${map.id} variant ${variant}`;
      const at = (x: number, y: number, z: number) => map.blockAt(variant, x, y, z);
      const solid = (x: number, y: number, z: number) => SOLID[at(Math.floor(x), y, Math.floor(z))] === 1;
      const b = map.bounds;

      if (!map.mirrored) {
        it(`${label} is fair: the teams get equally many spawns at the same distance from the centre`, () => {
          expect(map.spawns.blue.length).toBe(map.spawns.red.length);
          const mean = (s: { x: number; z: number }[]) => s.reduce((a, p) => a + Math.hypot(p.x, p.z), 0) / s.length;
          expect(Math.abs(mean(map.spawns.red) - mean(map.spawns.blue))).toBeLessThan(1);
        });
      }

      if (map.mirrored) it(`${label} is mirror symmetric (colours swap left/right)`, () => {
        let mismatches = 0;
        for (let y = ARENA_FLOOR_Y - 1; y <= ARENA_FLOOR_Y + map.wallHeight + 1; y++) {
          for (let x = b.minX; x < b.maxX; x++) {
            for (let z = b.minZ; z < b.maxZ; z++) {
              const id = at(x, y, z);
              if (swapTeam(at(mirrorX(x), y, z)) !== id) mismatches++;
              if (at(x, y, -1 - z) !== id) mismatches++;
            }
          }
        }
        expect(mismatches).toBe(0);
      });

      it(`${label}: spawns stand on the floor with free space above and face the centre`, () => {
        const all = [...map.spawns.red, ...map.spawns.blue, ...map.spawns.ffa];
        expect(map.spawns.red.length).toBeGreaterThanOrEqual(6);
        expect(map.spawns.blue.length).toBe(map.spawns.red.length);
        expect(map.spawns.ffa.length).toBeGreaterThanOrEqual(12);
        for (const s of map.spawns.red) expect(s.x).toBeLessThan(0);
        for (const s of map.spawns.blue) expect(s.x).toBeGreaterThan(0);
        for (const s of all) {
          expect(s.y).toBe(ARENA_FLOOR_Y + 1);
          expect(map.inBounds(s.x, s.z)).toBe(true);
          expect(solid(s.x, ARENA_FLOOR_Y, s.z)).toBe(true);
          for (const dy of [1, 2]) {
            for (const [ox, oz] of [[0, 0], [0.4, 0.4], [-0.4, 0.4], [0.4, -0.4], [-0.4, -0.4]]) {
              expect(at(Math.floor(s.x + ox), ARENA_FLOOR_Y + dy, Math.floor(s.z + oz))).toBe(BLOCK.AIR);
            }
          }
          // Forward vector of the camera is (-sin yaw, -cos yaw); it must point towards the origin.
          expect(-Math.sin(s.yaw) * -s.x + -Math.cos(s.yaw) * -s.z).toBeGreaterThan(0.99 * Math.hypot(s.x, s.z));
        }
      });

      it(`${label}: every spawn can reach every other spawn on foot`, () => {
        // Flood fill over standing spots (x, z, surface y), so floors under roofs and decks count.
        // A step up may be 1 block (a jump), drops are free; head room is 2 blocks.
        const air = (x: number, y: number, z: number) => at(x, y, z) === BLOCK.AIR;
        const standable = (x: number, y: number, z: number) => SOLID[at(x, y, z)] === 1 && air(x, y + 1, z) && air(x, y + 2, z);
        const key = (x: number, z: number, y: number) => ((x + 100) * 1000 + (z + 100)) * 1000 + y;
        const sx = Math.floor(map.spawns.ffa[0].x), sz = Math.floor(map.spawns.ffa[0].z);
        const seen = new Set<number>([key(sx, sz, ARENA_FLOOR_Y)]);
        const queue: [number, number, number][] = [[sx, sz, ARENA_FLOOR_Y]];
        while (queue.length) {
          const [x, z, y] = queue.pop()!;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, nz = z + dz;
            if (nx < b.minX || nx >= b.maxX || nz < b.minZ || nz >= b.maxZ) continue;
            for (let ny = y + 1; ny >= ARENA_FLOOR_Y; ny--) {
              if (!standable(nx, ny, nz) || seen.has(key(nx, nz, ny))) continue;
              // The body passes through the neighbour column at the old head height too.
              if (ny <= y && !(air(nx, y + 1, nz) && air(nx, y + 2, nz))) continue;
              seen.add(key(nx, nz, ny));
              queue.push([nx, nz, ny]);
            }
          }
        }
        for (const s of [...map.spawns.red, ...map.spawns.blue, ...map.spawns.ffa]) {
          expect(seen.has(key(Math.floor(s.x), Math.floor(s.z), ARENA_FLOOR_Y))).toBe(true);
        }
        // Roofs, towers and decks the map offers as high ground can be climbed.
        for (const g of map.highGround) {
          expect(seen.has(key(Math.floor(g.x), Math.floor(g.z), map.heightAt(variant, g.x, g.z))), `high ground ${g.x},${g.z}`).toBe(true);
        }
        // A decent share of the arena is walkable (nothing is sealed off by accident).
        expect(seen.size).toBeGreaterThan(0.3 * (b.maxX - b.minX) * (b.maxZ - b.minZ));
      });

      if (map.id !== 'classic') {
        it(`${label}: no spawn sees an enemy spawn and spawns are far apart`, () => {
          const world = { getBlock: (x: number, y: number, z: number) => at(x, y, z) };
          const clear = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
            const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz);
            return traceBlocks(world, ax, ay, az, dx / d, dy / d, dz / d, d) >= d;
          };
          let nearest = Infinity;
          for (const r of map.spawns.red) {
            for (const bl of map.spawns.blue) {
              nearest = Math.min(nearest, Math.hypot(r.x - bl.x, r.z - bl.z));
              for (const [ay, by] of [[1.62, 1.62], [1.62, 0.9], [0.9, 1.62], [0.2, 1.62]]) {
                expect(clear(r.x, r.y + ay, r.z, bl.x, bl.y + by, bl.z), `${r.x},${r.z} sees ${bl.x},${bl.z}`).toBe(false);
              }
            }
          }
          expect(nearest).toBeGreaterThan(24);
          for (let i = 0; i < map.spawns.ffa.length; i++) {
            for (let j = i + 1; j < map.spawns.ffa.length; j++) {
              const a = map.spawns.ffa[i], c = map.spawns.ffa[j];
              expect(Math.hypot(a.x - c.x, a.z - c.z), `ffa ${i} and ${j}`).toBeGreaterThan(8);
            }
          }
        });
      }

      it(`${label} is fenced in: a wall ring, bedrock below and nothing outside`, () => {
        for (let x = b.minX; x < b.maxX; x++) {
          for (const z of [b.minZ, b.maxZ - 1]) {
            for (let y = ARENA_FLOOR_Y + 1; y <= ARENA_FLOOR_Y + map.wallHeight; y++) expect(SOLID[at(x, y, z)]).toBe(1);
            expect(at(x, ARENA_FLOOR_Y + map.wallHeight + 1, z)).toBe(BLOCK.AIR);
          }
        }
        for (let z = b.minZ; z < b.maxZ; z++) {
          for (const x of [b.minX, b.maxX - 1]) {
            for (let y = ARENA_FLOOR_Y + 1; y <= ARENA_FLOOR_Y + map.wallHeight; y++) expect(SOLID[at(x, y, z)]).toBe(1);
          }
        }
        expect(at(0, 0, 0)).toBe(BLOCK.BEDROCK);
        expect(at(b.maxX, ARENA_FLOOR_Y + 1, 0)).toBe(BLOCK.AIR);
        expect(at(0, ARENA_FLOOR_Y + 1, b.minZ - 1)).toBe(BLOCK.AIR);
        // No cover is high enough to climb the wall, and the interior has a solid floor.
        const gen = new ArenaGenerator(variant, map.id);
        let tallest = 0;
        for (let x = b.minX + 1; x < b.maxX - 1; x++) {
          for (let z = b.minZ + 1; z < b.maxZ - 1; z++) {
            tallest = Math.max(tallest, gen.heightAt(x, z));
            expect(SOLID[at(x, ARENA_FLOOR_Y, z)]).toBe(1);
          }
        }
        expect(tallest - ARENA_FLOOR_Y).toBeLessThanOrEqual(map.wallHeight - 3);
      });
    }
  }

  it('the TEAM placeholder is not a real block id', () => {
    expect(BLOCK_DEFS.some((d) => d.id === TEAM)).toBe(false);
    expect(Object.values(BLOCK)).not.toContain(TEAM);
  });

  it('only uses blocks that exist', () => {
    for (const map of MAPS) {
      const b = map.bounds;
      for (let x = b.minX; x < b.maxX; x++) {
        for (let z = b.minZ; z < b.maxZ; z++) {
          for (let y = ARENA_FLOOR_Y; y <= ARENA_FLOOR_Y + map.wallHeight; y++) {
            const id = map.blockAt(0, x, y, z);
            expect(id).toBeLessThan(BLOCK.UNLOADED);
            expect(id === BLOCK.AIR || SOLID[id] === 1 || id === BLOCK.GLASS).toBe(true);
          }
        }
      }
    }
  }, 180000);

  it('maps differ from each other', () => {
    const sig = (id: string) => {
      const m = getMap(id);
      let h = 0;
      for (let x = -20; x < 20; x++) for (let z = -20; z < 20; z++) h = (h * 31 + m.blockAt(0, x, ARENA_FLOOR_Y + 2, z)) | 0;
      return h;
    };
    expect(new Set(MAP_IDS.map(sig)).size).toBe(MAP_IDS.length);
  });

  it('keeps the classic map the default for ARENA_SPAWNS and plain "arena" worlds', () => {
    expect(ARENA_SPAWNS).toBe(getMap('classic').spawns);
    expect(arenaMapOf('arena').id).toBe('classic');
  });

  it('parses and rotates map settings', () => {
    expect(parseMapId('desert')).toBe('desert');
    expect(parseMapId('rotate')).toBeNull();
    expect(parseMapId('../etc')).toBeNull();
    expect(parseMapSetting('rotate')).toBe('rotate');
    expect(parseMapSetting('nope')).toBeNull();
    expect(parseMapSetting(3)).toBeNull();
    const seen = new Set<string>();
    let id = MAP_IDS[0];
    for (let i = 0; i < MAP_IDS.length; i++) { seen.add(id); id = nextMap(id); }
    expect(seen.size).toBe(MAP_IDS.length);
    expect(id).toBe(MAP_IDS[0]);
  });

  it('picks the map through the world type', () => {
    expect(isArenaWorld('terrain')).toBe(false);
    for (const id of MAP_IDS) {
      const type = arenaWorldType(id);
      expect(isArenaWorld(type)).toBe(true);
      expect(arenaMapOf(type).id).toBe(id);
      const a = new Uint8Array(CHUNK_VOLUME), c = new Uint8Array(CHUNK_VOLUME);
      createGenerator(type, 7).generate(-1, -1, a);
      new ArenaGenerator(7, id).generate(-1, -1, c);
      expect(a).toEqual(c);
    }
    // The suburb is smaller than the classic arena: a chunk that is arena in one is empty in the other.
    const w = new Uint8Array(CHUNK_VOLUME), c = new Uint8Array(CHUNK_VOLUME);
    new ArenaGenerator(1, 'suburb').generate(-3, 0, w);
    new ArenaGenerator(1, 'classic').generate(-3, -1, c);
    new ArenaGenerator(1, 'suburb').generate(-3, -2, w);
    expect(w.every((v) => v === 0)).toBe(true);
    expect(c.some((v) => v !== 0)).toBe(true);
  });

  it('generates chunks like the terrain generator and is deterministic', () => {
    const gen = new ArenaGenerator(1234);
    const a = new Uint8Array(CHUNK_VOLUME), b = new Uint8Array(CHUNK_VOLUME);
    const biomes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    gen.generate(-3, -3, a, biomes);
    new ArenaGenerator(1234).generate(-3, -3, b);
    expect(a).toEqual(b);
    // Corner chunk: wall at local (0, 0) and the floor of the interior at (15, 15).
    expect(a[blockIndex(0, ARENA_FLOOR_Y + 1, 0)]).toBe(BLOCK.STONE_BRICKS);
    expect(a[blockIndex(15, ARENA_FLOOR_Y + 1, 15)]).toBe(BLOCK.AIR);
    gen.generate(10, 10, a); // far outside the arena: empty
    expect(a.every((v) => v === 0)).toBe(true);
    expect(gen.heightAt(0.5, 0.5)).toBe(ARENA_FLOOR_Y + 5);
  });

  it('classic: the seed picks the cover variant', () => {
    expect(new Set([0, 1, 2, 3].map((s) => new ArenaGenerator(s).variant)).size).toBe(3);
  });
});

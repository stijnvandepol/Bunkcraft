import { describe, expect, it } from 'vitest';
import {
  ARENA_BOUNDS, ARENA_FLOOR_Y, ARENA_SPAWNS, ARENA_VARIANTS, ARENA_WALL_HEIGHT, ArenaGenerator, arenaBlockAt,
} from '../src/modes/arena';
import { BLOCK, SOLID } from '../src/world/BlockRegistry';
import { CHUNK_SIZE, CHUNK_VOLUME, blockIndex } from '../src/world/constants';

const mirrorX = (x: number) => -1 - x;
const swapTeam = (id: number) => (id === BLOCK.RED_WOOL ? BLOCK.BLUE_WOOL : id === BLOCK.BLUE_WOOL ? BLOCK.RED_WOOL : id);
const solidAt = (v: number, x: number, y: number, z: number) => SOLID[arenaBlockAt(v, Math.floor(x), y, Math.floor(z))] === 1;

describe('arena', () => {
  for (let variant = 0; variant < ARENA_VARIANTS; variant++) {
    it(`variant ${variant} is mirror symmetric (colours swap left/right)`, () => {
      let mismatches = 0;
      for (let y = ARENA_FLOOR_Y - 1; y <= ARENA_FLOOR_Y + ARENA_WALL_HEIGHT + 1; y++) {
        for (let x = ARENA_BOUNDS.minX; x < ARENA_BOUNDS.maxX; x++) {
          for (let z = ARENA_BOUNDS.minZ; z < ARENA_BOUNDS.maxZ; z++) {
            const b = arenaBlockAt(variant, x, y, z);
            if (swapTeam(arenaBlockAt(variant, mirrorX(x), y, z)) !== b) mismatches++;
            if (arenaBlockAt(variant, x, y, -1 - z) !== b) mismatches++;
          }
        }
      }
      expect(mismatches).toBe(0);
    });

    it(`variant ${variant}: spawns stand on the floor with free space above`, () => {
      const all = [...ARENA_SPAWNS.red, ...ARENA_SPAWNS.blue, ...ARENA_SPAWNS.ffa];
      for (const s of all) {
        expect(solidAt(variant, s.x, ARENA_FLOOR_Y, s.z)).toBe(true);
        for (const dy of [1, 2]) {
          for (const [ox, oz] of [[0, 0], [0.4, 0.4], [-0.4, 0.4], [0.4, -0.4], [-0.4, -0.4]]) {
            expect(arenaBlockAt(variant, Math.floor(s.x + ox), ARENA_FLOOR_Y + dy, Math.floor(s.z + oz))).toBe(BLOCK.AIR);
          }
        }
        expect(s.y).toBe(ARENA_FLOOR_Y + 1);
      }
    });

    it(`variant ${variant}: every spawn can reach every other spawn on foot`, () => {
      // Flood fill over columns; a step up may be at most 1 block (a jump), drops are free.
      const gen = new ArenaGenerator(variant);
      const top = (x: number, z: number) => gen.heightAt(x, z);
      const free = (x: number, z: number) => {
        const h = top(x, z);
        return arenaBlockAt(variant, x, h + 1, z) === BLOCK.AIR && arenaBlockAt(variant, x, h + 2, z) === BLOCK.AIR;
      };
      const key = (x: number, z: number) => (x + 100) * 1000 + (z + 100);
      const start = ARENA_SPAWNS.ffa[0];
      const seen = new Set<number>([key(Math.floor(start.x), Math.floor(start.z))]);
      const queue: [number, number][] = [[Math.floor(start.x), Math.floor(start.z)]];
      while (queue.length) {
        const [x, z] = queue.pop()!;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (nx < ARENA_BOUNDS.minX || nx >= ARENA_BOUNDS.maxX || nz < ARENA_BOUNDS.minZ || nz >= ARENA_BOUNDS.maxZ) continue;
          if (seen.has(key(nx, nz)) || !free(nx, nz) || top(nx, nz) - top(x, z) > 1) continue;
          seen.add(key(nx, nz));
          queue.push([nx, nz]);
        }
      }
      for (const s of [...ARENA_SPAWNS.red, ...ARENA_SPAWNS.blue, ...ARENA_SPAWNS.ffa]) {
        expect(seen.has(key(Math.floor(s.x), Math.floor(s.z)))).toBe(true);
      }
      // The centre platform top (3 above the floor) is reachable too.
      expect(seen.has(key(2, 2))).toBe(true);
    });
  }

  it('has enough spawns, facing the centre and mirrored between the teams', () => {
    expect(ARENA_SPAWNS.red.length).toBeGreaterThanOrEqual(6);
    expect(ARENA_SPAWNS.blue.length).toBeGreaterThanOrEqual(6);
    expect(ARENA_SPAWNS.ffa.length).toBeGreaterThanOrEqual(12);
    for (const s of ARENA_SPAWNS.red) expect(s.x).toBeLessThan(0);
    for (const s of ARENA_SPAWNS.blue) expect(s.x).toBeGreaterThan(0);
    for (const s of [...ARENA_SPAWNS.red, ...ARENA_SPAWNS.blue, ...ARENA_SPAWNS.ffa]) {
      // Forward vector of the camera is (-sin yaw, -cos yaw); it must point towards the origin.
      expect(-Math.sin(s.yaw) * -s.x + -Math.cos(s.yaw) * -s.z).toBeGreaterThan(0.99 * Math.hypot(s.x, s.z));
    }
  });

  it('is walled in: wall is 12 high, the floor is bedrock-backed and nothing exists outside', () => {
    expect(arenaBlockAt(0, 47, ARENA_FLOOR_Y + ARENA_WALL_HEIGHT, 0)).toBe(BLOCK.STONE_BRICKS);
    expect(arenaBlockAt(0, 47, ARENA_FLOOR_Y + ARENA_WALL_HEIGHT + 1, 0)).toBe(BLOCK.AIR);
    expect(arenaBlockAt(0, -48, ARENA_FLOOR_Y + 5, -48)).toBe(BLOCK.STONE_BRICKS);
    expect(arenaBlockAt(0, 10, 0, 10)).toBe(BLOCK.BEDROCK);
    expect(arenaBlockAt(0, 48, ARENA_FLOOR_Y + 1, 0)).toBe(BLOCK.AIR);
    // No cover is high enough to climb the wall.
    const gen = new ArenaGenerator(0);
    let tallest = 0;
    for (let x = -47; x < 47; x++) for (let z = -47; z < 47; z++) tallest = Math.max(tallest, gen.heightAt(x, z));
    expect(tallest - ARENA_FLOOR_Y).toBeLessThanOrEqual(6);
  });

  it('generates chunks like the terrain generator and is deterministic', () => {
    const gen = new ArenaGenerator(1234);
    const a = new Uint8Array(CHUNK_VOLUME), b = new Uint8Array(CHUNK_VOLUME);
    const biomes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    gen.generate(-3, -3, a, biomes);
    new ArenaGenerator(1234).generate(-3, -3, b);
    expect(a).toEqual(b);
    // Corner chunk: wall at local (0, 0) and (15, 15) is the floor of the interior.
    expect(a[blockIndex(0, ARENA_FLOOR_Y + 1, 0)]).toBe(BLOCK.STONE_BRICKS);
    expect(a[blockIndex(15, ARENA_FLOOR_Y + 1, 15)]).toBe(BLOCK.AIR);
    gen.generate(10, 10, a); // far outside the arena: empty
    expect(a.every((v) => v === 0)).toBe(true);
    expect(gen.heightAt(0.5, 0.5)).toBe(ARENA_FLOOR_Y + 5);
  });
});

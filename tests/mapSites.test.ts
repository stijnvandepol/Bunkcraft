import { describe, expect, it } from 'vitest';
import { ARENA_FLOOR_Y, MAPS } from '../src/modes/maps';
import { keyOf, openShare, seenFrom, standable, walkDistances } from './helpers/mapAnalysis';

/** Bomb sites (search and destroy): fair, reachable, hidden from the attackers' spawn, closer for the defenders. */
describe('map objectives: bomb sites', () => {
  const withSites = MAPS.filter((m) => m.sites.length > 0);

  it('most maps have two sites and so host search and destroy', () => {
    expect(withSites.length).toBeGreaterThanOrEqual(6);
    for (const m of withSites) expect(m.supports(['sites']), m.id).toBe(true);
    for (const m of MAPS.filter((x) => x.sites.length === 0)) expect(m.supports(['sites'])).toBe(false);
  });

  for (const map of withSites) {
    it(`${map.id}: A and B in the blue half, apart, off the spawns`, () => {
      const [a, b] = map.sites;
      expect([a.name, b.name]).toEqual(['A', 'B']);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(16);
      for (const s of map.sites) {
        expect(s.x).toBeGreaterThan(0);
        expect(s.r).toBe(3);
        expect(map.inBounds(s.x - s.r, s.z - s.r) && map.inBounds(s.x + s.r, s.z + s.r), s.name).toBe(true);
        for (const sp of [...map.spawns.red, ...map.spawns.blue]) expect(Math.hypot(sp.x - s.x, sp.z - s.z), `${s.name} vs spawn`).toBeGreaterThan(s.r + 3);
      }
      if (map.mirrored) expect(b.x === a.x && b.z === -a.z, 'B mirrors A').toBe(true);
    });

    it(`${map.id}: in every variant both sites are open floor, reachable, unseen from the attackers, nearer for the defenders`, () => {
      const walks: number[][] = [[], []];
      for (let v = 0; v < map.variants; v++) {
        const att = walkDistances(map, v, map.spawns.red), def = walkDistances(map, v, map.spawns.blue);
        map.sites.forEach((s, i) => {
          const x = Math.floor(s.x), z = Math.floor(s.z);
          expect(s.y).toBe(ARENA_FLOOR_Y + 1);
          expect(standable(map, v, x, ARENA_FLOOR_Y, z), `${s.name} v${v} standable`).toBe(true);
          expect(openShare(map, v, s.x, s.z, s.y, s.r), `${s.name} v${v} open`).toBeGreaterThanOrEqual(0.7);
          expect(seenFrom(map, v, map.spawns.red, s.x, s.y, s.z), `${s.name} v${v} seen from the attackers`).toBe(false);
          const a = att.get(keyOf(x, z, ARENA_FLOOR_Y)), d = def.get(keyOf(x, z, ARENA_FLOOR_Y));
          expect(a, `${s.name} v${v} attackers reach it`).toBeDefined();
          expect(d, `${s.name} v${v} defenders reach it`).toBeDefined();
          expect(d!, `${s.name} v${v} defenders first`).toBeLessThanOrEqual(a! * 0.75);
          walks[i].push(a!);
        });
      }
      // The attackers' walk to A and to B differs by at most 15% (mirrored maps: equal).
      const wa = Math.max(...walks[0]), wb = Math.max(...walks[1]);
      expect(Math.abs(wa - wb)).toBeLessThanOrEqual(0.15 * Math.max(wa, wb));
    });
  }
});

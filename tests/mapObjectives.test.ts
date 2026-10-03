import { describe, expect, it } from 'vitest';
import { MAPS, getMap, mapFor, nextMap } from '../src/modes/maps';
import { keyOf, openShare, reachable, seenFrom, standable } from './helpers/mapAnalysis';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const startOf = (s: { x: number; z: number }) => [Math.floor(s.x), Math.floor(s.z)] as const;

describe('map objectives: zones', () => {
  const withZones = MAPS.filter((m) => m.zones.length > 0);

  it('at least four maps have zones and support hardpoint/domination', () => {
    expect(withZones.length).toBeGreaterThanOrEqual(4);
    for (const m of withZones) expect(m.supports(['zones'])).toBe(true);
    for (const m of MAPS.filter((x) => x.zones.length === 0)) expect(m.supports(['zones'])).toBe(false);
  });

  for (const map of withZones) {
    const b = map.bounds;
    const zones = map.zones;

    it(`${map.id}: 4-5 zones, in bounds, on open standable ground, off the spawns`, () => {
      expect(zones.length).toBeGreaterThanOrEqual(4);
      expect(zones.length).toBeLessThanOrEqual(5);
      const spawns = [...map.spawns.red, ...map.spawns.blue];
      for (const z of zones) {
        expect(z.r).toBeGreaterThanOrEqual(4);
        expect(z.r).toBeLessThanOrEqual(6);
        expect(Math.abs(z.x) + z.r, `${z.name} fits in x`).toBeLessThanOrEqual(b.maxX - 2);
        expect(Math.abs(z.z) + z.r, `${z.name} fits in z`).toBeLessThanOrEqual(b.maxZ - 2);
        expect(standable(map, 0, Math.floor(z.x), z.y - 1, Math.floor(z.z)), `${z.name} centre is standable`).toBe(true);
        expect(openShare(map, 0, z.x, z.z, z.y, z.r), `${z.name} open share`).toBeGreaterThanOrEqual(0.6);
        for (const s of spawns) expect(Math.hypot(s.x - z.x, s.z - z.z), `${z.name} vs spawn`).toBeGreaterThan(z.r + 3);
      }
    });

    it(`${map.id}: every zone is reachable on foot from both team spawns`, () => {
      for (const team of ['red', 'blue'] as const) {
        const [sx, sz] = startOf(map.spawns[team][0]);
        const reach = reachable(map, 0, sx, sz);
        for (const z of zones) expect(reach.has(keyOf(Math.floor(z.x), Math.floor(z.z), z.y - 1)), `${team} -> ${z.name}`).toBe(true);
      }
    });

    it(`${map.id}: the zone set is symmetric like the map and alternates sides in play order`, () => {
      // Mirrored maps: the twin is mirrored over x; free maps are point symmetric around the centre.
      const twinZ = (z: number) => (map.mirrored ? z : -z);
      for (const z of zones) {
        const twin = zones.find((o) => near(o.x, -z.x) && near(o.z, twinZ(z.z)));
        expect(twin, `${z.name} has a twin`).toBeDefined();
        expect(twin!.r).toBe(z.r);
        expect(twin!.y).toBe(z.y);
      }
      // Order: the first hill is in the middle, then red, blue, red, blue ...
      expect(Math.abs(zones[0].x)).toBeLessThanOrEqual(3);
      for (let i = 1; i < zones.length; i++) {
        expect(Math.sign(zones[i].x)).not.toBe(0);
        if (i > 1) expect(Math.sign(zones[i].x)).toBe(-Math.sign(zones[i - 1].x));
      }
      const dom = map.dominationZones;
      expect(dom.length).toBeGreaterThanOrEqual(3);
      expect(new Set(dom).size).toBe(dom.length);
      for (const i of dom) expect(zones[i]).toBeDefined();
      // Balanced for both teams: the mean x of the points is the middle line.
      expect(dom.reduce((a, i) => a + zones[i].x, 0)).toBeCloseTo(0, 6);
    });

    it(`${map.id}: no spawn of the other team sees a zone centre`, () => {
      for (const z of zones) {
        const enemies = Math.abs(z.x) <= 3 ? [...map.spawns.red, ...map.spawns.blue] : z.x > 0 ? map.spawns.red : map.spawns.blue;
        expect(seenFrom(map, 0, enemies, z.x, z.y, z.z), `${z.name} seen from a spawn`).toBe(false);
      }
    });
  }
});

describe('map objectives: flags', () => {
  const withFlags = MAPS.filter((m) => m.flags.length > 0);

  it('at least four maps have flags and support capture the flag', () => {
    expect(withFlags.length).toBeGreaterThanOrEqual(4);
    for (const m of withFlags) expect(m.supports(['flags'])).toBe(true);
    for (const m of MAPS.filter((x) => x.flags.length === 0)) expect(m.supports(['flags'])).toBe(false);
  });

  for (const map of withFlags) {
    it(`${map.id}: one flag per team, mirrored, standable and reachable`, () => {
      const red = map.flags.find((f) => f.team === 'red')!, blue = map.flags.find((f) => f.team === 'blue')!;
      expect(map.flags).toHaveLength(2);
      expect(red.x).toBeLessThan(0);
      expect(near(red.x, -blue.x)).toBe(true);
      expect(near(red.z, map.mirrored ? blue.z : -blue.z)).toBe(true);
      expect(red.y).toBe(blue.y);
      for (const f of [red, blue]) {
        expect(map.inBounds(f.x, f.z)).toBe(true);
        expect(standable(map, 0, Math.floor(f.x), f.y - 1, Math.floor(f.z))).toBe(true);
        for (const team of ['red', 'blue'] as const) {
          const [sx, sz] = startOf(map.spawns[team][0]);
          expect(reachable(map, 0, sx, sz).has(keyOf(Math.floor(f.x), Math.floor(f.z), f.y - 1)), `${team} spawn -> ${f.team} flag`).toBe(true);
        }
      }
    });

    it(`${map.id}: flags sit behind their own team and away from the enemy spawns`, () => {
      for (const f of map.flags) {
        const own = map.spawns[f.team], enemy = map.spawns[f.team === 'red' ? 'blue' : 'red'];
        const dOwn = Math.min(...own.map((s) => Math.hypot(s.x - f.x, s.z - f.z)));
        const dEnemy = Math.min(...enemy.map((s) => Math.hypot(s.x - f.x, s.z - f.z)));
        expect(dOwn, `${f.team} flag to own spawn`).toBeGreaterThanOrEqual(8);
        expect(dOwn, `${f.team} flag to own spawn`).toBeLessThanOrEqual(25);
        expect(dEnemy, `${f.team} flag to enemy spawn`).toBeGreaterThan(30);
        expect(seenFrom(map, 0, enemy, f.x, f.y, f.z), `${f.team} flag seen from enemy spawn`).toBe(false);
      }
    });

    it(`${map.id}: the flag base is open (a 1.5 block touch radius fits)`, () => {
      for (const f of map.flags) expect(openShare(map, 0, f.x, f.z, f.y, 1.6)).toBeGreaterThanOrEqual(0.7);
    });
  }
});

describe('map objectives: selection', () => {
  it('mapFor and nextMap only give maps with the data a game type needs', () => {
    for (const req of [['zones'], ['flags']] as const) {
      for (const m of MAPS) {
        const next = nextMap(m.id as never, req);
        expect(getMap(next).supports(req)).toBe(true);
        expect(getMap(mapFor(m.id as never, req)).supports(req)).toBe(true);
      }
    }
    expect(mapFor('classic', undefined)).toBe('classic');
  });
});

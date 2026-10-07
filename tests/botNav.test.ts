import { describe, expect, it } from 'vitest';
import { ARENA_FLOOR_Y, MAPS } from '../src/modes/maps';
import { EDGE_JUMP, NavGraph } from '../server/bots/NavGraph';
import { navWorldOf } from '../server/bots/BotWorld';
import { MovementValidator } from '../server/anticheat/Movement';

/** Every map and variant: the graph builds, is cheap, and connects what the modes need. */
describe('bot navigation graph', () => {
  for (const map of MAPS) {
    for (let v = 0; v < map.variants; v++) {
      it(`${map.id} variant ${v}: spawns, zones and flags are connected`, () => {
        const world = navWorldOf(map, (x, y, z) => map.blockAt(v, x, y, z));
        const g = new NavGraph(world, map.spawns.ffa[0]);
        expect(g.size).toBeGreaterThan(200);
        expect(g.buildMs).toBeLessThan(2000);
        const points = [...map.spawns.red, ...map.spawns.blue, ...map.spawns.ffa].map((s) => ({ x: s.x, y: s.y, z: s.z }));
        for (const zn of map.zones) points.push({ x: zn.x, y: zn.y, z: zn.z });
        for (const f of map.flags) points.push({ x: f.x, y: f.y, z: f.z });
        const start = g.nodeAt(points[0].x, points[0].y, points[0].z);
        expect(start).toBeGreaterThanOrEqual(0);
        for (const p of points) {
          const n = g.nodeAt(p.x, p.y, p.z);
          expect(n, `${map.id}/${v} no node at ${p.x},${p.y},${p.z}`).toBeGreaterThanOrEqual(0);
          expect(g.core[n], `${map.id}/${v} ${p.x},${p.y},${p.z} is not in the core area`).toBe(1);
          expect(g.path(start, n, 1e6), `${map.id}/${v} no path to ${p.x},${p.y},${p.z}`).not.toBeNull();
          expect(g.path(n, start, 1e6)).not.toBeNull();
        }
      });
    }
  }

  it('every edge is a move the movement validator accepts', () => {
    const map = MAPS.find((m) => m.id === 'atomic') ?? MAPS[0];
    const get = (x: number, y: number, z: number) => map.blockAt(0, x, y, z);
    const g = new NavGraph(navWorldOf(map, get), map.spawns.ffa[0]);
    const mv = new MovementValidator({ getBlock: get }, { maxSpeed: 100 });
    let checked = 0;
    for (let i = 0; i < g.size; i += 7) {
      for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
        const t = g.edgeTo[e];
        expect(mv.inSolid(g.nx[i], g.ny[i], g.nz[i])).toBe(false);
        expect(mv.inSolid(g.nx[t], g.ny[t], g.nz[t])).toBe(false);
        if (g.edgeFlags[e] & EDGE_JUMP) expect(g.ny[t] - g.ny[i]).toBeLessThanOrEqual(1.0001);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('paths avoid walls and distance fields lead downhill to the goal', () => {
    const map = MAPS[0];
    const get = (x: number, y: number, z: number) => map.blockAt(0, x, y, z);
    const g = new NavGraph(navWorldOf(map, get), map.spawns.ffa[0]);
    const a = g.nodeAt(map.spawns.red[0].x, ARENA_FLOOR_Y + 1, map.spawns.red[0].z);
    const b = g.nodeAt(map.spawns.blue[0].x, ARENA_FLOOR_Y + 1, map.spawns.blue[0].z);
    const route = g.path(a, b)!;
    expect(route[0]).toBe(a);
    expect(route[route.length - 1]).toBe(b);
    const field = g.field('test', () => [b]);
    let at = a, steps = 0;
    while (at !== b && steps++ < 10_000) {
      const nx = g.downhill(field, at);
      expect(nx).toBeGreaterThanOrEqual(0);
      at = nx;
    }
    expect(at).toBe(b);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blocksBullet, rayBox, rayPlayer, spreadDirection, traceBlocks } from '../server/Combat';
import { HITBOX, PLAYER_MAX_HEALTH, PRIMARY_WEAPONS, WEAPONS, damageAt, fireInterval, weaponDef } from '../src/modes/Weapons';
import { BLOCK } from '../src/world/BlockRegistry';

const unit = fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
  .filter(([x, y, z]) => Math.hypot(x, y, z) > 0.05)
  .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l] as const; })
  // Denormal components (1e-322) are not real aim directions and break any floating point reference.
  .filter((v) => v.every((c) => c === 0 || Math.abs(c) > 1e-6));
/** Doubles without denormal noise near zero. */
const clean = (min: number, max: number) => fc.double({ min, max, noNaN: true }).map((v) => (Math.abs(v) < 1e-9 ? 0 : v));

describe('weapon table', () => {
  it('has unique ids, sane stats and one default primary', () => {
    expect(new Set(WEAPONS.map((w) => w.id)).size).toBe(WEAPONS.length);
    expect(PRIMARY_WEAPONS.length).toBeGreaterThanOrEqual(3);
    for (const w of WEAPONS) {
      expect(w.damage, w.id).toBeGreaterThan(0);
      expect(w.headshot, w.id).toBeGreaterThanOrEqual(1);
      expect(w.pellets, w.id).toBeGreaterThanOrEqual(1);
      expect(w.rpm, w.id).toBeGreaterThan(0);
      expect(w.maxRange, w.id).toBeGreaterThanOrEqual(w.falloffEnd);
      expect(w.falloffEnd, w.id).toBeGreaterThanOrEqual(w.range);
      expect(w.minDamage, w.id).toBeGreaterThan(0);
      expect(w.minDamage, w.id).toBeLessThanOrEqual(1);
      expect(w.adsSpread, w.id).toBeLessThanOrEqual(w.spread);
      expect(w.zoom, w.id).toBeGreaterThan(0);
      expect(w.zoom, w.id).toBeLessThanOrEqual(1);
      if (w.slot === 'melee') expect(w.magazine).toBe(0);
      else expect(w.magazine, w.id).toBeGreaterThan(0);
    }
    expect(weaponDef('rifle')?.slot).toBe('primary');
    expect(weaponDef('nope')).toBeUndefined();
  });

  it('every bullet weapon needs at least two body hits to kill, except the one-shot weapons (bolt-action and anti-materiel)', () => {
    const ONE_SHOT = new Set(['sniper', 'antimat']);
    for (const w of WEAPONS) {
      const body = Math.ceil(PLAYER_MAX_HEALTH / (w.damage * w.pellets));
      const head = Math.ceil(PLAYER_MAX_HEALTH / (w.damage * w.headshot * w.pellets));
      if (w.id === 'knife') expect(body, 'one stab kills').toBe(1);
      else if (ONE_SHOT.has(w.id)) expect(body, w.id).toBe(1);
      else if (w.pellets === 1) expect(body, w.id).toBeGreaterThanOrEqual(2);
      expect(head, w.id).toBeLessThanOrEqual(body);
    }
  });

  it('damage falloff table: full inside range, linear to minDamage at falloffEnd, flat beyond', () => {
    for (const w of WEAPONS) {
      const mid = (w.range + w.falloffEnd) / 2;
      expect(damageAt(w, 0), w.id).toBe(w.damage);
      expect(damageAt(w, w.range), w.id).toBe(w.damage);
      expect(damageAt(w, w.falloffEnd), w.id).toBeCloseTo(w.damage * w.minDamage, 6);
      expect(damageAt(w, w.maxRange), w.id).toBeCloseTo(w.damage * w.minDamage, 6);
      if (w.falloffEnd > w.range) expect(damageAt(w, mid), w.id).toBeCloseTo(w.damage * (1 + w.minDamage) / 2, 6);
    }
    const rifle = weaponDef('rifle')!;
    expect(damageAt(rifle, 32)).toBe(20);
    expect(damageAt(rifle, 56)).toBeCloseTo(20 * (1 - 0.5 * 0.45), 6);
    // The suppressor shortens both falloff distances by 20%.
    expect(damageAt(rifle, 32, 0.8)).toBeLessThan(20);
    expect(damageAt(rifle, 25.6, 0.8)).toBe(20);
  });

  it('damage never increases with distance and stays between minDamage and full damage', () => {
    for (const w of WEAPONS) {
      fc.assert(fc.property(fc.double({ min: 0, max: 500, noNaN: true }), fc.double({ min: 0, max: 500, noNaN: true }), (a, b) => {
        const [near, far] = a < b ? [a, b] : [b, a];
        expect(damageAt(w, far)).toBeLessThanOrEqual(damageAt(w, near) + 1e-9);
        expect(damageAt(w, far)).toBeGreaterThanOrEqual(w.damage * w.minDamage - 1e-9);
        expect(damageAt(w, near)).toBeLessThanOrEqual(w.damage + 1e-9);
      }), { numRuns: 200 });
    }
  });

  it('fire interval is 60 / rpm', () => {
    for (const w of WEAPONS) expect(fireInterval(w) * w.rpm).toBeCloseTo(60, 9);
  });
});

describe('traceBlocks (voxel ray march)', () => {
  /** Reference: sample the ray finely and report the first sample inside a stopping block outside the origin voxel. */
  function reference(solid: Set<string>, o: number[], d: readonly number[], max: number, step = 0.002): number {
    const start = o.map(Math.floor).join(',');
    for (let t = 0; t <= max; t += step) {
      const k = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t].map(Math.floor).join(',');
      if (k !== start && solid.has(k)) return t;
    }
    return max;
  }

  it('matches a brute-force sampler on random worlds and rays', () => {
    const cell = fc.tuple(fc.integer({ min: -6, max: 6 }), fc.integer({ min: -6, max: 6 }), fc.integer({ min: -6, max: 6 }));
    const origin = fc.tuple(clean(-3, 3), clean(-3, 3), clean(-3, 3));
    fc.assert(fc.property(fc.array(cell, { maxLength: 60 }), origin, unit, (cells, o0, d) => {
      let o = o0;
      const solid = new Set(cells.map((c) => c.join(',')));
      const world = { getBlock: (x: number, y: number, z: number) => (solid.has(`${x},${y},${z}`) ? BLOCK.STONE : BLOCK.AIR) };
      // A ray through exactly the edge of two voxels is deliberately conservative in the marcher (it checks both
      // neighbours, so bullets cannot slip through a diagonal gap); nudge the origin so the reference sees no ties.
      o = [o[0] + 0.000123, o[1] + 0.000271, o[2] + 0.000419];
      const got = traceBlocks(world, o[0], o[1], o[2], d[0], d[1], d[2], 14);
      let want = reference(solid, o, d, 14);
      // A ray that only grazes a block corner can slip between two samples: look again, finer.
      if (Math.abs(got - want) > 0.02) want = reference(solid, o, d, 14, 0.00005);
      expect(Math.abs(got - want)).toBeLessThan(0.02);
    }), { numRuns: 500 });
  });

  it('is never longer than maxDist, never negative, and stops at unloaded chunks', () => {
    fc.assert(fc.property(fc.double({ min: 0.1, max: 50, noNaN: true }), unit, (max, d) => {
      const t = traceBlocks({ getBlock: () => BLOCK.AIR }, 0.5, 0.5, 0.5, d[0], d[1], d[2], max);
      expect(t).toBe(max);
    }), { numRuns: 100 });
    const hit = traceBlocks({ getBlock: (x) => (x >= 5 ? BLOCK.UNLOADED : BLOCK.AIR) }, 0.5, 0.5, 0.5, 1, 0, 0, 100);
    expect(hit).toBeCloseTo(4.5, 6);
  });

  it('glass stops bullets, plants and water let them through', () => {
    expect(blocksBullet(BLOCK.GLASS)).toBe(true);
    expect(blocksBullet(BLOCK.STONE)).toBe(true);
    expect(blocksBullet(BLOCK.AIR)).toBe(false);
    expect(blocksBullet(BLOCK.WATER)).toBe(false);
    expect(blocksBullet(BLOCK.TALL_GRASS)).toBe(false);
  });
});

describe('rayBox and rayPlayer', () => {
  it('hits a box straight on at the expected distance, misses when aimed away, and returns 0 from inside', () => {
    expect(rayBox(0, 0.5, 0.5, 1, 0, 0, 5, 0, 0, 6, 1, 1)).toBeCloseTo(5, 9);
    expect(rayBox(0, 0.5, 0.5, -1, 0, 0, 5, 0, 0, 6, 1, 1)).toBe(-1);
    expect(rayBox(5.5, 0.5, 0.5, 1, 0, 0, 5, 0, 0, 6, 1, 1)).toBe(0);
    expect(rayBox(0, 5, 0.5, 1, 0, 0, 5, 0, 0, 6, 1, 1)).toBe(-1); // parallel and outside the slab
  });

  it('agrees with point sampling: the entry point lies on the box and a hit means the ray passes through', () => {
    const o = fc.tuple(clean(-8, 8), clean(-8, 8), clean(-8, 8));
    fc.assert(fc.property(o, unit, (p, d) => {
      const box = [2, 1, -1, 4, 3, 1] as const; // min xyz, max xyz
      const t = rayBox(p[0], p[1], p[2], d[0], d[1], d[2], ...box);
      let sampled = false;
      for (let s = 0; s < 40 && !sampled; s += 0.01) {
        const x = p[0] + d[0] * s, y = p[1] + d[1] * s, z = p[2] + d[2] * s;
        sampled = x >= box[0] && x <= box[3] && y >= box[1] && y <= box[4] && z >= box[2] && z <= box[5];
      }
      if (t >= 0) {
        const x = p[0] + d[0] * t, y = p[1] + d[1] * t, z = p[2] + d[2] * t;
        const eps = 1e-6;
        expect(x).toBeGreaterThanOrEqual(box[0] - eps); expect(x).toBeLessThanOrEqual(box[3] + eps);
        expect(y).toBeGreaterThanOrEqual(box[1] - eps); expect(y).toBeLessThanOrEqual(box[4] + eps);
        expect(z).toBeGreaterThanOrEqual(box[2] - eps); expect(z).toBeLessThanOrEqual(box[5] + eps);
      }
      if (sampled) expect(t).toBeGreaterThanOrEqual(0);
    }), { numRuns: 1000 });
  });

  it('rayPlayer reports headshots only in the top 0.4 of the hitbox', () => {
    const feet = { x: 10, y: 64, z: 10 };
    const at = (h: number) => rayPlayer(0, feet.y + h, 10, 1, 0, 0, feet.x, feet.y, feet.z);
    expect(at(0.5)).toMatchObject({ head: false });
    expect(at(HITBOX.height - HITBOX.head - 0.01)).toMatchObject({ head: false });
    expect(at(HITBOX.height - 0.05)).toMatchObject({ head: true });
    expect(at(HITBOX.height + 0.05)).toBeNull();
    expect(at(-0.1)).toBeNull();
    expect(at(0.5)!.t).toBeCloseTo(10 - HITBOX.width / 2, 9);
  });
});

describe('spreadDirection', () => {
  it('returns unit vectors within the cone, for any aim and any random numbers', () => {
    fc.assert(fc.property(unit, fc.double({ min: 0, max: 15, noNaN: true }), fc.double({ min: 0, max: 0.999999, noNaN: true }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (d, deg, r1, r2) => {
      const out: [number, number, number] = [0, 0, 0];
      spreadDirection(d[0], d[1], d[2], deg, r1, r2, out);
      expect(Math.hypot(...out)).toBeCloseTo(1, 6);
      const cos = out[0] * d[0] + out[1] * d[1] + out[2] * d[2];
      expect(Math.acos(Math.min(1, cos)) * 180 / Math.PI).toBeLessThanOrEqual(deg + 1e-4);
    }), { numRuns: 1000 });
  });

  it('with zero spread the aim is unchanged, and it is uniform over the disc (mean offset near 0)', () => {
    const out: [number, number, number] = [0, 0, 0];
    expect(spreadDirection(0, 0, 1, 0, 0.3, 0.3, out)).toEqual([0, 0, 1]);
    let sx = 0, sy = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      // Low-discrepancy sequence instead of Math.random: deterministic.
      const r1 = (i * 0.6180339887) % 1, r2 = (i * 0.7548776662) % 1;
      spreadDirection(0, 0, -1, 10, r1, r2, out);
      sx += out[0]; sy += out[1];
    }
    expect(Math.abs(sx / n)).toBeLessThan(0.01);
    expect(Math.abs(sy / n)).toBeLessThan(0.01);
  });
});

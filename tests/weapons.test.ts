import { describe, expect, it } from 'vitest';
import { FireControl } from '../src/modes/ArcadeLogic';
import { LOADOUT_PRESETS, presetsValid } from '../src/modes/Loadouts';
import { PRIMARY_WEAPONS, SECONDARY_WEAPONS, WEAPONS, fireInterval, weaponDef } from '../src/modes/Weapons';
import type * as THREE from 'three';
import { WEAPON_MODELS, adsCutZ, weaponFrontGeometry, weaponGeometry, weaponRearGeometry } from '../src/rendering/WeaponModels';
import type { ClientMessage, MatchInfo, ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { Match, type MatchHost, SPAWN_PROTECTION, WARMUP_SECONDS } from '../server/Match';

type Fire = Extract<ClientMessage, { t: 'fire' }>;

class StubHost implements MatchHost {
  t = 1000;
  sent: { id: number; msg: ServerMessage }[] = [];
  casts: ServerMessage[] = [];
  blocks = { getBlock: () => BLOCK.AIR };
  now() { return this.t; }
  send(id: number, msg: ServerMessage) { this.sent.push({ id, msg }); }
  broadcast(msg: ServerMessage) { this.casts.push(msg); }
  random() { return 0; }
  ping() { return 0; }
  moveTo() {}
  hits(id: number) { return this.sent.filter((s) => s.id === id && s.msg.t === 'hit').length; }
}

/** Two players in a live ffa match, alice 10 blocks from bob, alice holding `primary`. */
function duel(primary: string) {
  const host = new StubHost();
  const info: MatchInfo = { type: 'ffa', scoreLimit: 50, timeLimitSec: 600 };
  const match = new Match(host, info);
  const advance = (sec: number, step = 0.01) => { for (let t = 0; t < sec - 1e-9; t += step) { host.t += step; match.tick(); } };
  match.join(1, 'alice');
  match.setLoadout(1, primary);
  match.join(2, 'bob');
  match.ready(1);
  match.ready(2);
  advance(WARMUP_SECONDS + 0.2 + SPAWN_PROTECTION + 0.2);
  match.setPosition(1, 0.5, 65, 0.5);
  match.setPosition(2, 0.5, 65, 10.5);
  advance(0.5);
  host.sent = [];
  const shot = (): Fire => ({ t: 'fire', slot: 0, ox: 0.5, oy: 66.62, oz: 0.5, dx: 0, dy: -0.72, dz: 10, ads: true });
  return { host, match, advance, shot };
}

describe('burst rifle', () => {
  it('fires bursts of three at the in-burst rate, then waits for the cycle', () => {
    const { host, match, advance, shot } = duel('burst');
    const w = weaponDef('burst')!;
    const fired: number[] = [];
    const tryShot = () => { if (match.fire(1, shot())) fired.push(host.t); };
    // Hammer the trigger every 10 ms for one second.
    const start = host.t;
    for (let i = 0; i < 100; i++) { tryShot(); advance(0.01); }
    // Shots land in groups of 3 and the group starts are >= burstCycleSec apart.
    expect(fired.length).toBeGreaterThanOrEqual(6);
    for (let i = 3; i < fired.length; i += 3) expect(fired[i] - fired[i - 3]).toBeGreaterThanOrEqual(w.burstCycleSec! - 0.09);
    expect(fired[1] - fired[0]).toBeLessThan(w.burstCycleSec! / 2);
    expect(fired[0] - start).toBeLessThan(0.05);
    // Never more than 3 shots inside one cycle.
    for (let i = 0; i + 3 < fired.length; i++) expect(fired[i + 3] - fired[i]).toBeGreaterThanOrEqual(w.burstCycleSec! - 0.09);
  });

  it('the client trigger matches: one click, three shots, cycle wait', () => {
    const w = weaponDef('burst')!;
    const fc = new FireControl();
    const times: number[] = [];
    for (let t = 0; t < 1; t += 0.005) if (fc.tryBurst(t, fireInterval(w), w.burst!, w.burstCycleSec!, Math.abs(t - 0.5) < 0.0001 || t < 0.0001)) times.push(t);
    expect(times.length).toBe(6);
    expect(times[3] - times[0]).toBeGreaterThanOrEqual(0.38 - 0.01);
  });

  it('a burst cut short by an empty magazine does not finish by itself later', () => {
    const w = weaponDef('burst')!;
    const fc = new FireControl();
    expect(fc.tryBurst(0, fireInterval(w), 3, w.burstCycleSec!, true)).toBe(true); // shot 1 of 3, then the magazine is empty
    fc.cancelBurst(); // what the session does while the magazine is empty
    let shots = 0;
    for (let t = 0.01; t < 3; t += 0.01) if (fc.tryBurst(t, fireInterval(w), 3, w.burstCycleSec!, false)) shots++;
    expect(shots).toBe(0); // no click after the reload: nothing goes off
  });
});

describe('loadout presets and new weapons', () => {
  it('every preset points at a primary and a secondary weapon', () => {
    expect(presetsValid()).toBe(true);
    for (const p of LOADOUT_PRESETS) {
      expect(PRIMARY_WEAPONS).toContain(p.primary);
      expect(SECONDARY_WEAPONS).toContain(p.secondary);
    }
    expect(new Set(LOADOUT_PRESETS.map((p) => p.id)).size).toBe(LOADOUT_PRESETS.length);
  });

  it('the server accepts a secondary in the loadout and applies it at the next spawn', () => {
    const host = new StubHost();
    const match = new Match(host, { type: 'ffa', scoreLimit: 50, timeLimitSec: 600 });
    const p = match.join(1, 'a');
    match.setLoadout(1, 'dmr', 'revolver');
    expect(p.next).toMatchObject({ primary: 'dmr', secondary: 'revolver' });
    match.setLoadout(1, 'knife', 'nonsense'); // invalid: back to the defaults
    expect(p.next).toMatchObject({ primary: 'rifle', secondary: 'pistol' });
  });

  it('every weapon has a model', () => {
    for (const w of WEAPONS) expect(WEAPON_MODELS[w.id], w.id).toBeDefined();
  });
});

describe('first-person weapon geometry', () => {
  const bounds = (g: THREE.BufferGeometry | null) => {
    g!.computeBoundingBox();
    return g!.boundingBox!;
  };

  it('front and rear together are the whole weapon: the viewmodel shrinks the rear away instead of swapping models', () => {
    for (const w of WEAPONS) {
      for (const optic of w.optics) {
        const whole = bounds(weaponGeometry(w.id, optic));
        const front = bounds(weaponFrontGeometry(w.id, optic));
        const rear = weaponRearGeometry(w.id, optic);
        const union = front.clone();
        if (rear) union.union(bounds(rear));
        for (const k of ['x', 'y', 'z'] as const) {
          expect(union.min[k], `${w.id}/${optic} min ${k}`).toBeCloseTo(whole.min[k], 5);
          expect(union.max[k], `${w.id}/${optic} max ${k}`).toBeCloseTo(whole.max[k], 5);
        }
        // Nothing of the rear lies in front of the cut the front is made at.
        if (rear) expect(bounds(rear).min.z, `${w.id}/${optic}`).toBeGreaterThanOrEqual(adsCutZ(w.id, optic) - 1e-6);
      }
    }
  });
});

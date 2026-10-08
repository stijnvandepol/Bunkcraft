import { describe, expect, it } from 'vitest';
import { CameraController } from '../src/core/Camera';
import { AdsBlend, SETTLE_SEC, adsClassOf, adsSensitivity, adsSettle, opticSways } from '../src/modes/AimMath';
import { RECOIL_RECOVER, RECOIL_REST_SEC, RecoilState, SCOPE_SWAY } from '../src/modes/ArcadeLogic';
import { shotSpread } from '../src/modes/Hitscan';
import { shotSpread as serverShotSpread } from '../server/Combat';
import { AIM_CLIMB, HITBOX, WEAPONS, adsTimeFor, fireInterval, opticZoom, opticZoomLevels, weaponDef } from '../src/modes/Weapons';
import { Player } from '../src/player/Player';
import { CLEAR_CENTRE, LENS_RADIUS, STADIA_RANGES, angleToLens, magnification, rangeStadia, scopeReticleSvg } from '../src/ui/ScopeReticles';

/**
 * The aim-feel pass (QA: "aiming feels sluggish"): the look input reaches the view in the frame it is read, the zoom is never
 * smoothed on top of the aim blend, the sights are quick and steady, aimed shots go where the reticle is, recoil is light
 * and comes back fast, and the scopes zoom in levels with a sensitivity that follows.
 */

const w = (id: string) => weaponDef(id)!;
const DEG = Math.PI / 180;

describe('input path: no smoothing, same frame', () => {
  it('the camera shows the view angles of this frame exactly, and the zoom without any easing of its own', () => {
    const cam = new CameraController();
    const p = new Player();
    p.yaw = 0.3; p.pitch = -0.1;
    cam.update(p, 1, 1 / 120);
    // A flick of 40 degrees in one frame is all there in that frame.
    p.yaw += 40 * DEG;
    cam.update(p, 1, 1 / 120);
    expect(cam.camera.rotation.y).toBeCloseTo(p.yaw, 12);
    expect(cam.camera.rotation.x).toBeCloseTo(p.pitch, 12);
    // Zoom: the aim blend eases it; the camera applies it in the same frame (it trailed by ~50 ms before).
    const before = cam.camera.fov;
    cam.zoom = 0.5;
    cam.update(p, 1, 1 / 120);
    expect(cam.camera.fov).toBeCloseTo(before * 0.5, 9);
  });

  it('syncAim shows changes made after the camera update (sway, recoil, zoom) in the same frame', () => {
    const cam = new CameraController();
    const p = new Player();
    cam.update(p, 1, 1 / 60);
    p.pitch += 0.02; p.yaw -= 0.01;
    cam.zoom = 0.25;
    cam.kick = 0;
    cam.syncAim(p);
    expect(cam.camera.rotation.x).toBeCloseTo(p.pitch, 12);
    expect(cam.camera.rotation.y).toBeCloseTo(p.yaw, 12);
    expect(cam.camera.fov).toBeCloseTo(cam.baseFov * 0.25, 6);
  });
});

describe('aiming down the sights', () => {
  it('every weapon is quick to aim: under 0.2 s for rifles and lighter, 0.4 s at most for the heaviest', () => {
    for (const def of WEAPONS) {
      expect(def.adsTime, def.id).toBeLessThanOrEqual(0.4);
      if (adsClassOf(def) !== 'heavy') expect(def.adsTime, def.id).toBeLessThanOrEqual(0.26);
    }
    for (const id of ['rifle', 'smg', 'pistol', 'burst', 'lever', 'shotgun']) expect(w(id).adsTime, id).toBeLessThanOrEqual(0.2);
  });

  it('the blend reaches the sights in exactly the aim time, at 60 and 144 Hz', () => {
    for (const hz of [60, 144]) {
      for (const def of WEAPONS) {
        if (def.zoom >= 1) continue;
        const sec = adsTimeFor(def, def.optics[0], 'none');
        const b = new AdsBlend();
        let t = 0;
        while (b.t < 1 && t < 2) { b.update(1 / hz, true, sec, adsClassOf(def)); t += 1 / hz; }
        expect(t, `${def.id} ${hz}`).toBeLessThanOrEqual(sec + 1 / hz + 1e-9);
        expect(b.eased).toBeCloseTo(1, 6);
      }
    }
  });

  it('the settle is short, small and over by the time a follow-up shot matters', () => {
    expect(adsSettle(-0.01)).toBe(0);
    expect(adsSettle(SETTLE_SEC)).toBe(0);
    let peak = 0;
    for (let t = 0; t < SETTLE_SEC; t += 0.002) peak = Math.max(peak, adsSettle(t));
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(1.5);
    expect(SETTLE_SEC).toBeLessThanOrEqual(0.15);
  });

  it('open sights and the combat scope never sway; the sniper scope sways a little', () => {
    for (const optic of ['iron', 'reddot', 'holo', 'combat'] as const) expect(opticSways(optic)).toBe(false);
    expect(opticSways('scope')).toBe(true);
    expect(SCOPE_SWAY.idle).toBeLessThanOrEqual(0.15);
    expect(SCOPE_SWAY.held).toBeLessThan(SCOPE_SWAY.idle / 5);
  });
});

describe('aimed spread: the shot goes where the reticle is', () => {
  it('client and server use the very same spread', () => {
    expect(serverShotSpread).toBe(shotSpread);
  });

  it('aimed and standing, a rifle-class shot stays inside a player at its own effective range', () => {
    for (const def of WEAPONS) {
      if (def.slot === 'melee' || def.pellets > 1) continue;
      const cone = shotSpread(def, true, false, false) * DEG;
      // The cone's radius at the weapon's full-damage range, against half a player's width.
      const r = Math.tan(cone) * def.range;
      expect(r, def.id).toBeLessThanOrEqual(HITBOX.width / 2 + 1e-9);
    }
  });

  it('aiming tightens the cone to at most a third of the hip cone for single-bullet primaries (the shotgun keeps its pattern)', () => {
    for (const def of WEAPONS) {
      if (def.slot !== 'primary' || def.pellets > 1) continue;
      expect(def.adsSpread, def.id).toBeLessThanOrEqual(def.spread / 2.5);
    }
  });
});

describe('recoil: light, learnable, quick to recover', () => {
  it('the pattern is the same every spray (no randomness) and aiming cuts it', () => {
    const rifle = w('rifle');
    const run = (ads: number) => {
      const r = new RecoilState();
      const out: number[] = [];
      for (let i = 0; i < 12; i++) { const k = r.kick(i * fireInterval(rifle), rifle.recoil, rifle.recoilX, rifle.pattern, ads, AIM_CLIMB, fireInterval(rifle)); out.push(k.pitch, k.yaw); }
      return out;
    };
    expect(run(0)).toEqual(run(0));
    const hip = run(0), aimed = run(1);
    for (let i = 0; i < hip.length; i++) expect(Math.abs(aimed[i])).toBeLessThan(Math.abs(hip[i]) + 1e-12);
    // A 10-round aimed rifle spray climbs under 1.5 degrees.
    let climb = 0;
    for (let i = 0; i < 10; i++) climb += aimed[i * 2];
    expect(climb).toBeLessThan(1.5);
  });

  it('after the trigger rests the aim is back within 0.3 s', () => {
    const lmg = w('lmg');
    const r = new RecoilState();
    let pitch = 0;
    for (let i = 0; i < 10; i++) pitch += r.kick(i * 0.08, lmg.recoil, lmg.recoilX, lmg.pattern, 1, AIM_CLIMB, 0.08).pitch;
    const last = 9 * 0.08, rest = Math.max(RECOIL_REST_SEC, 0.08 * 1.3);
    let back = 0;
    for (let t = last + 1 / 120; t < last + rest + 0.3; t += 1 / 120) back -= r.recover(t, 1 / 120);
    expect(back).toBeGreaterThan(pitch * RECOIL_RECOVER.share * 0.97);
  });
});

describe('scopes', () => {
  it('sniper scopes have two zoom levels, the second deeper; every other optic one', () => {
    for (const def of WEAPONS) {
      for (const optic of def.optics) {
        const levels = opticZoomLevels(def, optic);
        expect(levels[0], `${def.id}/${optic}`).toBe(opticZoom(def, optic));
        if (optic === 'scope') {
          expect(levels.length).toBe(2);
          expect(levels[1]!).toBeLessThan(levels[0]);
          expect(levels[1]!).toBeGreaterThan(0.05);
        } else expect(levels.length).toBe(1);
      }
    }
    // The bolt-action: about 5x and 9x against the 70 degree hip view.
    const [lo, hi] = opticZoomLevels(w('sniper'), 'scope');
    expect(magnification(70, lo)).toBeGreaterThan(4.5);
    expect(magnification(70, hi!)).toBeGreaterThan(8);
  });

  it('look sensitivity follows the zoom level: deeper zoom, slower turn (uniform and monitor scaling)', () => {
    const [lo, hi] = opticZoomLevels(w('sniper'), 'scope');
    for (const scaling of ['uniform', 'monitor'] as const) {
      const a = adsSensitivity(lo, 70, scaling, 100, 1), b = adsSensitivity(hi!, 70, scaling, 100, 1);
      expect(b).toBeLessThan(a);
      expect(a).toBeLessThan(1);
    }
  });

  it('the combat scope range stadia are a player wide at their distance', () => {
    const fov = 70 * opticZoom(w('rifle'), 'combat');
    const marks = rangeStadia(fov);
    expect(marks.map((m) => m.dist)).toEqual([...STADIA_RANGES]);
    const H = 1080, lens = LENS_RADIUS.combat * H;
    for (const m of marks) {
      const px = m.half * 2 * lens;
      const expected = ((HITBOX.width / m.dist) / Math.tan((fov * DEG) / 2)) * (H / 2);
      expect(px).toBeCloseTo(expected, 0);
    }
    // Further marks are narrower and lower.
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i].half).toBeLessThan(marks[i - 1].half);
      expect(marks[i].y).toBeGreaterThan(marks[i - 1].y);
    }
    expect(angleToLens(0, fov, 0.47)).toBe(0);
  });

  it('the sniper reticle keeps a clear centre with a lit aim dot, and every reticle is a self-contained svg', () => {
    const svg = scopeReticleSvg('scope', 15);
    expect(svg.startsWith('<svg')).toBe(true);
    // No fine line crosses the clear middle.
    for (const m of svg.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)) {
      const [x1, y1, x2, y2] = m.slice(1).map(Number);
      const crossesCentre = (x1 === 0 && x2 === 0 && Math.min(y1, y2) < CLEAR_CENTRE && Math.max(y1, y2) > -CLEAR_CENTRE)
        || (y1 === 0 && y2 === 0 && Math.min(x1, x2) < CLEAR_CENTRE && Math.max(x1, x2) > -CLEAR_CENTRE);
      expect(crossesCentre, m[0]).toBe(false);
    }
    expect(svg).toContain('<circle cx="0" cy="0"');
    const combat = scopeReticleSvg('combat', 32);
    expect(combat).toContain('M0 0'); // the chevron's tip is the aim point
    for (const d of STADIA_RANGES) expect(combat).toContain(`>${d}</text>`);
  });
});

import { describe, expect, it } from 'vitest';
import {
  AdsBlend, AdsInput, CROSSHAIR_FADE_END, CROSSHAIR_MAX_GAP, CROSSHAIR_MIN_GAP, CrosshairBloom, adsClassOf, adsEaseIn, adsEaseOut, adsOutSpeed,
  adsSensitivity, adsStep, crosshairAlpha, crosshairGap, opticSways,
} from '../src/modes/AimMath';
import { SPREAD_AIR, SPREAD_MOVING, currentSpread, spreadPixels } from '../src/modes/ArcadeLogic';
import { WEAPONS, adsTimeFor, opticZoom, weaponDef } from '../src/modes/Weapons';

const w = (id: string) => weaponDef(id)!;
const CLASSES = ['light', 'medium', 'heavy'] as const;

describe('aim classes', () => {
  it('sorts the arsenal by aim time: pistols and SMGs light, rifles medium, LMG and snipers heavy', () => {
    expect(adsClassOf(w('pistol'))).toBe('light');
    expect(adsClassOf(w('smg'))).toBe('light');
    expect(adsClassOf(w('rifle'))).toBe('medium');
    expect(adsClassOf(w('dmr'))).toBe('medium');
    expect(adsClassOf(w('lmg'))).toBe('heavy');
    expect(adsClassOf(w('antimat'))).toBe('heavy');
  });
});

describe('ADS curves', () => {
  it('start at 0, end at 1 and never go backwards', () => {
    for (const cls of CLASSES) {
      expect(adsEaseIn(0, cls)).toBe(0);
      expect(adsEaseIn(1, cls)).toBeCloseTo(1, 12);
      expect(adsEaseOut(0, cls)).toBe(0);
      expect(adsEaseOut(1, cls)).toBe(1);
      let a = 0, b = 0;
      for (let i = 1; i <= 100; i++) {
        const x = i / 100;
        expect(adsEaseIn(x, cls)).toBeGreaterThanOrEqual(a);
        expect(adsEaseOut(x, cls)).toBeGreaterThanOrEqual(b);
        a = adsEaseIn(x, cls);
        b = adsEaseOut(x, cls);
      }
    }
  });

  it('rising is front-loaded (the view moves at once), lowering leaves the sights quickly', () => {
    for (const cls of CLASSES) {
      const smooth = (t: number) => t * t * (3 - 2 * t);
      // Ahead of a plain smoothstep early on, and moving from the very first frame.
      expect(adsEaseIn(0.1, cls)).toBeGreaterThan(smooth(0.1));
      expect(adsEaseIn(0.02, cls)).toBeGreaterThan(0.02);
      // Lowering: the eased blend drops faster than the linear one right after letting go.
      expect(adsEaseOut(0.9, cls)).toBeLessThan(0.9);
    }
  });

  it('is snappier the lighter the weapon', () => {
    expect(adsEaseIn(0.2, 'light')).toBeGreaterThan(adsEaseIn(0.2, 'medium'));
    expect(adsEaseIn(0.2, 'medium')).toBeGreaterThan(adsEaseIn(0.2, 'heavy'));
    expect(adsOutSpeed('light')).toBeGreaterThan(adsOutSpeed('heavy'));
    for (const cls of CLASSES) expect(adsOutSpeed(cls)).toBeGreaterThan(1);
  });
});

describe('AdsBlend', () => {
  const step = (b: AdsBlend, want: boolean, seconds: number, cls: 'light' | 'medium' | 'heavy', total: number, dt = 1 / 60) => {
    for (let t = 0; t < total - 1e-9; t += dt) b.update(dt, want, seconds, cls);
  };

  it('is fully aimed after exactly the weapon aim time and back at the hip faster', () => {
    const b = new AdsBlend();
    step(b, true, 0.24, 'medium', 0.24 + 1 / 60);
    expect(b.t).toBe(1);
    expect(b.eased).toBeCloseTo(1, 6);
    // Letting go: back at the hip after adsTime / outSpeed.
    const out = 0.24 / adsOutSpeed('medium');
    step(b, false, 0.24, 'medium', out * 0.5);
    expect(b.t).toBeGreaterThan(0.3);
    step(b, false, 0.24, 'medium', out * 0.6);
    expect(b.t).toBe(0);
    expect(b.eased).toBeCloseTo(0, 6);
  });

  it('follows the real aim time of every weapon (perk and optic included)', () => {
    for (const def of WEAPONS) {
      if (def.zoom >= 1) continue;
      const sec = adsTimeFor(def, def.optics[0], 'none');
      const b = new AdsBlend();
      step(b, true, sec, adsClassOf(def), sec * 0.5);
      // Half the aim time in, give or take one 60 Hz frame (the quickest weapons aim in 0.11 s: a frame is 15% of that).
      expect(b.t).toBeGreaterThan(0.5 - 1 / 60 / sec - 1e-9);
      expect(b.t).toBeLessThan(0.5 + 1 / 60 / sec + 1e-9);
      step(b, true, sec, adsClassOf(def), sec);
      expect(b.t).toBe(1);
    }
  });

  it('reversing half way keeps the picture continuous and moving the right way', () => {
    for (const cls of CLASSES) {
      // Raise for a while, let go, then raise again before the sights are down.
      const b = new AdsBlend();
      step(b, true, 0.3, cls, 0.12);
      const before = b.eased;
      b.update(1 / 60, false, 0.3, cls);
      // The frame of the reversal is no jump (the plain curves would be far apart here).
      expect(Math.abs(b.eased - before)).toBeLessThan(0.15);
      let last = b.eased;
      for (let i = 0; i < 4; i++) {
        b.update(1 / 60, false, 0.3, cls);
        expect(b.eased).toBeLessThanOrEqual(last + 1e-9);
        last = b.eased;
      }
      const turn = b.eased;
      b.update(1 / 60, true, 0.3, cls);
      expect(Math.abs(b.eased - turn)).toBeLessThan(0.15);
      last = b.eased;
      for (let i = 0; i < 10; i++) {
        b.update(1 / 60, true, 0.3, cls);
        expect(b.eased).toBeGreaterThanOrEqual(last - 1e-9);
        last = b.eased;
      }
    }
  });

  it('reset puts the sights down', () => {
    const b = new AdsBlend();
    step(b, true, 0.2, 'light', 0.3);
    b.reset();
    expect(b.t).toBe(0);
    expect(b.eased).toBe(0);
  });
});

describe('hold and toggle aiming', () => {
  it('hold: aims exactly while the button is down', () => {
    const i = new AdsInput();
    expect(i.update('hold', true, true, false)).toBe(true);
    expect(i.update('hold', true, false, false)).toBe(true);
    expect(i.update('hold', false, false, false)).toBe(false);
    // Reloading or dying cancels it even with the button down.
    expect(i.update('hold', true, false, true)).toBe(false);
  });

  it('toggle: one press aims, the next stops, releasing the button changes nothing', () => {
    const i = new AdsInput();
    expect(i.update('toggle', false, false, false)).toBe(false);
    expect(i.update('toggle', true, true, false)).toBe(true);
    expect(i.update('toggle', false, false, false)).toBe(true);
    expect(i.update('toggle', true, true, false)).toBe(false);
    expect(i.update('toggle', false, false, false)).toBe(false);
  });

  it('toggle: reload, switching and death put the sights down; a press while cancelled does not aim', () => {
    const i = new AdsInput();
    i.update('toggle', true, true, false);
    expect(i.update('toggle', false, false, true)).toBe(false);
    expect(i.update('toggle', false, false, false)).toBe(false);
    expect(i.update('toggle', true, true, true)).toBe(false);
    expect(i.update('toggle', false, false, false)).toBe(false);
  });

  it('switching the mode from toggle to hold does not leave the sights stuck up', () => {
    const i = new AdsInput();
    i.update('toggle', true, true, false);
    expect(i.update('hold', false, false, false)).toBe(false);
  });
});

describe('ADS sensitivity', () => {
  it('is untouched at the hip and when nothing is aimed', () => {
    expect(adsSensitivity(0.25, 70, 'uniform', 100, 0)).toBe(1);
    expect(adsSensitivity(0.25, 70, 'monitor', 150, 0)).toBe(1);
    expect(adsSensitivity(1, 70, 'uniform', 100, 1)).toBe(1);
    expect(adsSensitivity(1, 70, 'monitor', 100, 1)).toBeCloseTo(1, 12);
  });

  it('uniform: the field of view ratio, as before', () => {
    expect(adsSensitivity(0.8, 70, 'uniform', 100, 1)).toBeCloseTo(0.8, 12);
    expect(adsSensitivity(0.25, 70, 'uniform', 100, 1)).toBeCloseTo(0.25, 12);
    expect(adsSensitivity(0.25, 110, 'uniform', 100, 1)).toBeCloseTo(0.25, 12);
  });

  it('monitor distance: the ratio of the tangents of the half angles, never faster than uniform', () => {
    for (const fov of [50, 70, 90, 110]) {
      for (const z of [0.9, 0.8, 0.5, 0.25, 0.16]) {
        const k = adsSensitivity(z, fov, 'monitor', 100, 1);
        expect(k).toBeCloseTo(Math.tan((fov * Math.PI / 360) * z) / Math.tan(fov * Math.PI / 360), 12);
        expect(k).toBeLessThanOrEqual(z + 1e-12);
        expect(k).toBeGreaterThan(0);
      }
    }
  });

  it('the setting multiplies on top, in percent', () => {
    expect(adsSensitivity(0.5, 70, 'uniform', 50, 1)).toBeCloseTo(0.25, 12);
    expect(adsSensitivity(0.5, 70, 'uniform', 200, 1)).toBeCloseTo(1, 12);
    expect(adsSensitivity(0.5, 70, 'uniform', 0, 1)).toBe(0);
  });

  it('moves from 1 to the full value with the aim blend, monotonically', () => {
    let last = 1;
    for (let i = 1; i <= 20; i++) {
      const k = adsSensitivity(0.3, 70, 'monitor', 80, i / 20);
      expect(k).toBeLessThanOrEqual(last + 1e-12);
      last = k;
    }
    expect(last).toBeCloseTo(adsSensitivity(0.3, 70, 'monitor', 80, 1), 12);
  });

  it('every optic in the arsenal gives a sane multiplier at every field of view', () => {
    for (const def of WEAPONS) {
      for (const optic of def.optics) {
        for (const fov of [30, 70, 110]) {
          for (const scaling of ['uniform', 'monitor'] as const) {
            const k = adsSensitivity(opticZoom(def, optic), fov, scaling, 100, 1);
            expect(k).toBeGreaterThan(0.05);
            expect(k).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe('crosshair', () => {
  it('the gap is the spread cone on screen, within the limits', () => {
    const gap = crosshairGap(2.2, 70, 1080);
    expect(gap).toBeCloseTo(spreadPixels(2.2, 70, 1080), 9);
    expect(gap).toBeGreaterThan(CROSSHAIR_MIN_GAP);
    expect(crosshairGap(0, 70, 1080)).toBe(CROSSHAIR_MIN_GAP);
    expect(crosshairGap(80, 70, 1080)).toBe(CROSSHAIR_MAX_GAP);
  });

  it('opens with the spread: more spread, more gap; a narrower view (zoom) opens it wider', () => {
    expect(crosshairGap(4, 70, 1080)).toBeGreaterThan(crosshairGap(2, 70, 1080));
    expect(crosshairGap(2, 35, 1080)).toBeGreaterThan(crosshairGap(2, 70, 1080));
    expect(crosshairGap(2, 70, 1440)).toBeGreaterThan(crosshairGap(2, 70, 1080));
  });

  it('fades out while the sights come up and is gone by the end of the fade', () => {
    expect(crosshairAlpha(0)).toBe(1);
    expect(crosshairAlpha(CROSSHAIR_FADE_END)).toBe(0);
    expect(crosshairAlpha(1)).toBe(0);
    expect(crosshairAlpha(CROSSHAIR_FADE_END / 2)).toBeCloseTo(0.5, 12);
  });

  it('bloom opens at once and closes smoothly, never below its target', () => {
    const b = new CrosshairBloom();
    expect(b.update(1 / 60, 30)).toBe(30);
    expect(b.update(1 / 60, 10)).toBeLessThan(30);
    expect(b.gap).toBeGreaterThan(10);
    let g = b.gap;
    for (let i = 0; i < 60; i++) {
      const n = b.update(1 / 60, 10);
      expect(n).toBeLessThanOrEqual(g);
      expect(n).toBeGreaterThanOrEqual(10);
      g = n;
    }
    expect(g).toBeCloseTo(10, 1);
    expect(b.update(1 / 60, 50)).toBe(50);
  });
});

describe('hip fire against aimed accuracy', () => {
  const rifle = w('rifle');

  it('standing still: hip is the hip cone, aimed the aimed cone', () => {
    expect(currentSpread(rifle, 0, false, false)).toBe(rifle.spread);
    expect(currentSpread(rifle, 1, false, false)).toBeCloseTo(rifle.adsSpread, 12);
  });

  it('moving costs hip fire clearly more than aiming, and the air more again', () => {
    const hip = currentSpread(rifle, 0, true, false) / rifle.spread;
    const ads = currentSpread(rifle, 1, true, false) / rifle.adsSpread;
    expect(hip).toBeCloseTo(SPREAD_MOVING.hip, 12);
    expect(ads).toBeCloseTo(SPREAD_MOVING.ads, 12);
    expect(hip).toBeGreaterThan(ads);
    expect(currentSpread(rifle, 0, true, true)).toBeCloseTo(rifle.spread * SPREAD_MOVING.hip * SPREAD_AIR.hip, 12);
    expect(currentSpread(rifle, 1, false, true) / rifle.adsSpread).toBeCloseTo(SPREAD_AIR.ads, 12);
  });

  it('is continuous in the aim blend and never worse aimed than from the hip (every weapon, every stance)', () => {
    for (const def of WEAPONS) {
      if (def.slot === 'melee') continue;
      for (const mv of [false, true]) {
        for (const air of [false, true]) {
          let last = currentSpread(def, 0, mv, air);
          for (let i = 1; i <= 20; i++) {
            const s = currentSpread(def, i / 20, mv, air);
            expect(s).toBeLessThanOrEqual(last + 1e-9);
            last = s;
          }
        }
      }
    }
  });
});

describe('sway', () => {
  it('only the sniper scope sways (iron sights, red dot, holo and the combat scope are steady: aim-feel pass)', () => {
    for (const optic of ['iron', 'reddot', 'holo', 'combat'] as const) expect(opticSways(optic), optic).toBe(false);
    expect(opticSways('scope')).toBe(true);
  });
});

describe('adsStep (the server evaluates the client blend in one step)', () => {
  it('one closed-form step lands where the frame-by-frame blend does, up and down', () => {
    for (const id of ['rifle', 'smg', 'sniper']) {
      const sec = w(id).adsTime, cls = adsClassOf(w(id));
      const b = new AdsBlend();
      for (let i = 0; i < 6; i++) b.update(1 / 60, true, sec, cls);
      expect(b.t).toBeCloseTo(adsStep(0, 6 / 60, true, sec, cls), 9);
      const up = b.t;
      for (let i = 0; i < 4; i++) b.update(1 / 60, false, sec, cls);
      expect(b.t).toBeCloseTo(adsStep(up, 4 / 60, false, sec, cls), 9);
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARENA_DEFAULT_SENSITIVITY, DEFAULT_SETTINGS, SettingsStore, lookRadPerCount, sanitizeSettings } from '../src/core/Settings';
import { KEYBINDS } from '../src/core/Keybinds';

function stubStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set('bunkcraft.settings', initial);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('sanitizeSettings', () => {
  it('returns the defaults for garbage input', () => {
    for (const raw of [null, undefined, 5, 'x', [], [1, 2]]) {
      expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps valid values', () => {
    const s = sanitizeSettings({ renderDistance: 12, fov: 90, graphics: 'fast', shadows: 'ultra', invertMouse: true, clouds: 'off', texturePack: 'procedural' });
    expect(s).toMatchObject({ renderDistance: 12, fov: 90, graphics: 'fast', shadows: 'ultra', invertMouse: true, clouds: 'off', texturePack: 'procedural' });
  });

  it('clamps numbers to the ranges the menu allows and rounds them', () => {
    const s = sanitizeSettings({ renderDistance: 9999, renderScale: -5, fov: 1000, sensitivity: 0, masterVolume: 150, brightness: -1, guiScale: 2.6 });
    expect(s.renderDistance).toBe(24);
    expect(s.renderScale).toBe(50);
    expect(s.fov).toBe(110);
    expect(s.sensitivity).toBe(10);
    expect(s.masterVolume).toBe(100);
    expect(s.brightness).toBe(0);
    expect(s.guiScale).toBe(3);
  });

  it('rejects NaN, Infinity and wrong types', () => {
    const s = sanitizeSettings({ renderDistance: NaN, fov: Infinity, sensitivity: '120', graphics: 'ultra', shadows: 3, viewBobbing: 'yes', texturePack: '' });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores unknown keys', () => {
    const s = sanitizeSettings({ hacked: true, __proto__: { polluted: 1 }, fov: 80 }) as unknown as Record<string, unknown>;
    expect(s.hacked).toBeUndefined();
    expect(s.polluted).toBeUndefined();
    expect(s.fov).toBe(80);
  });

  it('keeps stored keybinds and repairs invalid ones', () => {
    const first = KEYBINDS[0];
    const s = sanitizeSettings({ keybinds: { [first.id]: 'KeyP', nonsense: 'KeyQ' } });
    expect(s.keybinds[first.id]).toBe('KeyP');
    expect((s.keybinds as Record<string, string>).nonsense).toBeUndefined();
    expect(sanitizeSettings({ keybinds: 'oops' }).keybinds).toEqual(DEFAULT_SETTINGS.keybinds);
  });

  it('does not share the keybind map with the defaults', () => {
    const s = sanitizeSettings(null);
    expect(s.keybinds).not.toBe(DEFAULT_SETTINGS.keybinds);
  });
});

describe('sanitizeSettings: accessibility, touch and gamepad', () => {
  it('has safe defaults: accessibility off, touch auto, pad on', () => {
    const s = sanitizeSettings(null);
    expect(s).toMatchObject({
      subtitles: false, reducedMotion: false, reduceFlashes: false, colorBlindSafe: false, highContrast: false,
      textScale: 100, fovEffects: 100, touchControls: 'auto', touchAutoJump: true, padEnabled: true, padLayout: 'default',
    });
  });

  it('keeps valid values', () => {
    const input = {
      subtitles: true, reducedMotion: true, reduceFlashes: true, colorBlindSafe: true, highContrast: true,
      textScale: 150, toggleSprint: true, stickCurve: 80, fovEffects: 20, menuRepeatDelay: 600,
      touchControls: 'on', touchSensitivity: 150, touchLeftHanded: true, padLayout: 'southpaw', padDeadZone: 25, padInvertY: true,
    };
    expect(sanitizeSettings(input)).toMatchObject(input);
  });

  it('clamps the new numeric ranges', () => {
    const s = sanitizeSettings({
      textScale: 50, stickCurve: 500, fovEffects: -4, menuRepeatDelay: 5, touchSensitivity: 9999, touchButtonScale: 0,
      touchOpacity: 3, padSensitivity: 0, padDeadZone: 99,
    });
    expect(s).toMatchObject({
      textScale: 100, stickCurve: 100, fovEffects: 0, menuRepeatDelay: 150, touchSensitivity: 300, touchButtonScale: 60,
      touchOpacity: 20, padSensitivity: 10, padDeadZone: 50,
    });
  });

  it('rejects wrong types and unknown enum values', () => {
    const s = sanitizeSettings({ touchControls: 'maybe', padLayout: 3, subtitles: 'yes', textScale: '150', stickCurve: NaN });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });
});

describe('system accessibility defaults', () => {
  it('turns on reduced motion for a first launch when the OS asks for it', () => {
    stubStorage();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion') }));
    const store = new SettingsStore();
    expect(store.values.reducedMotion).toBe(true);
    expect(store.values.viewBobbing).toBe(false);
    expect(store.values.highContrast).toBe(false);
  });

  it('respects stored values over the OS preference', () => {
    stubStorage(JSON.stringify({ reducedMotion: false }));
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(new SettingsStore().values.reducedMotion).toBe(false);
  });

  it('turns on high contrast for prefers-contrast', () => {
    stubStorage();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-contrast') }));
    expect(new SettingsStore().values.highContrast).toBe(true);
  });
});

describe('SettingsStore', () => {
  it('is fresh without stored data and loads defaults', () => {
    stubStorage();
    const store = new SettingsStore();
    expect(store.fresh).toBe(true);
    expect(store.values).toEqual(DEFAULT_SETTINGS);
  });

  it('loads and sanitizes stored data', () => {
    stubStorage(JSON.stringify({ renderDistance: 500, graphics: 'bogus', fov: 75 }));
    const store = new SettingsStore();
    expect(store.fresh).toBe(false);
    expect(store.values.renderDistance).toBe(24);
    expect(store.values.graphics).toBe('fancy');
    expect(store.values.fov).toBe(75);
  });

  it('survives corrupt JSON', () => {
    stubStorage('{not json');
    const store = new SettingsStore();
    expect(store.fresh).toBe(true);
    expect(store.values).toEqual(DEFAULT_SETTINGS);
  });

  it('persists changes', () => {
    const data = stubStorage();
    const store = new SettingsStore();
    store.set('fov', 100);
    expect(JSON.parse(data.get('bunkcraft.settings')!).fov).toBe(100);
  });
});

describe('arena look sensitivity', () => {
  const deg = (rad: number) => (rad * 180) / Math.PI;

  it('has its own, lower default: ~0.07 degrees per count in the arena, the shared 0.126 elsewhere', () => {
    expect(DEFAULT_SETTINGS.arcadeSensitivity).toBe(ARENA_DEFAULT_SENSITIVITY);
    expect(deg(lookRadPerCount(DEFAULT_SETTINGS, true))).toBeCloseTo(0.07, 2);
    expect(deg(lookRadPerCount(DEFAULT_SETTINGS, false))).toBeCloseTo(0.126, 3);
  });

  it('the arena setting changes only the arena, the shared one only the rest', () => {
    const s = { sensitivity: 80, arcadeSensitivity: 40 };
    expect(lookRadPerCount(s, true)).toBeCloseTo(0.0022 * 0.4, 9);
    expect(lookRadPerCount(s, false)).toBeCloseTo(0.0022 * 0.8, 9);
  });

  it('saved settings from before: a changed shared sensitivity carries over to the arena, an untouched one gets the new default', () => {
    expect(sanitizeSettings({ sensitivity: 140 }).arcadeSensitivity).toBe(140);
    expect(sanitizeSettings({ sensitivity: 30 }).arcadeSensitivity).toBe(30);
    expect(sanitizeSettings({ sensitivity: 100 }).arcadeSensitivity).toBe(ARENA_DEFAULT_SENSITIVITY);
    expect(sanitizeSettings({}).arcadeSensitivity).toBe(ARENA_DEFAULT_SENSITIVITY);
    expect(sanitizeSettings(null).arcadeSensitivity).toBe(ARENA_DEFAULT_SENSITIVITY);
  });

  it('a stored arena value always wins (also when it is the default or when the shared one differs)', () => {
    expect(sanitizeSettings({ sensitivity: 140, arcadeSensitivity: 56 }).arcadeSensitivity).toBe(56);
    expect(sanitizeSettings({ sensitivity: 100, arcadeSensitivity: 90 }).arcadeSensitivity).toBe(90);
    expect(sanitizeSettings({ arcadeSensitivity: 9999 }).arcadeSensitivity).toBe(200);
  });

  it('a migrated value is stored with the next save, so changing the shared slider later does not move the arena', () => {
    const data = stubStorage(JSON.stringify({ sensitivity: 150 }));
    const store = new SettingsStore();
    expect(store.values.arcadeSensitivity).toBe(150);
    store.set('sensitivity', 60);
    expect(JSON.parse(data.get('bunkcraft.settings')!).arcadeSensitivity).toBe(150);
    expect(new SettingsStore().values.arcadeSensitivity).toBe(150);
    vi.unstubAllGlobals();
  });
});

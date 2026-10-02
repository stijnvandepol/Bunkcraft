import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../src/core/Settings';
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

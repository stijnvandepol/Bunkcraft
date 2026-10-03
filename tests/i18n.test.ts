import { afterEach, describe, expect, it } from 'vitest';
import { LANGUAGES, TIP_COUNT, detectLanguage, i18nKeys, modeName, setLanguage, t, tip, translation } from '../src/ui/i18n';

afterEach(() => setLanguage('en'));

describe('i18n key coverage', () => {
  it('has an English and a Dutch string for every key', () => {
    for (const lang of LANGUAGES) {
      for (const key of i18nKeys()) {
        const text = translation(lang, key);
        expect(typeof text, `${lang}:${key}`).toBe('string');
        expect(text.trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the {n} and {name} placeholders identical in both languages', () => {
    const tokens = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const key of i18nKeys()) expect(tokens(translation('nl', key)), key).toBe(tokens(translation('en', key)));
  });

  it('translates something (Dutch differs from English for most keys)', () => {
    const same = i18nKeys().filter((k) => translation('nl', k) === translation('en', k));
    expect(same.length).toBeLessThan(i18nKeys().length / 4);
  });
});

describe('t()', () => {
  it('returns English by default and Dutch after switching', () => {
    expect(t('title.singleplayer')).toBe('Singleplayer');
    setLanguage('nl');
    expect(t('title.singleplayer')).toBe('Alleen spelen');
  });

  it('fills positional arguments', () => {
    expect(t('video.renderDistance', 12)).toBe('Render Distance: 12 chunks');
    setLanguage('nl');
    expect(t('video.renderDistance', 12)).toBe('Zichtafstand: 12 chunks');
  });

  it('falls back to the given text for keys that are not in the table', () => {
    expect(t('other.screen.title', 'Enchanting')).toBe('Enchanting');
    setLanguage('nl');
    expect(t('other.screen.count', '{0} items', 3)).toBe('3 items');
  });

  it('builds tips with the player key names', () => {
    expect(tip(1, { inventory: 'E' })).toContain('E');
    const keys = { inventory: 'E', chat: 'T', command: '/', sprint: 'Ctrl', drop: 'Q' };
    for (let i = 0; i < TIP_COUNT; i++) expect(tip(i, keys)).not.toMatch(/\{[a-z]+\}/);
  });

  it('names game modes per language and detects the browser language', () => {
    expect(modeName('spectator')).toBe('Spectator');
    setLanguage('nl');
    expect(modeName('spectator')).toBe('Toeschouwer');
    expect(detectLanguage({ language: 'nl-NL' })).toBe('nl');
    expect(detectLanguage({ language: 'de' })).toBe('en');
  });
});

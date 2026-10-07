import { afterEach, describe, expect, it } from 'vitest';
import { eventView, flagAction, flagLine, localizeServerText, phaseBanner, teamName, zoneStatus } from '../src/modes/ModeView';
import { MEDAL_TEXT, type AnnounceKind, medalText } from '../src/core/audio/weaponSounds';
import { LOADOUT_PRESETS } from '../src/modes/Loadouts';
import { OPTICS, PERK_IDS, PRIMARY_WEAPONS, SECONDARY_WEAPONS, WEAPONS } from '../src/modes/Weapons';
import { i18nKeys, setLanguage, t, translation } from '../src/ui/i18n';
import type { FlagState, ZoneState } from '../src/net/protocol';

afterEach(() => setLanguage('en'));

const zone = (over: Partial<ZoneState> = {}): ZoneState => ({
  name: 'A', x: 0, y: 65, z: 0, r: 5, active: true, owner: '', progress: 0, progressTeam: '', contested: false, red: 0, blue: 0, ...over,
});
const flag = (over: Partial<FlagState> = {}): FlagState => ({
  team: 'red', status: 'home', x: 0, y: 65, z: 0, carrier: 0, returnIn: 0, hx: 0, hy: 65, hz: 0, ...over,
});

/** Every English text the server builds (server/modes/*.ts) and its Dutch version. */
const SERVER_TEXTS: [string, string][] = [
  ['First to 30', 'Eerst bij 30'],
  ['First to 3 captures', 'Eerst bij 3 vlaggen'],
  ['First to 1 capture', 'Eerst bij 1 vlag'],
  ['First to 200 points', 'Eerst bij 200 punten'],
  ['Hill: West Lane · first to 150', 'Zone: West Lane · eerst bij 150'],
  ['Round 2 · first to 4', 'Ronde 2 · eerst bij 4'],
  ['Round 3', 'Ronde 3'],
  ['12 weapons, the knife is last', '12 wapens, het mes komt als laatste'],
  ['Ann_1 knifed Bob', 'Ann_1 stak Bob neer'],
];

describe('arcade HUD i18n: server texts', () => {
  it('translates every known server pattern to Dutch and keeps zone names', () => {
    setLanguage('nl');
    for (const [en, nl] of SERVER_TEXTS) expect(localizeServerText(en)).toBe(nl);
  });

  it('passes unknown text through unchanged, in both languages', () => {
    for (const lang of ['en', 'nl'] as const) {
      setLanguage(lang);
      for (const s of ['', 'smg', 'Courtyard', 'Something new from a newer server', 'First to win']) expect(localizeServerText(s)).toBe(s);
    }
  });

  it('returns the English text unchanged in English', () => {
    for (const [en] of SERVER_TEXTS) expect(localizeServerText(en)).toBe(en);
  });
});

describe('arcade HUD i18n: mode view in Dutch', () => {
  it('translates team names, zone captions and flag lines', () => {
    setLanguage('nl');
    expect(teamName('red')).toBe('Rood');
    expect(zoneStatus(zone({ owner: 'red' }), 'red', 'hardpoint')).toBe('VERDEDIG');
    expect(zoneStatus(zone({ owner: 'red' }), 'blue', 'hardpoint')).toBe('VAL AAN');
    expect(zoneStatus(zone(), 'blue', 'hardpoint')).toBe('VEROVER');
    expect(zoneStatus(zone({ contested: true }), 'blue', 'domination')).toBe('BETWIST');
    expect(zoneStatus(zone({ progressTeam: 'blue', progress: 0.4 }), 'blue', 'domination')).toBe('VEROVERT');
    expect(zoneStatus(zone({ owner: 'blue', progressTeam: 'red', progress: 0.5 }), 'blue', 'domination')).toBe('VERLIEST');
    const name = (id: number) => (id === 5 ? 'Ann' : '?');
    expect(flagLine(flag(), name)).toBe('Vlag van Rood: thuis');
    expect(flagLine(flag({ status: 'carried', carrier: 5 }), name)).toBe('Vlag van Rood: gepakt door Ann');
    expect(flagLine(flag({ team: 'blue', status: 'dropped', returnIn: 7.2 }), name)).toBe('Vlag van Blauw: ligt op de grond 8');
    expect(flagAction(flag(), 'red', 1)).toBe('VERDEDIG');
    expect(flagAction(flag({ status: 'dropped' }), 'red', 1)).toBe('BRENG TERUG');
    expect(flagAction(flag({ status: 'carried', carrier: 2 }), 'red', 1)).toBe('DOOD DE DRAGER');
    expect(flagAction(flag(), 'blue', 1)).toBe('PAK');
    expect(flagAction(flag({ status: 'carried', carrier: 1 }), 'blue', 1)).toBe('SCOOR');
    expect(flagAction(flag({ status: 'carried', carrier: 2 }), 'blue', 1)).toBe('BESCHERM');
  });

  it('translates event banners, including the server-built ones', () => {
    setLanguage('nl');
    expect(eventView('flag-taken', 'red', 'red', '', 'Bob', false).text).toBe('Bob pakte de vlag van Rood');
    expect(eventView('flag-dropped', 'blue', 'red', '', '', false).text).toBe('De vlag van Blauw is gevallen');
    expect(eventView('flag-returned', 'blue', 'red', 'timeout', '', false).text).toBe('De vlag van Blauw is terug');
    expect(eventView('flag-captured', 'blue', 'blue', '', 'Ann', false).text).toBe('Ann scoorde de vlag voor Blauw');
    expect(eventView('zone-captured', 'red', 'blue', 'Courtyard', '', false).text).toBe('Rood veroverde Courtyard');
    expect(eventView('zone-lost', 'red', 'blue', 'Courtyard', '', false).text).toBe('Rood verloor Courtyard');
    expect(eventView('zone-moved', '', 'blue', 'West Lane', '', false).text).toBe('Nieuwe zone: West Lane');
    expect(eventView('round-start', '', 'blue', 'Round 4', '', false).text).toBe('Ronde 4');
    expect(eventView('round-win', 'red', 'blue', 'Round 4', '', false).text).toBe('Rood wint de ronde');
    expect(eventView('round-win', '', 'blue', 'Round 4', '', false).text).toBe('Ronde gelijkspel');
    expect(eventView('level-up', 'red', 'red', 'smg', 'Jij', true).text).toBe('Level omhoog: SMG');
    expect(eventView('level-down', 'red', 'red', 'Ann knifed Bob', 'Bob', true).text).toBe('Neergestoken: een level omlaag');
    expect(eventView('level-down', 'red', 'red', 'Ann knifed Bob', 'Bob', false).text).toBe('Ann stak Bob neer');
    expect(phaseBanner('intermission', 4.2, 3)).toBe('Ronde 3 begint over 5');
    expect(phaseBanner('countdown', 0, 3)).toBe('Vechten!');
    expect(phaseBanner('countdown', 2, 3)).toBe('2');
  });

  it('keeps today\'s English texts in English', () => {
    expect(eventView('flag-dropped', 'blue', 'red', '', '', false).text).toBe('The Blue flag was dropped');
    expect(eventView('zone-moved', '', 'blue', 'West Lane', '', false).text).toBe('New hill: West Lane');
    expect(eventView('round-start', '', 'blue', 'Round 4', '', false).text).toBe('Round 4');
    expect(eventView('level-down', 'red', 'red', 'Ann knifed Bob', 'Bob', false).text).toBe('Ann knifed Bob');
    expect(eventView('level-up', 'red', 'red', 'smg', 'You', true).text).toBe('Level up: SMG');
  });
});

describe('arcade HUD i18n: tables', () => {
  it('medal texts: English equals MEDAL_TEXT, Dutch comes from the table', () => {
    for (const kind of Object.keys(MEDAL_TEXT) as AnnounceKind[]) expect(medalText(kind)).toBe(MEDAL_TEXT[kind]);
    setLanguage('nl');
    expect(medalText('double')).toBe('DUBBELE KILL');
  });

  it('has a description key for every weapon, optic, perk and preset class, equal to the data in English', () => {
    for (const w of WEAPONS) expect(translation('en', `arc.role.${w.id}` as never), w.id).toBe(w.role);
    for (const id of [...PRIMARY_WEAPONS, ...SECONDARY_WEAPONS]) expect(i18nKeys()).toContain(`arc.role.${id}`);
    for (const o of Object.values(OPTICS)) expect(translation('en', `arc.optic.${o.id}` as never)).toBe(o.desc);
    for (const p of PERK_IDS) expect(i18nKeys()).toContain(`arc.perk.${p}`);
    for (const c of LOADOUT_PRESETS) expect(translation('en', `arc.class.${c.id}` as never)).toBe(c.description);
  });

  it('every arc.* / mode.* sentence has a Dutch translation that differs from English', () => {
    // Labels that stay the same in Dutch gamer speak (product names, loan words, numbers).
    const same = new Set([
      'arc.headshot', 'arc.board.kills', 'arc.board.level', 'arc.cac.title', 'arc.cac.perk', 'arc.class',
      'arc.medal.streak3', 'arc.medal.headshot', 'mode.ladder.level', 'arc.board.tags', 'mode.ev.weaponRotate',
    ]);
    const keys = i18nKeys().filter((k) => k.startsWith('arc.') || k.startsWith('mode.'));
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) {
      if (same.has(k)) continue;
      expect(translation('nl', k), k).not.toBe(translation('en', k));
    }
  });

  it('t() with a template key falls back to the data text for unknown ids', () => {
    expect(t('arc.role.future-gun', 'Some role')).toBe('Some role');
    setLanguage('nl');
    expect(t('arc.role.future-gun', 'Some role')).toBe('Some role');
  });
});

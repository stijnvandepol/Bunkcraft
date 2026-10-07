import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOADOUT_PRESETS } from '../src/modes/Loadouts';
import { WEAPONS } from '../src/modes/Weapons';
import { CAMOS, WEAPON_MAX_LEVEL, camoUnlocked, camosBetween, weaponLevel, weaponXpToNext } from '../src/modes/progression/Camos';
import {
  CHALLENGES_PER_PERIOD, DAILY_POOL, WEEKLY_POOL, activeChallenges, applyChallenges, periodEndsIn, periodKey,
} from '../src/modes/progression/Challenges';
import {
  MAX_LEVEL, MAX_PRESTIGE, PRESTIGE_XP, canPrestige, levelFromXp, parseRank, rankCode, rankTier, totalXpForLevel, xpToNext,
} from '../src/modes/progression/Levels';
import {
  RECENT_MATCHES, applyMatch, favouriteWeapon, newProfile, prestigeUp, rankOf, sanitizeProfile, setEquip,
} from '../src/modes/progression/Profile';
import {
  EQUIPMENT_UNLOCKS, classUnlocked, isUnlocked, lockClass, unlockLevel, unlocksBetween,
} from '../src/modes/progression/Unlocks';
import { MATCH_XP_CAP, type MatchOutcome, type MatchTally, XP, emptyTally, matchXp } from '../src/modes/progression/XpRules';
import { MatchRecorder } from '../server/progression/MatchRecorder';
import { ProfileSigner, loadSecret } from '../server/progression/ProfileTokens';
import { ProfileStore } from '../server/progression/ProfileStore';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bunk-prog-'));
  dirs.push(d);
  return d;
}

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0); // Wednesday 7 October 2026
const OUT: MatchOutcome = { mode: 'tdm', map: 'classic', result: 'win', completed: true };

function tally(over: Partial<MatchTally> = {}): MatchTally {
  return { ...emptyTally(), ...over };
}

describe('XP curve and levels', () => {
  it('starts at level 1, takes about one match for level 2 and gets steeper', () => {
    expect(levelFromXp(0)).toEqual({ level: 1, into: 0, need: xpToNext(1) });
    expect(xpToNext(1)).toBe(800);
    for (let l = 1; l < MAX_LEVEL - 1; l++) expect(xpToNext(l + 1)).toBeGreaterThan(xpToNext(l));
    expect(xpToNext(MAX_LEVEL)).toBe(0);
  });

  it('levelFromXp and totalXpForLevel agree at every boundary', () => {
    for (let l = 1; l <= MAX_LEVEL; l++) {
      const at = totalXpForLevel(l);
      expect(levelFromXp(at).level).toBe(l);
      if (l > 1) expect(levelFromXp(at - 1).level).toBe(l - 1);
    }
    expect(totalXpForLevel(2)).toBe(800);
    expect(PRESTIGE_XP).toBe(totalXpForLevel(MAX_LEVEL));
  });

  it('caps at level 55 and treats junk as zero', () => {
    expect(levelFromXp(PRESTIGE_XP * 3)).toEqual({ level: MAX_LEVEL, into: 0, need: 0 });
    expect(levelFromXp(NaN).level).toBe(1);
    expect(levelFromXp(-50).level).toBe(1);
  });

  it('a full prestige is a long grind but not endless (100-300 matches of ~1200 XP)', () => {
    expect(PRESTIGE_XP / 1200).toBeGreaterThan(100);
    expect(PRESTIGE_XP / 1200).toBeLessThan(300);
  });

  it('rank codes round-trip and reject garbage', () => {
    expect(parseRank(rankCode(12, 0))).toEqual({ level: 12, prestige: 0 });
    expect(parseRank(rankCode(55, 3))).toEqual({ level: 55, prestige: 3 });
    expect(rankCode(99, 99)).toBe(MAX_PRESTIGE * 100 + MAX_LEVEL);
    for (const bad of [0, -1, 1.5, 'x', null, 1100, 156]) expect(parseRank(bad)).toBeNull();
    expect(rankTier(1)).toBe(0);
    expect(rankTier(55)).toBe(10);
  });

  it('prestige only at the cap and only up to the last prestige', () => {
    expect(canPrestige({ level: 54, prestige: 0 })).toBe(false);
    expect(canPrestige({ level: 55, prestige: 0 })).toBe(true);
    expect(canPrestige({ level: 55, prestige: MAX_PRESTIGE })).toBe(false);
    const p = newProfile('abcdefghij', 'alice', NOW);
    expect(prestigeUp(p)).toBe(false);
    p.xp = PRESTIGE_XP;
    expect(prestigeUp(p)).toBe(true);
    expect(rankOf(p)).toEqual({ level: 1, prestige: 1 });
  });
});

describe('unlocks', () => {
  it('a new player has a complete, competitive kit', () => {
    const r1 = { level: 1, prestige: 0 };
    for (const id of ['rifle', 'smg', 'shotgun']) expect(isUnlocked('primary', id, r1)).toBe(true);
    expect(isUnlocked('secondary', 'pistol', r1)).toBe(true);
    expect(isUnlocked('optic', 'reddot', r1)).toBe(true);
    expect(isUnlocked('perk', 'extmag', r1)).toBe(true);
    // Every weapon unlocks within the first 20 levels.
    expect(Math.max(...EQUIPMENT_UNLOCKS.map((u) => u.level))).toBeLessThanOrEqual(20);
  });

  it('every listed unlock refers to a real item, and levels gate them', () => {
    for (const u of EQUIPMENT_UNLOCKS) {
      if (u.kind === 'primary' || u.kind === 'secondary') expect(WEAPONS.some((w) => w.id === u.id && w.slot === u.kind)).toBe(true);
    }
    expect(unlockLevel('primary', 'sniper')).toBe(16);
    expect(isUnlocked('primary', 'sniper', { level: 15, prestige: 0 })).toBe(false);
    expect(isUnlocked('primary', 'sniper', { level: 16, prestige: 0 })).toBe(true);
    // Prestige keeps everything.
    expect(isUnlocked('primary', 'sniper', { level: 1, prestige: 1 })).toBe(true);
  });

  it('lockClass replaces only the locked fields', () => {
    const r1 = { level: 1, prestige: 0 };
    expect(lockClass({ primary: 'sniper', optic: 'scope', secondary: 'revolver', perk: 'suppressor' }, r1))
      .toEqual({ primary: 'rifle', optic: 'iron', secondary: 'pistol', perk: 'none' });
    expect(lockClass({ primary: 'smg', optic: 'holo', secondary: 'pistol', perk: 'extmag' }, r1))
      .toEqual({ primary: 'smg', optic: 'iron', secondary: 'pistol', perk: 'extmag' });
    expect(lockClass({ primary: 'smg', optic: 'holo', secondary: 'mpistol', perk: 'quickdraw' }, { level: 4, prestige: 0 }))
      .toEqual({ primary: 'smg', optic: 'holo', secondary: 'mpistol', perk: 'quickdraw' });
    // A scope-only weapon that is unlocked keeps its scope even before the scope unlock (it has no other sights).
    expect(lockClass({ primary: 'sniper', optic: 'scope', secondary: 'pistol', perk: 'none' }, { level: 16, prestige: 0 }).optic).toBe('scope');
    expect(lockClass('garbage', r1)).toEqual({ primary: 'rifle', optic: 'iron', secondary: 'pistol', perk: 'none' });
  });

  it('presets unlock along the way; the first one early', () => {
    expect(classUnlocked(LOADOUT_PRESETS[0], { level: 2, prestige: 0 })).toBe(true);
    for (const p of LOADOUT_PRESETS) expect(classUnlocked(p, { level: 20, prestige: 0 })).toBe(true);
    expect(classUnlocked(LOADOUT_PRESETS.find((p) => p.id === 'sniper')!, { level: 1, prestige: 0 })).toBe(false);
  });

  it('unlocksBetween lists what a level-up brings', () => {
    const got = unlocksBetween(4, 6, 0).map((u) => `${u.kind}:${u.id}`);
    expect(got).toEqual(['primary:dmr', 'perk:ninja']);
    expect(unlocksBetween(9, 10, 0).map((u) => u.id)).toEqual(expect.arrayContaining(['revolver', 'soldier']));
    expect(unlocksBetween(5, 5, 0)).toEqual([]);
  });
});

describe('match XP', () => {
  it('adds up kills, headshots, assists, objectives, completion and the win', () => {
    const t = tally({ kills: 10, killXp: 1000, headshots: 3, assists: 2, flagCaptures: 1, hillSeconds: 12.7 });
    const { lines, total } = matchXp(t, OUT);
    expect(total).toBe(1000 + 3 * XP.headshot + 2 * XP.assist + XP.flagCapture + 12 * XP.hillSecond + XP.completion + XP.win);
    expect(lines.map((l) => l.key)).toEqual(['kills', 'headshots', 'assists', 'captures', 'hill', 'completion', 'win']);
  });

  it('no completion or win bonus when the player left early; a draw pays less than a win', () => {
    expect(matchXp(tally(), { ...OUT, completed: false }).total).toBe(0);
    expect(matchXp(tally(), { ...OUT, result: 'draw' }).total).toBe(XP.completion + XP.draw);
    expect(matchXp(tally(), { ...OUT, result: 'loss' }).total).toBe(XP.completion);
  });

  it('caps one match', () => {
    const { total, lines } = matchXp(tally({ kills: 500, killXp: 50_000 }), OUT);
    expect(total).toBe(MATCH_XP_CAP);
    expect(lines.at(-1)!.key).toBe('cap');
  });
});

describe('weapon XP and camos', () => {
  it('weapon levels follow the curve and camos unlock in order', () => {
    expect(weaponLevel(0).level).toBe(1);
    expect(weaponLevel(weaponXpToNext(1)).level).toBe(2);
    expect(weaponLevel(1e9).level).toBe(WEAPON_MAX_LEVEL);
    for (let i = 1; i < CAMOS.length; i++) expect(CAMOS[i].level).toBeGreaterThan(CAMOS[i - 1].level);
    expect(camoUnlocked('woodland', 0)).toBe(false);
    expect(camoUnlocked('woodland', weaponXpToNext(1))).toBe(true);
    expect(camoUnlocked('bogus', 1e9)).toBe(false);
    expect(camosBetween(0, 1e9).map((c) => c.id)).toEqual(CAMOS.slice(1).map((c) => c.id));
  });
});

describe('challenges', () => {
  it('three distinct challenges per period, the same for everyone, at most one objective one', () => {
    for (let day = 0; day < 60; day++) {
      const now = NOW + day * 86_400_000;
      for (const period of ['daily', 'weekly'] as const) {
        const a = activeChallenges(period, periodKey(period, now));
        expect(a).toHaveLength(CHALLENGES_PER_PERIOD);
        expect(new Set(a.map((c) => c.id)).size).toBe(CHALLENGES_PER_PERIOD);
        expect(activeChallenges(period, periodKey(period, now))).toEqual(a);
        expect(a.filter((c) => ['captures', 'zones', 'hill', 'returns'].includes(c.stat)).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('period keys change at UTC midnight and on Mondays', () => {
    expect(periodKey('daily', NOW)).toBe('2026-10-07');
    const monday = Date.UTC(2026, 9, 12);
    expect(periodKey('weekly', monday - 1)).not.toBe(periodKey('weekly', monday));
    expect(periodKey('weekly', monday)).toBe(periodKey('weekly', monday + 6 * 86_400_000));
    expect(periodEndsIn('daily', NOW)).toBe(12 * 3_600_000);
    expect(periodEndsIn('weekly', NOW)).toBe(monday - NOW);
  });

  it('progress counts up, completes once and starts over in the next period', () => {
    const key = periodKey('daily', NOW);
    const active = activeChallenges('daily', key);
    const big = tally({ kills: 999, headshots: 999, assists: 999, knifeKills: 999, flagCaptures: 9, zoneCaptures: 99, hillSeconds: 999 });
    for (const w of ['rifle', 'smg', 'shotgun', 'lmg', 'dmr', 'sniper', 'pistol']) big.weapons[w] = { kills: 99, headshots: 0, assists: 0, shots: 0, hits: 0 };
    let r = applyChallenges('daily', undefined, NOW, big, OUT);
    // wins/matches need several matches; everything else completes in one.
    const single = active.filter((c) => c.stat !== 'wins' && c.stat !== 'matches');
    expect(r.completed.map((c) => c.id)).toEqual(expect.arrayContaining(single.map((c) => c.id)));
    r.state.progress.forEach((p, i) => expect(p).toBeLessThanOrEqual(active[i].target));
    for (let i = 0; i < 5; i++) r = applyChallenges('daily', r.state, NOW, big, OUT);
    expect(r.completed).toEqual([]); // all done, nothing completes twice
    const tomorrow = applyChallenges('daily', r.state, NOW + 86_400_000, tally(), OUT);
    expect(tomorrow.state.key).not.toBe(key);
  });

  it('every pool entry has a sensible target and reward', () => {
    for (const c of [...DAILY_POOL, ...WEEKLY_POOL]) {
      expect(c.target).toBeGreaterThan(0);
      expect(c.xp).toBeGreaterThan(0);
      if (c.stat === 'class') expect(c.weaponClass).toBeTruthy();
    }
  });
});

describe('profiles', () => {
  it('applyMatch grants XP, statistics, weapon XP, camos and a recent match', () => {
    const p = newProfile('abcdefghij', 'alice', NOW);
    const t = tally({ kills: 12, killXp: 1200, headshots: 4, deaths: 5, shots: 100, hits: 40, bestStreak: 6, seconds: 300 });
    t.weapons.smg = { kills: 12, headshots: 4, assists: 0, shots: 100, hits: 40 };
    const r = applyMatch(p, t, OUT, NOW);
    expect(r.xp).toBeGreaterThan(1200);
    expect(r.before.level).toBe(1);
    expect(r.after.level).toBeGreaterThan(1);
    expect(r.unlocks.length).toBeGreaterThan(0);
    expect(p.stats).toMatchObject({ kills: 12, deaths: 5, headshots: 4, wins: 1, matches: 1, shots: 100, hits: 40, bestStreak: 6 });
    expect(p.modes.tdm).toEqual({ matches: 1, wins: 1, kills: 12, deaths: 5 });
    expect(p.weapons.smg.kills).toBe(12);
    expect(r.camos.map((c) => c.camo)).toContain('woodland');
    expect(p.recent[0]).toMatchObject({ mode: 'tdm', result: 'win', kills: 12, xp: r.xp });
    expect(favouriteWeapon(p)).toBe('smg');
  });

  it('keeps only the last matches and never grows past the cap', () => {
    const p = newProfile('abcdefghij', 'alice', NOW);
    for (let i = 0; i < 40; i++) applyMatch(p, tally({ kills: 1, killXp: 100 }), OUT, NOW + i);
    expect(p.recent).toHaveLength(RECENT_MATCHES);
    expect(JSON.stringify(p).length).toBeLessThan(8000);
  });

  it('sanitizeProfile drops unknown keys, clamps numbers and rejects files without an id', () => {
    expect(sanitizeProfile(null)).toBeNull();
    expect(sanitizeProfile({ id: '../../etc' })).toBeNull();
    const evil = {
      id: 'abcdefghij', name: '<script>', xp: 1e30, prestige: 99, admin: true, stats: { kills: -5, deaths: 'x', wins: 3.7 },
      weapons: { rifle: { xp: 5, kills: 1 }, nuke: { xp: 1e9 }, __proto__: { kills: 1 } },
      modes: { tdm: { wins: 2 }, minecraft: { wins: 9 }, bogus: { wins: 1 } },
      recent: Array.from({ length: 500 }, () => ({ mode: 'tdm', map: 'classic', result: 'win', kills: 1 })),
      equip: { title: 'god', card: 'gold', camos: { rifle: 'diamond', nuke: 'gold' } },
    };
    const p = sanitizeProfile(evil)!;
    expect(p.name).toBe('Player');
    expect(p.xp).toBe(PRESTIGE_XP);
    expect(p.prestige).toBe(MAX_PRESTIGE);
    expect((p as unknown as Record<string, unknown>).admin).toBeUndefined();
    expect(p.stats.kills).toBe(0);
    expect(p.stats.wins).toBe(3);
    expect(Object.keys(p.weapons)).toEqual(['rifle']);
    expect(Object.keys(p.modes)).toEqual(['tdm']);
    expect(p.recent).toHaveLength(RECENT_MATCHES);
    expect(p.equip.title).toBe('recruit');
    expect(p.equip.card).toBe('gold'); // a known card; whether it is unlocked is checked when equipping
    expect(p.equip.camos).toEqual({ rifle: 'diamond' });
  });

  it('setEquip only takes what is unlocked', () => {
    const p = newProfile('abcdefghij', 'alice', NOW);
    expect(setEquip(p, { title: 'legend' })).toBe(false);
    expect(setEquip(p, { card: 'grass' })).toBe(false);
    expect(setEquip(p, { camos: { rifle: 'gold' } })).toBe(false);
    p.xp = totalXpForLevel(10);
    p.weapons.rifle = { xp: 1e6, kills: 0, headshots: 0, shots: 0, hits: 0 };
    expect(setEquip(p, { title: 'soldier', card: 'grass', camos: { rifle: 'gold' } })).toBe(true);
    expect(p.equip).toEqual({ title: 'soldier', card: 'grass', camos: { rifle: 'gold' } });
    expect(setEquip(p, { camos: { rifle: 'none' } })).toBe(true);
    expect(p.equip.camos).toEqual({});
  });
});

describe('profile tokens', () => {
  const signer = new ProfileSigner('0123456789abcdef-test-secret');

  it('issues tokens that verify to their id', () => {
    const { id, token } = signer.issue();
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(signer.verify(token)).toBe(id);
    expect(signer.issue().id).not.toBe(id);
  });

  it('rejects tampered, foreign and malformed tokens', () => {
    const { id, token } = signer.issue();
    const [v, , sig] = token.split('.');
    const other = signer.issue();
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(signer.verify(`${v}.${other.id}.${sig}`)).toBeNull(); // someone else's id with my signature
    expect(signer.verify(`${v}.${id}.${flip(sig, 5)}`)).toBeNull();
    expect(signer.verify(`${v}.${flip(id, 3)}.${sig}`)).toBeNull();
    expect(signer.verify(`v2.${id}.${sig}`)).toBeNull();
    expect(new ProfileSigner('another-secret-0123456789').verify(token)).toBeNull();
    for (const bad of [undefined, null, 42, '', 'v1..', `${token}x`, token.repeat(3), { toString: () => token }]) {
      expect(signer.verify(bad)).toBeNull();
    }
  });

  it('keeps the secret on disk (owner-only) and reuses it', () => {
    const file = join(tmp(), 'profiles', 'secret.key');
    const a = loadSecret(file);
    expect(loadSecret(file).equals(a)).toBe(true);
    expect(loadSecret(file, 'from-the-environment-123').toString()).toBe('from-the-environment-123');
  });
});

describe('profile store', () => {
  it('creates, persists, reloads and limits profiles', () => {
    const dir = tmp();
    const store = new ProfileStore({ dir, maxProfiles: 2 });
    const a = store.create('aaaaaaaaaaaaaaaaaaaaaa', 'alice')!;
    expect(store.create('bbbbbbbbbbbbbbbbbbbbbb', 'bobby')).not.toBeNull();
    expect(store.create('cccccccccccccccccccccc', 'carol')).toBeNull(); // full
    a.xp = 1234;
    store.touch(a.id);
    store.flush();
    const again = new ProfileStore({ dir, maxProfiles: 2 });
    expect(again.count).toBe(2);
    expect(again.get(a.id)!.xp).toBe(1234);
    expect(again.get('zzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });

  it('a damaged file is not loaded, a hand-edited one is sanitised', () => {
    const dir = tmp();
    const store = new ProfileStore({ dir, maxProfiles: 10 });
    store.create('dddddddddddddddddddddd', 'dave');
    store.create('eeeeeeeeeeeeeeeeeeeeee', 'erin');
    writeFileSync(join(dir, 'dd', 'dddddddddddddddddddddd.json'), '{broken');
    const raw = JSON.parse(readFileSync(join(dir, 'ee', 'eeeeeeeeeeeeeeeeeeeeee.json'), 'utf8'));
    raw.xp = -9; raw.extra = 'x'.repeat(100_000);
    writeFileSync(join(dir, 'ee', 'eeeeeeeeeeeeeeeeeeeeee.json'), JSON.stringify(raw));
    const again = new ProfileStore({ dir, maxProfiles: 10 });
    expect(again.get('dddddddddddddddddddddd')).toBeNull();
    const e = again.get('eeeeeeeeeeeeeeeeeeeeee')!;
    expect(e.xp).toBe(0);
    expect(JSON.stringify(e).length).toBeLessThan(4000);
  });
});

describe('match recorder', () => {
  it('counts kills, assists, headshots and accuracy only while live', () => {
    const r = new MatchRecorder();
    r.shot(1, 'rifle', true); // before the start: ignored
    r.start([1, 2, 3], 0);
    r.shot(1, 'rifle', true);
    r.shot(1, 'rifle', false);
    r.damage(3, 2, 'smg', 1);
    r.damage(1, 2, 'rifle', 2);
    r.kill(1, 2, 'rifle', true, 3);
    const a = r.take(1, 100)!;
    expect(a.tally).toMatchObject({ kills: 1, headshots: 1, shots: 2, hits: 1, killXp: XP.kill });
    expect(a.tally.weapons.rifle).toMatchObject({ kills: 1, headshots: 1, shots: 2, hits: 1 });
    expect(a.completed).toBe(true);
    const c = r.take(3, 100)!;
    expect(c.tally.assists).toBe(1);
    expect(c.tally.weapons.smg.assists).toBe(1);
    expect(r.take(2, 100)!.tally.deaths).toBe(1);
    expect(r.take(1, 100)).toBeNull(); // handed over once
  });

  it('no assist for old damage, and farming one victim pays less', () => {
    const r = new MatchRecorder();
    r.start([1, 2, 3], 0);
    r.damage(3, 2, 'smg', 0);
    for (let i = 0; i < 10; i++) r.kill(1, 2, 'rifle', false, 30 + i);
    expect(r.take(3, 60)!.tally.assists).toBe(0);
    const t = r.take(1, 60)!.tally;
    expect(t.killXp).toBe(6 * XP.kill + 4 * XP.killRepeat);
    expect(t.bestStreak).toBe(10);
  });

  it('a late joiner is not complete without enough time in the match', () => {
    const r = new MatchRecorder();
    r.start([1], 0);
    r.join(2, 100);
    expect(r.take(2, 120)!.completed).toBe(false);
    r.stop();
    r.join(4, 130);
    expect(r.take(4, 200)).toBeNull();
  });
});

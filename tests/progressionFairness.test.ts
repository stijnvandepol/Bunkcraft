import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupAll, backupProfiles, listProfileBackups } from '../server/Backup';
import { SPAWN_PROTECTION, WARMUP_SECONDS } from '../server/Match';
import { MatchProgress } from '../server/progression/MatchProgress';
import { MatchRecorder } from '../server/progression/MatchRecorder';
import { ProfileService } from '../server/progression/ProfileService';
import {
  CHALLENGES_PER_PERIOD, DAILY_POOL, WEEKLY_POOL, activeChallenges, applyChallenges, challengeAvailable, classUnlockLevel, periodKey, resolveChallenges,
} from '../src/modes/progression/Challenges';
import { type ProgressReport, applyMatch, newProfile } from '../src/modes/progression/Profile';
import { levelFromXp } from '../src/modes/progression/Levels';
import {
  BOT_COUNT_CAP, BOT_XP_CAP, BOT_XP_FACTOR, LOBBY_BOT_FACTOR, type MatchOutcome, type MatchTally, XP, countedTally, emptyTally, matchXp,
} from '../src/modes/progression/XpRules';
import { place, setup, shootDead } from './helpers/matchHost';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bunk-fair-'));
  dirs.push(d);
  return d;
}

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86_400_000;
const WIN: MatchOutcome = { mode: 'tdm', map: 'classic', result: 'win', completed: true };
const isBot = (id: number) => id >= 100;

describe('bot kills are not an XP farm', () => {
  it('kills, headshots and assists on bots pay a quarter on their own "vs bots" line', () => {
    const r = new MatchRecorder(isBot);
    r.start([1, 2, 100, 101], 0);
    r.damage(2, 101, 'rifle', 1);
    r.kill(1, 100, 'rifle', true, 2);
    r.kill(1, 101, 'rifle', false, 3); // 2 assisted on a bot
    r.kill(1, 2, 'rifle', false, 4); // a human victim pays in full
    const { tally } = r.take(1, 60)!;
    expect(tally).toMatchObject({ kills: 3, botKills: 2, botHeadshots: 1, killXp: XP.kill });
    expect(r.take(2, 60)!.tally.botAssists).toBe(1);

    const { lines, total } = matchXp(tally, { ...WIN, completed: false });
    expect(lines.find((l) => l.key === 'kills')).toMatchObject({ xp: XP.kill, count: 1 });
    const bots = lines.find((l) => l.key === 'bots')!;
    expect(bots).toMatchObject({ mult: BOT_XP_FACTOR, count: 2, xp: Math.round((2 * XP.kill + XP.headshot) * BOT_XP_FACTOR) });
    expect(total).toBe(XP.kill + bots.xp);
  });

  it('bot XP is capped per match', () => {
    const t: MatchTally = { ...emptyTally(), kills: 200, botKills: 200, headshots: 100, botHeadshots: 100 };
    const bots = matchXp(t, { ...WIN, completed: false }).lines.find((l) => l.key === 'bots')!;
    expect(bots.xp).toBe(BOT_XP_CAP);
    expect(bots.capped).toBe(true);
  });

  it('only the first few bot kills count for challenges and weapon XP; kills on humans always do', () => {
    const t = emptyTally();
    t.kills = 60; t.botKills = 50; t.headshots = 20; t.botHeadshots = 20;
    t.weapons.rifle = { kills: 40, headshots: 20, assists: 0, shots: 0, hits: 0, botKills: 40, botHeadshots: 20 };
    t.weapons.smg = { kills: 20, headshots: 0, assists: 0, shots: 0, hits: 0, botKills: 10 };
    const c = countedTally(t);
    expect(c.kills).toBe(10 + BOT_COUNT_CAP);
    expect(c.weapons.rifle.kills).toBe(BOT_COUNT_CAP);
    expect(c.weapons.smg.kills).toBe(10); // the budget went to the rifle; the 10 human kills stay
    expect(c.headshots).toBeLessThanOrEqual(BOT_COUNT_CAP);

    // Challenge progress and weapon XP use the capped view; statistics keep the real numbers.
    let day = 0;
    while (!activeChallenges('daily', periodKey('daily', NOW + day * DAY)).some((x) => x.stat === 'kills' || x.id === 'd_ar')) day++;
    const when = NOW + day * DAY;
    const defs = activeChallenges('daily', periodKey('daily', when));
    const farm = emptyTally();
    farm.kills = 80; farm.botKills = 80; farm.weapons.rifle = { kills: 80, headshots: 0, assists: 0, shots: 0, hits: 0, botKills: 80 };
    const res = applyChallenges('daily', undefined, when, farm, { ...WIN, completed: false });
    defs.forEach((d, i) => { if (d.stat === 'kills' || d.stat === 'class') expect(res.state.progress[i]).toBeLessThanOrEqual(BOT_COUNT_CAP); });

    const p = newProfile('abcdefgh12', 'tester', NOW);
    applyMatch(p, farm, { ...WIN, completed: false }, NOW);
    expect(p.weapons.rifle.kills).toBe(BOT_COUNT_CAP);
    expect(p.weapons.rifle.xp).toBe(BOT_COUNT_CAP * 100);
    expect(p.stats.kills).toBe(80);
  });

  it('a lobby without a second human pays objectives, completion and the win at a quarter and shows it', () => {
    const t = { ...emptyTally(), flagCaptures: 1 };
    const full = matchXp(t, WIN);
    const solo = matchXp(t, { ...WIN, humans: 1 });
    const two = matchXp(t, { ...WIN, humans: 2 });
    expect(two.total).toBe(full.total);
    expect(solo.total).toBe(Math.round(XP.flagCapture * LOBBY_BOT_FACTOR) + Math.round(XP.completion * LOBBY_BOT_FACTOR) + Math.round(XP.win * LOBBY_BOT_FACTOR));
    for (const k of ['captures', 'completion', 'win']) expect(solo.lines.find((l) => l.key === k)!.mult).toBe(LOBBY_BOT_FACTOR);
    expect(full.lines.every((l) => l.mult === undefined)).toBe(true);
  });

  it('10 minutes against 11 easy bots stays far below a normal match', () => {
    const play = (bot: (id: number) => boolean) => {
      const r = new MatchRecorder(bot);
      const ids = [1, ...Array.from({ length: 11 }, (_, i) => 100 + i)];
      r.start(ids, 0);
      // A strong player: a kill every 6 s with half headshots, an assist every 15 s, a death every 40 s.
      for (let t = 6, n = 0; t < 600; t += 6, n++) {
        if (n % 3 === 0) { r.damage(1, 100 + (n % 11), 'smg', t - 2); r.kill(100 + ((n + 1) % 11), 100 + (n % 11), 'rifle', false, t - 1); }
        r.shot(1, 'rifle', true);
        r.kill(1, 100 + (n % 11), n % 2 ? 'rifle' : 'smg', n % 2 === 0, t);
        if (t % 42 === 0) r.kill(100, 1, 'rifle', false, t);
      }
      const taken = r.take(1, 600)!;
      return { taken, ...matchXp(taken.tally, { ...WIN, humans: bot === isBot ? 1 : 12 }) };
    };
    const farm = play(isBot);
    const naive = play(() => false);
    expect(farm.taken.completed).toBe(true);
    expect(farm.taken.tally.kills).toBeGreaterThan(90);
    expect(naive.total).toBeGreaterThan(5000); // what the old rules paid
    expect(farm.total).toBeLessThanOrEqual(BOT_XP_CAP + Math.round((XP.completion + XP.win) * LOBBY_BOT_FACTOR)); // bot line + a quarter of the bonuses
    expect(farm.total).toBeLessThan(800);
    // Ten such sessions (nearly two hours) earn a fraction of what the old rules paid.
    const p = newProfile('abcdefgh12', 'tester', NOW), old = newProfile('abcdefgh13', 'tester', NOW);
    for (let i = 0; i < 10; i++) {
      applyMatch(p, farm.taken.tally, { ...WIN, humans: 1 }, NOW + i * 60_000);
      applyMatch(old, naive.taken.tally, WIN, NOW + i * 60_000);
    }
    expect(p.xp).toBeLessThan(old.xp / 5);
    expect(levelFromXp(p.xp).level).toBeLessThan(levelFromXp(old.xp).level);
    expect(p.stats.matches).toBe(10);
  });

  it('matches, wins and objectives against only bots do not count for challenges', () => {
    // A day on which the daily set has a match, win or objective challenge.
    let day = 0;
    const mode = (c: { stat: string }) => ['wins', 'matches', 'captures', 'zones', 'hill', 'tags'].includes(c.stat);
    while (!activeChallenges('daily', periodKey('daily', NOW + day * DAY)).some(mode)) day++;
    const when = NOW + day * DAY, key = periodKey('daily', when);
    const big = { ...emptyTally(), flagCaptures: 9, zoneCaptures: 9, hillSeconds: 999, tagConfirms: 99 };
    const solo = applyChallenges('daily', undefined, when, big, { ...WIN, humans: 1 });
    const crowd = applyChallenges('daily', undefined, when, big, { ...WIN, humans: 4 });
    expect(solo.state.key).toBe(key);
    expect(solo.state.progress.every((x) => x === 0)).toBe(true);
    expect(crowd.state.progress.some((x) => x > 0)).toBe(true);
  });
});

/** A Match wired to a ProfileService the way GameServer does it; `progress` messages end up in `sent`. */
function wire(type: 'tdm' | 'killconfirmed') {
  const dir = tmp();
  const service = new ProfileService({ dataDir: dir, maxProfiles: 10, secret: 'fairness-test-secret-1' });
  const s = setup(type);
  const sent: { id: number; report: ProgressReport }[] = [];
  const progress = new MatchProgress(service, { match: () => s.match, now: () => s.host.t, send: (id, m) => { if (m.t === 'progress') sent.push({ id, report: m.report }); } });
  Object.assign(s.host, progress.hooks());
  const player = (id: number, name: string) => {
    s.match.join(id, name);
    s.match.ready(id);
    const made = service.create(name)!;
    progress.bind(id, made.token, name);
    return made;
  };
  const start = () => s.advance(WARMUP_SECONDS + SPAWN_PROTECTION + 0.5);
  return { s, service, progress, sent, player, start };
}

describe('MatchProgress marks bots', () => {
  it('kills on server bots pay on the reduced line and a lone human gets reduced bonuses', () => {
    const w = wire('tdm');
    try {
      w.player(1, 'alice');
      for (const [id, name] of [[2, 'bot_b'], [3, 'bot_c'], [4, 'bot_d']] as const) { w.s.match.join(id, name, true); w.s.match.ready(id); }
      w.start();
      const me = w.s.match.players.get(1)!;
      const enemies = [...w.s.match.players.values()].filter((p) => p.bot && p.team !== me.team);
      expect(enemies.length).toBeGreaterThan(0);
      for (const e of enemies) shootDead(w.s, 1, e.id);
      w.s.advance(60);
      w.s.match.endMatch();
      const report = w.sent.find((m) => m.id === 1)!.report;
      expect(report.lines.find((l) => l.key === 'kills')).toBeUndefined();
      expect(report.lines.find((l) => l.key === 'bots')).toMatchObject({ mult: BOT_XP_FACTOR, count: enemies.length, xp: Math.round(enemies.length * XP.kill * BOT_XP_FACTOR) });
      expect(report.lines.find((l) => l.key === 'completion')).toMatchObject({ xp: Math.round(XP.completion * LOBBY_BOT_FACTOR), mult: LOBBY_BOT_FACTOR });
    } finally { w.service.close(); }
  });

  it('with two humans in the lobby the completion bonus is paid in full', () => {
    const w = wire('tdm');
    try {
      w.player(1, 'alice');
      w.player(2, 'bobby');
      w.s.match.join(3, 'bot_c', true); w.s.match.ready(3);
      w.start();
      w.s.advance(60);
      w.s.match.endMatch();
      const report = w.sent.find((m) => m.id === 1)!.report;
      expect(report.lines.find((l) => l.key === 'completion')).toEqual({ key: 'completion', xp: XP.completion });
    } finally { w.service.close(); }
  });
});

describe('Kill Confirmed pays XP', () => {
  it('tag pickups reach the recorder, pay XP and count for the tags challenge', () => {
    const r = new MatchRecorder();
    r.start([1], 0);
    r.objective(1, 'tag-confirmed');
    r.objective(1, 'tag-confirmed');
    r.objective(1, 'tag-denied');
    const { tally } = r.take(1, 100)!;
    expect(tally).toMatchObject({ tagConfirms: 2, tagDenies: 1 });
    const lines = matchXp(tally, { ...WIN, completed: false }).lines;
    expect(lines.find((l) => l.key === 'confirms')).toMatchObject({ xp: 2 * XP.tagConfirm, count: 2 });
    expect(lines.find((l) => l.key === 'denies')).toMatchObject({ xp: XP.tagDeny, count: 1 });

    const tagChallenge = DAILY_POOL.find((c) => c.stat === 'tags')!;
    let day = 0;
    while (!activeChallenges('daily', periodKey('daily', NOW + day * DAY)).includes(tagChallenge)) day++;
    const when = NOW + day * DAY;
    const idx = activeChallenges('daily', periodKey('daily', when)).indexOf(tagChallenge);
    const res = applyChallenges('daily', undefined, when, { ...emptyTally(), tagConfirms: 5, tagDenies: 3 }, { ...WIN, humans: 6 });
    expect(res.state.progress[idx]).toBe(8);
    expect(res.completed.map((c) => c.id)).toContain('d_tags');
    expect(WEEKLY_POOL.some((c) => c.stat === 'tags')).toBe(true);
  });

  it('a real confirm in a live match is credited to the player and paid out at the end', () => {
    const w = wire('killconfirmed');
    try {
      w.player(1, 'alice');
      w.player(2, 'bobby');
      w.start();
      const red = [...w.s.match.players.values()].find((p) => p.team === 'red')!;
      const blue = [...w.s.match.players.values()].find((p) => p.team === 'blue')!;
      shootDead(w.s, red.id, blue.id);
      const tag = (w.s.match.logic as unknown as { dropped: { x: number; y: number; z: number }[] }).dropped[0];
      place(w.s, red.id, tag.x + 0.3, tag.y, tag.z);
      w.s.advance(0.2);
      w.s.advance(60);
      w.s.match.endMatch();
      const report = w.sent.find((m) => m.id === red.id)!.report;
      expect(report.lines.find((l) => l.key === 'confirms')).toEqual({ key: 'confirms', xp: XP.tagConfirm, count: 1 });
      expect(w.service.get(w.progress.profileOf(red.id)!)!.stats.tags).toBe(1);
    } finally { w.service.close(); }
  });
});

describe('challenges fit the player', () => {
  it('class challenges are only offered when a weapon of the class is unlocked', () => {
    expect(classUnlockLevel('sniper')).toBe(10);
    expect(classUnlockLevel('marksman')).toBe(4);
    expect(classUnlockLevel('lmg')).toBe(5);
    expect(classUnlockLevel('ar')).toBe(1);
    expect(classUnlockLevel('melee')).toBe(1);
    const sniper = DAILY_POOL.find((c) => c.id === 'd_sniper')!;
    expect(challengeAvailable(sniper, { level: 9, prestige: 0 })).toBe(false);
    expect(challengeAvailable(sniper, { level: 10, prestige: 0 })).toBe(true);
    expect(challengeAvailable(sniper, { level: 1, prestige: 1 })).toBe(true);

    let offeredToEveryone = 0;
    for (let day = 0; day < 120; day++) {
      const now = NOW + day * DAY;
      for (const period of ['daily', 'weekly'] as const) {
        const key = periodKey(period, now);
        if (activeChallenges(period, key).some((c) => c.weaponClass === 'sniper')) offeredToEveryone++;
        for (const level of [1, 3, 9, 10, 30]) {
          const set = activeChallenges(period, key, { level, prestige: 0 });
          expect(set).toHaveLength(CHALLENGES_PER_PERIOD);
          expect(new Set(set.map((c) => c.id)).size).toBe(CHALLENGES_PER_PERIOD);
          for (const c of set) expect(challengeAvailable(c, { level, prestige: 0 }), `${c.id} at level ${level}`).toBe(true);
        }
      }
    }
    expect(offeredToEveryone).toBeGreaterThan(0); // the check above is not vacuous
  });

  it('a level-up in the middle of a period does not move progress onto another challenge', () => {
    let day = 0;
    // A day on which a level 1 player gets a different set than a level 12 player.
    while (resolveChallenges('daily', undefined, periodKey('daily', NOW + day * DAY), { level: 1, prestige: 0 }).map((c) => c.id).join()
      === resolveChallenges('daily', undefined, periodKey('daily', NOW + day * DAY), { level: 12, prestige: 0 }).map((c) => c.id).join()) day++;
    const when = NOW + day * DAY;
    const key = periodKey('daily', when);
    const low = { level: 1, prestige: 0 }, high = { level: 12, prestige: 0 };
    const first = applyChallenges('daily', undefined, when, { ...emptyTally(), kills: 1 }, { ...WIN, completed: false }, low);
    expect(first.state.ids).toEqual(resolveChallenges('daily', undefined, key, low).map((c) => c.id));
    const later = resolveChallenges('daily', first.state, key, high).map((c) => c.id);
    expect(later).toEqual(first.state.ids);
    const second = applyChallenges('daily', first.state, when, { ...emptyTally(), kills: 1 }, { ...WIN, completed: false }, high);
    expect(second.state.ids).toEqual(first.state.ids);
    // A new day starts fresh with the new rank.
    const next = applyChallenges('daily', second.state, when + DAY, emptyTally(), { ...WIN, completed: false }, high);
    expect(next.state.ids).toEqual(resolveChallenges('daily', undefined, periodKey('daily', when + DAY), high).map((c) => c.id));
  });

  it('a level 1 profile is never given sniper kills', () => {
    const p = newProfile('abcdefgh12', 'tester', NOW);
    for (let day = 0; day < 40; day++) {
      applyMatch(p, emptyTally(), { ...WIN, completed: false }, NOW + day * DAY);
      for (const state of [p.daily, p.weekly]) expect(state.ids).toBeTruthy();
      expect([...(p.daily.ids ?? []), ...(p.weekly.ids ?? [])].filter((id) => id === 'd_sniper' || id === 'w_sniper' || id === 'd_marksman' || id === 'd_lmg')).toEqual([]);
    }
  });
});

describe('profile backups', () => {
  function seed() {
    const data = tmp();
    const service = new ProfileService({ dataDir: data, maxProfiles: 100, secret: undefined });
    const made = service.create('alice')!;
    service.flush();
    return { data, service, made, backups: join(data, 'backups') };
  }

  it('snapshots profile files and secret.key, only when something changed, and keeps the newest few', () => {
    const { data, service, made, backups } = seed();
    try {
      const dir = join(backups, 'profiles');
      const first = backupProfiles(data, dir, 2, 1_000)!;
      expect(first).toBeTruthy();
      const snap = join(dir, first);
      expect(existsSync(join(snap, 'secret.key'))).toBe(true);
      expect(existsSync(join(snap, made.profile.id.slice(0, 2), `${made.profile.id}.json`))).toBe(true);
      expect(statSync(snap).mode & 0o077).toBe(0); // private: the secret signs the tokens
      expect(backupProfiles(data, dir, 2, 2_000)).toBeNull(); // nothing changed

      for (let i = 0; i < 3; i++) {
        service.get(made.profile.id)!.xp = 100 * (i + 1);
        service.store.touch(made.profile.id);
        service.flush();
        const f = join(data, 'profiles', made.profile.id.slice(0, 2), `${made.profile.id}.json`);
        writeFileSync(f, readFileSync(f)); // bump mtime
        expect(backupProfiles(data, dir, 2, 10_000 + i * 1000)).toBeTruthy();
      }
      expect(listProfileBackups(dir)).toHaveLength(2);
    } finally { service.close(); }
  });

  it('backupAll includes the profiles and leaves their folder alone when cleaning up old games', () => {
    const { data, service, backups } = seed();
    try {
      mkdirSync(join(data, 'rooms', 'ABCDEF'), { recursive: true });
      writeFileSync(join(data, 'rooms', 'ABCDEF', 'world.json'), '{}');
      expect(backupAll(data, backups, 3)).toBe(2); // the room and the profiles
      expect(readdirSync(backups).sort()).toEqual(['ABCDEF', 'profiles']);
      expect(backupAll(data, backups, 3)).toBe(0);
      expect(listProfileBackups(join(backups, 'profiles'))).toHaveLength(1);
    } finally { service.close(); }
  });

  it('a restored snapshot keeps issued tokens valid and the profile readable', () => {
    const { data, service, made, backups } = seed();
    service.close();
    backupAll(data, backups, 3);
    const snap = join(backups, 'profiles', listProfileBackups(join(backups, 'profiles'))[0]);
    rmSync(join(data, 'profiles'), { recursive: true, force: true });
    cpSync(snap, join(data, 'profiles'), { recursive: true });
    const restored = new ProfileService({ dataDir: data, maxProfiles: 100 });
    try {
      expect(restored.verify(made.token)).toBe(made.profile.id);
      expect(restored.resolve(made.token)!.name).toBe('alice');
    } finally { restored.close(); }
  });

  it('scripts/backup.sh archives profiles and secret.key and warns when they are missing', () => {
    const root = tmp();
    const fakeApp = join(root, 'app');
    mkdirSync(join(fakeApp, 'data', 'profiles', 'ab'), { recursive: true });
    writeFileSync(join(fakeApp, 'data', 'world.json'), '{}');
    writeFileSync(join(fakeApp, 'data', 'profiles', 'secret.key'), 'k');
    writeFileSync(join(fakeApp, 'data', 'profiles', 'ab', 'abcdefgh.json'), '{}');
    mkdirSync(join(fakeApp, 'data', 'backups'), { recursive: true });
    writeFileSync(join(fakeApp, 'data', 'backups', 'x.json'), '{}');
    // A fake `docker compose` that runs tar against the fake /app instead of a container (bsdtar pads a gzip stream, so gzip it apart).
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), [
      '#!/usr/bin/env bash',
      'case " $* " in',
      '  *" ps "*) echo container ;;',
      '  *" exec "*) shift; while [ "$1" != tar ]; do shift; done; args=(); for a in "$@"; do a="${a/#\\/app/$FAKE_APP}"; args+=("${a/#-czf/-cf}"); done; "${args[@]}" | gzip -c ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(bin, 'docker'), 0o755);
    const script = join(__dirname, '..', 'scripts', 'backup.sh');
    const run = () => {
      const dest = join(root, 'out');
      const out = execFileSync('bash', [script, '--dest', dest, '--keep', '3'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_APP: fakeApp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const archive = readdirSync(dest).filter((f) => f.endsWith('.tar.gz')).sort().at(-1)!;
      const listing = execFileSync('tar', ['-tzf', join(dest, archive)], { encoding: 'utf8' });
      return { out, listing };
    };
    const { listing } = run();
    expect(listing).toContain('data/profiles/secret.key');
    expect(listing).toContain('data/profiles/ab/abcdefgh.json');
    expect(listing).not.toContain('data/backups');
    expect(readFileSync(script, 'utf8')).toContain('secret.key');
  });
});

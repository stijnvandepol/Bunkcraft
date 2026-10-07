/**
 * QA round 3: modes with protocol bots, the browser only uses keys and clicks (production build).
 *
 *   QA_URL=http://localhost:3471 QA_SHOTS=/tmp/shots npx tsx scripts/qa/r3-modes.ts [elim|vote|gungame|ctf|hardpoint|domination] ...
 *
 * elim  Private elimination lobby (2 rounds, 60 s) with 3 bots: pick a class between rounds (round end, countdown) and
 *       check it is in hand at the next round.
 * vote  Private rotating TDM lobby (score 10) with 5 bots: the match ends, the vote shows, vote with 2, the next map
 *       loads, the class is still in hand.
 * gungame / ctf / hardpoint / domination: quick play with 3 bots for a while, screenshots of the HUD in each phase.
 */
import { spawn } from 'node:child_process';
import { type Engine, type Player, URL, clickButton, inMatch, key, launch, lock, newPlayer, openRealms, openTitle, quickPlay, shot, text, until, visible, wait } from './human';

const engine = (process.env.QA_ENGINE ?? 'chromium') as Engine;
const parts = process.argv.slice(2);
const results: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`); return ok; };
const bots: ReturnType<typeof spawn>[] = [];
const addBots = (code: string, n: number, secs: number) => bots.push(spawn('npx', ['tsx', 'scripts/qa/arcade-perf-bots.ts', URL, code, String(n), String(secs)], { stdio: 'ignore' }));

async function roomCode(p: Player): Promise<string> {
  const body = await p.page.locator('body').innerText();
  const m = /(?:Game code|Spelcode)[^A-Z0-9]*([A-Z0-9]{3}-?[A-Z0-9]{3})/.exec(body);
  return m ? m[1].replace('-', '') : '';
}

/** Private lobby through the menus: mode, score and time options clicked until they read as wanted. */
async function privateLobby(p: Player, mode: RegExp, score?: RegExp, time?: RegExp): Promise<string> {
  await openTitle(p);
  await openRealms(p);
  await clickButton(p, 'Private Lobby');
  const cycle = async (label: RegExp, want: RegExp) => {
    for (let i = 0; i < 12; i++) {
      const b = p.page.getByRole('button', { name: label }).first();
      if (want.test(await b.innerText())) return;
      await b.click();
    }
    throw new Error(`could not set ${want}`);
  };
  await cycle(/^Mode: /, mode);
  if (score) await cycle(/^(Rounds to Win|Score Limit|Captures to Win): /, score);
  if (time) await cycle(/^(Round Time|Time Limit): /, time);
  await clickButton(p, 'Create Lobby');
  await until(p, 'created', () => visible(p, '.realms-code'));
  const code = (await text(p, '.realms-code')).replace('-', '');
  await clickButton(p, 'Play');
  await until(p, 'in match', () => inMatch(p), 60_000);
  await lock(p);
  return code;
}

async function pickPreset(p: Player, name: string): Promise<void> {
  await key(p, 'KeyB');
  await until(p, 'loadout', () => visible(p, '.arc-loadout'), 5000);
  await p.page.locator('.arc-loadout .arc-chip', { hasText: name }).click();
  await wait(p, 200);
  await p.page.locator('.arc-loadout button.mc-btn').click();
  await wait(p, 300);
  await lock(p);
}

const browser = await launch(engine);
const a = await newPlayer(browser, 'qa_modes');
try {
  if (parts.includes('elim')) {
    const code = await privateLobby(a, /Elimination/, /: 2$/, /60 s/);
    addBots(code, 3, 400);
    // Round 1 live, then the round ends (one team wiped). Pick Sniper while the round is over.
    await until(a, 'round 1 live', async () => /\d:\d\d/.test(await text(a, '.arc-clock')), 90_000);
    await shot(a, 'r3-m-elim-live');
    await until(a, 'round over', async () => /round|ronde/i.test(await text(a, '.arc-banner')) || /NEXT|VOLGENDE/i.test(await text(a, '.arc-clock')), 150_000);
    const banner = await text(a, '.arc-banner');
    await shot(a, 'r3-m-elim-roundend');
    const dead = await visible(a, '.arc-death');
    console.log('INFO  between rounds: banner', JSON.stringify(banner), 'dead screen', dead);
    if (dead) { await key(a, 'Digit7'); await wait(a, 300); } else await pickPreset(a, 'Sniper');
    const note = await text(a, '.arc-death-loadout');
    await shot(a, 'r3-m-elim-picked');
    await until(a, 'round 2 live', async () => /\d:\d\d/.test(await text(a, '.arc-clock')) && !(await visible(a, '.arc-death')), 60_000);
    await wait(a, 500);
    check('elimination: class picked between rounds is in hand at the next round', (await text(a, '.arc-weapon-name')) === 'Bolt-Action Sniper',
      `${await text(a, '.arc-weapon-name')} (death screen line: ${note.replace(/\n/g, ' | ')})`);
    await shot(a, 'r3-m-elim-round2');
  }

  if (parts.includes('vote')) {
    const code = await privateLobby(a, /Team Deathmatch/, /: 10$/);
    await pickPreset(a, 'Support');
    addBots(code, 5, 600);
    await until(a, 'vote', () => visible(a, '.mvote:not(.hidden)'), 400_000);
    await shot(a, 'r3-m-vote');
    const cards = await a.page.locator('.mvote-card, .mvote-cards > *').allInnerTexts();
    check('vote: three maps on the end screen', cards.length === 3, cards.join(' / ').replace(/\n/g, ' '));
    await key(a, 'Digit2');
    await wait(a, 500);
    const mine = await text(a, '.mvote-mine');
    const second = (cards[1] ?? '').split('\n').map((x) => x.trim()).find((x) => x && !/^\[\d\]$/.test(x)) ?? '?';
    check('vote: key 2 votes for the second map', mine.includes(second), `${mine} (card: ${second})`);
    // The next match on the voted map: the client rejoins and builds it.
    await until(a, 'next match', async () => !(await visible(a, '.arc-end:not(.hidden)')) && (await inMatch(a)), 120_000);
    await wait(a, 3000);
    await lock(a);
    await shot(a, 'r3-m-vote-next');
    check('after the vote: class still in hand', (await text(a, '.arc-weapon-name')) === 'LMG', await text(a, '.arc-weapon-name'));
    check('after the vote: still in the same lobby', (await roomCode(a)) === code || (await roomCode(a)) === '', await roomCode(a));
  }

  for (const mode of ['gungame', 'ctf', 'hardpoint', 'domination', 'ffa', 'tdm']) {
    if (!parts.includes(mode)) continue;
    await openTitle(a);
    await openRealms(a);
    await quickPlay(a, mode);
    await lock(a);
    const code = await roomCode(a);
    addBots(code, 3, 120);
    await until(a, 'live', async () => /\d:\d\d/.test(await text(a, '.arc-clock')), 60_000).catch(() => undefined);
    await wait(a, 2000);
    await shot(a, `r3-m-${mode}-live`);
    await a.page.keyboard.down('Tab');
    await wait(a, 400);
    await shot(a, `r3-m-${mode}-tab`);
    await a.page.keyboard.up('Tab');
    await until(a, 'dead', () => visible(a, '.arc-death'), 90_000).catch(() => undefined);
    await shot(a, `r3-m-${mode}-dead`);
    check(`${mode}: went live, played, no page errors`, a.errors.filter((e) => !/Content Security/.test(e)).length === 0, a.errors.join(' | '));
    await key(a, 'Escape');
    await wait(a, 500);
    await a.page.getByRole('button', { name: /Disconnect/ }).click();
    await until(a, 'realms', () => visible(a, '.realms-screen'), 15_000);
    for (const b of bots.splice(0)) b.kill();
  }
} catch (e) {
  check('flow', false, (e as Error).message);
  await shot(a, `r3-m-fail`).catch(() => undefined);
} finally {
  for (const b of bots) b.kill();
  console.log('errors:', a.errors.filter((e) => !/Content Security/.test(e)));
  console.log(`${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  await browser.close();
}

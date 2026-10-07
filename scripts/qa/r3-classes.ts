/**
 * QA round 3: picking a class in every phase, as a player does it (production build, real keys and clicks).
 * One browser quick-plays a mode; protocol bots (arcade-perf-bots) join so the match goes live and someone
 * kills us. Checks the weapon on the HUD after each pick.
 *
 *   QA_ENGINE=webkit QA_URL=http://localhost:3471 npx tsx scripts/qa/r3-classes.ts [mode=tdm]
 */
import { spawn } from 'node:child_process';
import {
  type Engine, type Player, key, launch, lock, newPlayer, openRealms, openTitle, quickPlay, shot, text, until, visible, wait,
} from './human';

const engine = (process.env.QA_ENGINE ?? 'chromium') as Engine;
const mode = process.argv[2] ?? 'tdm';
const tag = `r3-cls-${engine}-${mode}`;
const results: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`); };

const weapon = (p: Player) => text(p, '.arc-weapon-name');
const slots = async (p: Player) => (await p.page.locator('.arc-slot').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());

async function roomCode(p: Player): Promise<string> {
  const body = await p.page.locator('body').innerText();
  const m = /(?:Game code|Spelcode)[^A-Z0-9]*([A-Z0-9]{3}-?[A-Z0-9]{3})/.exec(body);
  return m ? m[1].replace('-', '') : '';
}

/** Opens Create-a-Class with B, clicks a preset chip (0-based), closes with Done. */
async function pickPreset(p: Player, i: number, how: 'click' | 'key' = 'click'): Promise<void> {
  if (how === 'key') { await key(p, `Digit${i + 1}`); await wait(p, 300); return; }
  await key(p, 'KeyB');
  await until(p, 'loadout open', () => visible(p, '.arc-loadout'), 5000);
  await p.page.locator('.arc-loadout .arc-chip').nth(i).click();
  await wait(p, 250);
  await p.page.locator('.arc-loadout button.mc-btn').click();
  await wait(p, 300);
  await lock(p);
}

const browser = await launch(engine);
const a = await newPlayer(browser, 'qa_classes');
let bots: ReturnType<typeof spawn> | null = null;
try {
  await openTitle(a);
  await openRealms(a);
  await quickPlay(a, mode);
  check('locks the pointer by clicking into the game', await lock(a));
  await wait(a, 1000);

  // 1. Warm-up, alone: Breacher (shotgun) → applies at once.
  await pickPreset(a, 2);
  check('warm-up: class applies at once', (await weapon(a)) === 'Shotgun', `${await weapon(a)} / ${(await slots(a)).join(', ')}`);
  await shot(a, `${tag}-01-warmup-pick`);

  // Bots join: the match counts down and goes live.
  const code = await roomCode(a);
  check('room code shown in chat', code.length === 6, code);
  bots = spawn('npx', ['tsx', 'scripts/qa/arcade-perf-bots.ts', process.env.QA_URL ?? 'http://localhost:3471', code, '3', '240'], { stdio: 'ignore' });
  // Wait for the live spawn: spawn protection shows after the countdown.
  await until(a, 'live spawn', async () => (await visible(a, '.arc-protect')) && !(await text(a, '.arc-clock')).match(/WARM|OPWARM/i), 60_000);
  const liveWeapon = await weapon(a);
  check('go live: the warm-up class is still in hand', liveWeapon === 'Shotgun', liveWeapon);
  await shot(a, `${tag}-02-live-spawn`);

  // 2. Right after spawning (within 3 s, no shot): Support (LMG) applies at once.
  await pickPreset(a, 3);
  check('live, right after spawn: class applies at once', (await weapon(a)) === 'LMG', await weapon(a));

  // 3. Mid-life (after 4 s and a shot): Marksman is for the next life.
  await wait(a, 3500);
  await a.page.mouse.down(); await wait(a, 120); await a.page.mouse.up();
  await key(a, 'KeyB');
  await until(a, 'loadout open', () => visible(a, '.arc-loadout'), 5000);
  const note = await text(a, '.arc-loadout-note');
  await a.page.locator('.arc-loadout .arc-chip').nth(4).click();
  await wait(a, 300);
  await shot(a, `${tag}-03-midlife-cac`);
  await a.page.locator('.arc-loadout button.mc-btn').click();
  await lock(a);
  check('live, mid-life: weapon stays until death', (await weapon(a)) === 'LMG', `${await weapon(a)}; note "${note}"`);
  console.log('INFO  mid-life loadout note:', note);

  // 4. Die (the bots hunt us; stand still) and pick on the death screen with a number key.
  await until(a, 'death screen', () => visible(a, '.arc-death'), 150_000);
  await shot(a, `${tag}-04-dead`);
  const deadLines = await text(a, '.arc-death');
  console.log('INFO  death screen:', deadLines.replace(/\n/g, ' | '));
  await key(a, 'Digit2'); // Rusher
  await wait(a, 300);
  const after = await text(a, '.arc-death-loadout');
  check('death screen: number key marks the next class', /SMG/.test(after), after.replace(/\n/g, ' | '));
  await shot(a, `${tag}-05-dead-picked`);
  await until(a, 'respawn', async () => !(await visible(a, '.arc-death')), 20_000);
  await wait(a, 300);
  check('respawn: picked class in hand', (await weapon(a)) === 'SMG', await weapon(a));
  await shot(a, `${tag}-06-respawned`);

  // 5. B on the death screen.
  await until(a, 'death screen 2', () => visible(a, '.arc-death'), 150_000);
  await key(a, 'KeyB');
  const cacDead = await visible(a, '.arc-loadout');
  check('death screen: B opens Create-a-Class', cacDead);
  if (cacDead) {
    await a.page.locator('.arc-loadout .arc-chip').nth(0).click();
    await a.page.locator('.arc-loadout button.mc-btn').click();
  }
  await until(a, 'respawn 2', async () => !(await visible(a, '.arc-death')), 20_000);
  await lock(a);
  await wait(a, 300);
  check('respawn after B: Assault in hand', (await weapon(a)) === 'Assault Rifle', await weapon(a));
  await shot(a, `${tag}-07-respawned-assault`);
} catch (e) {
  check('flow', false, (e as Error).message);
  await shot(a, `${tag}-fail`).catch(() => undefined);
} finally {
  bots?.kill();
  console.log('errors:', a.errors);
  console.log(`${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  await browser.close();
}

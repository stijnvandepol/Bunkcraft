/**
 * QA round 3: a returning player after an update. One persistent browser profile (service worker, caches, localStorage).
 *
 *   QA_PROFILE=/tmp/profile npx tsx scripts/qa/r3-returning.ts seed     # build A: visit, play once, leave old-style storage
 *   (rebuild with a change, restart the server)
 *   QA_PROFILE=/tmp/profile npx tsx scripts/qa/r3-returning.ts return   # build B: same profile comes back
 */
import { chromium, webkit } from '@playwright/test';
import { type Player, URL, clickButton, inMatch, key, lock, openRealms, quickPlay, shot, text, until, visible, wait } from './human';

const step = process.argv[2] ?? 'seed';
const engine = process.env.QA_ENGINE ?? 'chromium';
const profile = process.env.QA_PROFILE ?? '/tmp/bunk-r3-profile';
const ctx = engine === 'webkit'
  ? await webkit.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 720 } })
  : await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 720 }, args: ['--use-angle=metal'] });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Content Security|favicon|AudioContext/.test(m.text())) errors.push(`console: ${m.text()}`); });
const p: Player = { name: 'qa_return', ctx, page, errors, logs: [] };
// The shim of human.ts is only installed by newPlayer: add it here too.
const shim = (await import('node:fs')).readFileSync(new globalThis.URL('./human.ts', import.meta.url), 'utf8');
const m = /const POINTER_LOCK_SHIM = `([\s\S]*?)`;/.exec(shim);
if (m) await ctx.addInitScript({ content: m[1] });

try {
  await page.goto(URL);
  await until(p, 'title', async () => (await page.getByRole('button', { name: /BunkCraft Realms/ }).count()) > 0, 60_000);
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    return { controller: !!navigator.serviceWorker?.controller, active: !!reg?.active, waiting: !!reg?.waiting, scripts: [...document.scripts].map((s) => s.src.split('/').pop()) };
  });
  console.log('INFO  service worker:', JSON.stringify(sw));
  if (step === 'seed') {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await openRealms(p);
    await quickPlay(p, 'tdm');
    await lock(p);
    await wait(p, 1000);
    await key(p, 'Escape');
    await clickButton(p, 'Disconnect');
    // Storage the way older versions (or a hand-edited profile) left it.
    await page.evaluate(() => {
      localStorage.setItem('bunkcraft.arcadeClass', JSON.stringify({ primary: 'railgun', optic: 'xray', secondary: 'knife', perk: 'wallhack' }));
      localStorage.setItem('bunkcraft.arcadeClass.last', JSON.stringify({ primary: 'sniper', optic: 'reddot', secondary: 'sniper', perk: 'aimbot' }));
      const s = JSON.parse(localStorage.getItem('bunkcraft.settings') ?? '{}');
      Object.assign(s, { fov: 400, sensitivity: 'fast', guiScale: -3, oldOption: true });
      localStorage.setItem('bunkcraft.settings', JSON.stringify(s));
      localStorage.setItem('bunkcraft.games', '{not json');
    });
    console.log('PASS  seeded profile', profile);
  } else {
    await wait(p, 3000);
    const toast = await page.locator('.toast, .update-toast, [class*="toast"]').allInnerTexts();
    console.log('INFO  toasts:', JSON.stringify(toast));
    await shot(p, `r3-ret-${engine}-title`);
    await openRealms(p);
    await shot(p, `r3-ret-${engine}-realms`);
    await quickPlay(p, 'tdm');
    await lock(p);
    await wait(p, 1500);
    await shot(p, `r3-ret-${engine}-match`);
    console.log(`${(await text(p, '.arc-weapon-name')) === 'Bolt-Action Sniper' ? 'PASS' : 'FAIL'}  last class (sanitised) in hand: ${await text(p, '.arc-weapon-name')} / ${(await p.page.locator('.arc-slot').allInnerTexts()).join(', ')}`);
    await key(p, 'KeyB');
    await wait(p, 500);
    console.log(`${(await visible(p, '.arc-loadout')) ? 'PASS' : 'FAIL'}  Create-a-Class opens with the broken saved custom class`);
    await shot(p, `r3-ret-${engine}-cac`);
    console.log(`${(await inMatch(p)) ? 'PASS' : 'FAIL'}  in a match`);
  }
} catch (e) {
  console.log('FAIL  flow', (e as Error).message);
  await shot(p, `r3-ret-${engine}-fail`).catch(() => undefined);
} finally {
  console.log('errors:', errors);
  await ctx.close();
}

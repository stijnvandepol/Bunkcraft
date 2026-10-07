/**
 * QA round 3 exploration: one player, Title → Realms → Quick Play TDM in the production build, then the
 * keys a player presses in warm-up (B, Tab, Esc, number keys, R, right-click, Shift).
 *   QA_ENGINE=webkit QA_URL=http://localhost:3471 npx tsx scripts/qa/r3-explore.ts
 */
import { type Engine, key, launch, lock, newPlayer, openRealms, openTitle, quickPlay, shot, text, visible, wait } from './human';

const engine = (process.env.QA_ENGINE ?? 'chromium') as Engine;
const mode = process.env.QA_MODE ?? 'tdm';
const tag = `r3-x-${engine}-${mode}`;

const browser = await launch(engine);
const a = await newPlayer(browser, 'qa_alpha');
try {
  await openTitle(a);
  await openRealms(a);
  await shot(a, `${tag}-01-realms`);
  await quickPlay(a, mode);
  await wait(a, 2000);
  await shot(a, `${tag}-02-joined`);
  const locked = await lock(a);
  console.log('pointer locked:', locked, 'click-to-play visible:', await visible(a, '.click-to-play'));
  await wait(a, 1000);
  await shot(a, `${tag}-03-locked`);
  console.log('weapon:', await text(a, '.arc-weapon-name'), 'ammo:', await text(a, '.arc-ammo-row'));
  // Create-a-Class
  await key(a, 'KeyB');
  await wait(a, 600);
  console.log('loadout open:', await visible(a, '.arc-loadout'), 'locked:', await a.page.evaluate(() => !!document.pointerLockElement));
  await shot(a, `${tag}-04-cac`);
  // pick preset 2 by clicking the second chip
  const chips = a.page.locator('.arc-loadout .arc-chip');
  console.log('chips:', await chips.count(), await chips.allInnerTexts());
  await chips.nth(2).click();
  await wait(a, 600);
  await shot(a, `${tag}-05-cac-picked`);
  console.log('loadout open after pick:', await visible(a, '.arc-loadout'));
  if (await visible(a, '.arc-loadout')) await key(a, 'Escape');
  await wait(a, 800);
  console.log('after esc: loadout', await visible(a, '.arc-loadout'), 'pause', await visible(a, '.screen'), 'locked', await a.page.evaluate(() => !!document.pointerLockElement));
  await shot(a, `${tag}-06-after-cac`);
  await lock(a);
  await wait(a, 500);
  console.log('weapon now:', await text(a, '.arc-weapon-name'), 'ammo:', await text(a, '.arc-ammo-row'), 'slots:', await a.page.locator('.arc-slot').allInnerTexts());
  // Tab
  await a.page.keyboard.down('Tab');
  await wait(a, 400);
  console.log('board:', await visible(a, '.arc-board'));
  await shot(a, `${tag}-07-tab`);
  await a.page.keyboard.up('Tab');
  // fire a bit and reload
  await a.page.mouse.down();
  await wait(a, 600);
  await a.page.mouse.up();
  console.log('ammo after fire:', await text(a, '.arc-ammo-row'));
  await key(a, 'KeyR');
  await wait(a, 300);
  await shot(a, `${tag}-08-reload`);
  await wait(a, 3000);
  console.log('ammo after reload:', await text(a, '.arc-ammo-row'));
  // ADS
  await a.page.mouse.down({ button: 'right' });
  await wait(a, 700);
  await shot(a, `${tag}-09-ads`);
  await a.page.mouse.up({ button: 'right' });
  // slot 2
  await key(a, 'Digit2');
  await wait(a, 500);
  console.log('weapon slot2:', await text(a, '.arc-weapon-name'));
  await shot(a, `${tag}-10-slot2`);
  await key(a, 'Escape');
  await wait(a, 700);
  await shot(a, `${tag}-11-esc`);
  console.log('buttons:', await a.page.getByRole('button').allInnerTexts());
} finally {
  console.log('errors:', a.errors);
  console.log('logs:', a.logs.slice(-15));
  await browser.close();
}

/**
 * QA round 3: every primary (and optic) in hand in the production build, picked through Create-a-Class in the warm-up:
 * hip view, aimed view, a shot and a reload, as screenshots. Checks the HUD weapon name after each pick.
 *
 *   QA_URL=http://localhost:3471 QA_SHOTS=/tmp/shots npx tsx scripts/qa/r3-weapons.ts [weaponId ...]
 */
import { PRIMARY_WEAPONS, weaponDef } from '../../src/modes/Weapons';
import { type Engine, key, launch, lock, newPlayer, openRealms, openTitle, quickPlay, shot, text, until, visible, wait } from './human';

const engine = (process.env.QA_ENGINE ?? 'chromium') as Engine;
const only = process.argv.slice(2);
const browser = await launch(engine);
const a = await newPlayer(browser, 'qa_guns');
const results: string[] = [];
try {
  await openTitle(a);
  await openRealms(a);
  await quickPlay(a, 'tdm');
  await lock(a);
  await wait(a, 800);
  await shot(a, `r3-w-${engine}-00-start`);
  const combos: [string, string][] = [];
  for (const id of PRIMARY_WEAPONS) for (const o of weaponDef(id)!.optics) combos.push([id, o]);
  for (const [id, optic] of combos) {
    if (only.length && !only.includes(id)) continue;
    const w = weaponDef(id)!;
    await key(a, 'KeyB');
    await until(a, 'loadout', () => visible(a, '.arc-loadout'), 5000);
    await a.page.locator('.arc-cac-col').nth(0).locator('.arc-cac-item', { hasText: w.name }).first().click();
    await a.page.locator('.arc-cac-col').nth(1).locator('.arc-cac-item').nth(['iron', 'reddot', 'holo', 'combat', 'scope'].indexOf(optic)).click();
    await wait(a, 200);
    if (id === combos[0][0] && optic === combos[0][1]) await shot(a, `r3-w-${engine}-cac`);
    await a.page.locator('.arc-loadout button.mc-btn').click();
    await wait(a, 300);
    await lock(a);
    await wait(a, 500);
    const name = await text(a, '.arc-weapon-name');
    results.push(`${name === w.name ? 'PASS' : 'FAIL'}  ${id}/${optic}: HUD says "${name}"`);
    const tag = `r3-w-${engine}-${id}-${optic}`;
    await shot(a, `${tag}-hip`);
    await a.page.mouse.down({ button: 'right' });
    await wait(a, 900);
    await shot(a, `${tag}-ads`);
    await a.page.mouse.down();
    await wait(a, 60);
    await shot(a, `${tag}-fire`);
    await a.page.mouse.up();
    await a.page.mouse.up({ button: 'right' });
    await wait(a, 600);
    await key(a, 'KeyR');
    await wait(a, 300);
    await shot(a, `${tag}-reload`);
    await wait(a, (w.reloadSec + 0.4) * 1000);
  }
} catch (e) {
  results.push(`FAIL  flow: ${(e as Error).message}`);
  await shot(a, 'r3-w-fail').catch(() => undefined);
} finally {
  for (const r of results) console.log(r);
  console.log('errors:', a.errors);
  await browser.close();
}

/**
 * QA round 3: the server restarts during a match (deploy). The player should see "reconnecting" and land back in the
 * same lobby without touching anything, with the class they had.
 *
 *   QA_URL=http://localhost:3471 QA_RESTART="sh restart.sh" npx tsx scripts/qa/r3-restart.ts
 */
import { execSync } from 'node:child_process';
import { type Engine, inMatch, key, launch, lock, newPlayer, openRealms, openTitle, quickPlay, shot, text, until, visible, wait } from './human';

const engine = (process.env.QA_ENGINE ?? 'chromium') as Engine;
const browser = await launch(engine);
const a = await newPlayer(browser, 'qa_restart');
const code = async () => /(?:Game code|Spelcode)[^A-Z0-9]*([A-Z0-9]{3}-?[A-Z0-9]{3})/.exec(await a.page.locator('body').innerText())?.[1] ?? '';
try {
  await openTitle(a);
  await openRealms(a);
  await quickPlay(a, 'tdm');
  await lock(a);
  await key(a, 'KeyB');
  await a.page.locator('.arc-loadout .arc-chip', { hasText: 'Marksman' }).click();
  await a.page.locator('.arc-loadout button.mc-btn').click();
  await lock(a);
  const before = await code();
  console.log('INFO  lobby', before);
  execSync(process.env.QA_RESTART ?? 'true', { stdio: 'inherit' });
  await wait(a, 500);
  await shot(a, `r3-restart-${engine}-down`);
  console.log('INFO  while down:', (await a.page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' | '));
  await until(a, 'back in a match', () => inMatch(a), 60_000);
  await wait(a, 1500);
  await shot(a, `r3-restart-${engine}-back`);
  const after = await code();
  console.log(`${after === before ? 'PASS' : 'FAIL'}  back in the same lobby (${before} -> ${after})`);
  await lock(a);
  await wait(a, 500);
  console.log(`${(await text(a, '.arc-weapon-name')) === 'DMR' ? 'PASS' : 'FAIL'}  class kept: ${await text(a, '.arc-weapon-name')}`);
  console.log(`${(await visible(a, '.click-to-play')) ? 'INFO' : 'PASS'}  click-to-play after the reconnect: ${await visible(a, '.click-to-play')}`);
} catch (e) {
  console.log('FAIL  flow', (e as Error).message);
  await shot(a, `r3-restart-${engine}-fail`).catch(() => undefined);
} finally {
  console.log('errors:', a.errors.filter((e) => !/Content Security/.test(e)));
  await browser.close();
}

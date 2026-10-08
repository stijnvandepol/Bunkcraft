import { type Browser, type Page } from '@playwright/test';
import { expect, forcePlaying, openTitle, test, waitForWorld } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A second browser (own storage, own identity) with the same page-error check as the main page. */
async function secondPlayer(browser: Browser, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`second browser: ${e.message}`));
  return page;
}

/** Home → pick the mode → PLAY → (name, asked once) → in the arena. */
async function quickPlay(page: Page, name: string, mode = 'tdm'): Promise<void> {
  await openTitle(page);
  await page.locator(`.mode-card[data-mode="${mode}"]`).click();
  await expect(page.locator('.bc-play')).toBeEnabled();
  await page.locator('.bc-play').click();
  await expect(page.getByRole('heading', { name: 'Choose a Name' })).toBeVisible();
  await page.locator('input.mc-input:visible').first().fill(name);
  await page.keyboard.press('Enter');
  await waitForWorld(page);
  await forcePlaying(page);
}

const roomCode = (page: Page) => page.evaluate(() => (window as any).game.roomCode as string);
const selfId = (page: Page) => page.evaluate(() => (window as any).game.net.id as number);
const chatText = (page: Page) => page.evaluate(() => (window as any).game.chat.log.textContent as string);

/** Both players are in the lobby and the match is live. */
async function bothLive(a: Page, b: Page): Promise<void> {
  await expect.poll(async () => {
    await a.bringToFront();
    await b.bringToFront();
    return Promise.all([a, b].map((p) => p.evaluate(() => (window as any).game.arcade?.phase)));
  }, { timeout: 40_000 }).toEqual(['live', 'live']);
}

test('rejoin: a page reload in the middle of a match offers the seat on the home screen and takes it back', async ({ page, browser, consoleErrors }) => {
  test.setTimeout(240_000);
  await quickPlay(page, 'rejoin_a');
  const code = await roomCode(page);
  const b = await secondPlayer(browser, consoleErrors);
  await quickPlay(b, 'rejoin_b');
  expect(await roomCode(b)).toBe(code);
  await bothLive(page, b);
  const id = await selfId(page);

  // The tab reloads (it could just as well have crashed): the other player sees it leave...
  await page.reload();
  await page.waitForFunction(() => {
    const g = (window as any).game;
    return !!g && g.state === 'menu' && !!document.querySelector('button');
  }, undefined, { timeout: 60_000 });
  await b.bringToFront();
  await expect.poll(() => chatText(b), { timeout: 15_000 }).toMatch(/rejoin_a (lost connection|left the game)/);

  // ... and the home screen offers the way back, with the time left.
  const offer = page.locator('.home-rejoin');
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await expect(offer).toContainText('Rejoin your match');
  await expect(offer).toContainText(/\d:\d\d left/);
  await offer.getByRole('button', { name: 'Rejoin' }).click();
  await waitForWorld(page);
  await forcePlaying(page);

  // Same lobby, same seat (the server hands the old id back), and the player is told so.
  expect(await roomCode(page)).toBe(code);
  expect(await selfId(page)).toBe(id);
  await expect.poll(() => chatText(page), { timeout: 15_000 }).toContain('Welcome back');
  await b.bringToFront();
  await expect.poll(() => chatText(b), { timeout: 15_000 }).toContain('rejoin_a rejoined the game');
  await expect.poll(() => b.evaluate(() => [...(window as any).game.remote.players.values()].map((r: any) => r.name)), { timeout: 15_000 }).toContain('rejoin_a');
  await page.bringToFront();
  expect(await page.evaluate(() => (window as any).game.arcade?.phase)).toBe('live');

  // Leaving on purpose throws the ticket away: nothing to rejoin afterwards.
  await page.evaluate(() => (window as any).game.quitToTitle());
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.home-rejoin')).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('.home'), undefined, { timeout: 60_000 });
  await expect(page.locator('.home-rejoin')).toBeHidden();
  await b.context().close();
});

test('rejoin: a dropped connection shows "Reconnecting..." and gets the player back into the same lobby by itself', async ({ page, browser, consoleErrors }) => {
  test.setTimeout(240_000);
  await quickPlay(page, 'drop_a');
  const code = await roomCode(page);
  const b = await secondPlayer(browser, consoleErrors);
  await quickPlay(b, 'drop_b');
  await bothLive(page, b);
  const id = await selfId(page);

  // The network breaks: the socket closes without the player leaving.
  await page.evaluate(() => (window as any).game.net.ws.close());
  await expect(page.getByRole('heading', { name: 'Reconnecting...' })).toBeVisible({ timeout: 10_000 });
  await waitForWorld(page);
  await forcePlaying(page);
  expect(await roomCode(page)).toBe(code);
  expect(await selfId(page)).toBe(id);
  await expect.poll(() => chatText(page), { timeout: 15_000 }).toContain('Welcome back');
  await b.bringToFront();
  await expect.poll(() => chatText(b), { timeout: 15_000 }).toContain('drop_a rejoined the game');
  await b.context().close();
});

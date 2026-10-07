import { type Browser, type Page } from '@playwright/test';
import { clickButton, expect, forcePlaying, hidePanorama, openSandbox, openTitle, play, test, waitForWorld } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A second browser (own storage, own identity) with the same page-error check as the main page. */
async function secondPlayer(browser: Browser, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`second browser: ${e.message}`));
  return page;
}

/** Home → pick the mode → PLAY → (name, asked once, then quick play goes on by itself) → in the arena. */
async function quickPlay(page: Page, name: string, mode = 'tdm'): Promise<void> {
  await openTitle(page);
  const card = page.locator(`.mode-card[data-mode="${mode}"]`);
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('.bc-play')).toBeEnabled();
  await page.locator('.bc-play').click();
  // A fresh browser has no name yet: PLAY asks for it once.
  await expect(page.getByRole('heading', { name: 'Choose a Name' })).toBeVisible();
  await page.locator('input.mc-input:visible').first().fill(name);
  await page.keyboard.press('Enter');
  await waitForWorld(page);
  await forcePlaying(page);
}

const roomCode = (page: Page) => page.evaluate(() => (window as any).game.roomCode as string);

test('realms: two players quick play team deathmatch, meet in one lobby and the match goes live', async ({ page, browser, consoleErrors }) => {
  test.setTimeout(180_000);
  await quickPlay(page, 'realm_red');
  const code = await roomCode(page);
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  expect(await page.evaluate(() => (window as any).game.arcade?.info?.type)).toBe('tdm');

  // Alone in the lobby: the warm-up panel shows the mode and waits for a second player.
  await expect(page.locator('.mlobby')).toBeVisible();
  await expect(page.locator('.mlobby-status')).toContainText('Waiting for players');

  // The second player is matched into the same lobby (the fullest one with room), not a new one.
  const b = await secondPlayer(browser, consoleErrors);
  await quickPlay(b, 'realm_blue');
  expect(await roomCode(b)).toBe(code);

  // Both are listed per team in the lobby panel, then the warm-up counts down and the match goes live.
  await expect.poll(async () => { await page.bringToFront(); return page.locator('.mlobby-player').allTextContents(); }, { timeout: 15_000 })
    .toEqual(expect.arrayContaining(['realm_red', 'realm_blue']));
  await expect.poll(async () => {
    await page.bringToFront();
    await b.bringToFront();
    return Promise.all([page, b].map((p) => p.evaluate(() => (window as any).game.arcade?.phase)));
  }, { timeout: 40_000 }).toEqual(['live', 'live']);
  await expect(page.locator('.mlobby')).toBeHidden();

  // Leaving the match goes back to the home screen (the arena hub), with the mode still picked.
  await page.evaluate(() => (window as any).game.quitToTitle());
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.mode-card[data-mode="tdm"]')).toHaveAttribute('aria-pressed', 'true');
  await b.context().close();
});

test('realms: the private match screen matches its baseline and Multiplayer only creates Minecraft games', async ({ page }) => {
  await openTitle(page);
  await page.evaluate(() => localStorage.setItem('bunkcraft.name', 'baseline_p'));
  await expect(page.locator('.mode-card')).toHaveCount(12);
  await expect(page.locator('.bc-play')).toBeEnabled();
  await clickButton(page, 'Private match');
  await expect(page.getByRole('heading', { name: 'Create Private Match' })).toBeVisible();
  await page.mouse.move(0, 0);
  await hidePanorama(page);
  await play(page, 300);
  await expect(page).toHaveScreenshot('private-match.png', { maxDiffPixelRatio: 0.04 });
  await clickButton(page, 'Cancel');
  await openSandbox(page);
  await clickButton(page, 'Multiplayer');
  await clickButton(page, 'Create Game');
  await expect(page.getByRole('button', { name: /^Game Mode:/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Game Type:/ })).toHaveCount(0);
});

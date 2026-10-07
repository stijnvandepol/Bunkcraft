import { expect, hidePanorama, openSandbox, openTitle, test } from './fixtures';

/** What changes between runs on the home screen: live player counts, the background map's name, the build. */
const HOME_MASKS = ['.bc-play-sub', '.mode-count', '.home-foot-meta'];

test('home screen loads without errors and matches the baseline @webkit', async ({ page }) => {
  await openTitle(page);
  // The front door is the arena shooter: PLAY, the playlist, play with code, and a smaller Build & Survival door.
  await expect(page.locator('.bc-play')).toBeEnabled();
  await expect(page.locator('.bc-play')).toContainText('Play');
  await expect(page.locator('.mode-card')).toHaveCount(12);
  await expect(page.getByRole('button', { name: /Build & Survival/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Code or invite link' })).toBeVisible();
  // The flythrough behind the menu moves and differs per GPU: compare the menu only.
  await hidePanorama(page);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('title.png', { mask: HOME_MASKS.map((s) => page.locator(s)), maxDiffPixelRatio: 0.04 });
});

test('the home screen is keyboard friendly: PLAY takes the first focus and a mode card selects with Enter', async ({ page }) => {
  await openTitle(page);
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('bc-play'))).toBe(true);
  const card = page.locator('.mode-card[data-mode="ffa"]');
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.bc-play-mode')).toHaveText('Free-for-All');
  // The pick is remembered: PLAY starts it after a reload.
  await openTitle(page);
  await expect(page.locator('.bc-play-mode')).toHaveText('Free-for-All');
});

test('the menu screens open and match their baselines', async ({ page }) => {
  await openTitle(page);
  await hidePanorama(page);
  await openSandbox(page);
  await page.getByRole('button', { name: 'Singleplayer' }).click();
  await expect(page.getByRole('button', { name: 'Create New World' }).first()).toBeVisible();
  await expect(page).toHaveScreenshot('select-world.png', { mask: [page.locator('.world-meta')], maxDiffPixelRatio: 0.04 });
  await page.getByRole('button', { name: 'Create New World' }).first().click();
  await expect(page).toHaveScreenshot('create-world.png', { maxDiffPixelRatio: 0.04 });
});

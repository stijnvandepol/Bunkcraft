import { expect, hidePanorama, openTitle, test } from './fixtures';

test('title screen loads without errors and matches the baseline @webkit', async ({ page }) => {
  await openTitle(page);
  await expect(page.getByRole('button', { name: 'Singleplayer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Multiplayer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'BunkCraft Realms' })).toBeEnabled();
  // The panorama behind the menu moves and differs per GPU: compare the menu only (the splash text is random).
  await hidePanorama(page);
  await expect(page).toHaveScreenshot('title.png', { mask: [page.locator('.splash')], maxDiffPixelRatio: 0.04 });
});

test('the menu screens open and match their baselines', async ({ page }) => {
  await openTitle(page);
  await hidePanorama(page);
  await page.getByRole('button', { name: 'Singleplayer' }).click();
  await expect(page.getByRole('button', { name: 'Create New World' }).first()).toBeVisible();
  await expect(page).toHaveScreenshot('select-world.png', { mask: [page.locator('.world-meta')], maxDiffPixelRatio: 0.04 });
  await page.getByRole('button', { name: 'Create New World' }).first().click();
  await expect(page).toHaveScreenshot('create-world.png', { maxDiffPixelRatio: 0.04 });
});

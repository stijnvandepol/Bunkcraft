import { clickButton, expect, openTitle, test } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

test('realms progression: the level bar appears, the profile survives a reload, stats and challenges open', async ({ page }) => {
  await openTitle(page);
  // A guest's profile card asks for a name.
  const banner = page.locator('.home-profile');
  await expect(banner).toContainText('Choose a name');
  await banner.click();
  await expect(page.getByRole('heading', { name: 'Choose a Name' })).toBeVisible();
  await page.locator('input.mc-input:visible').first().fill('prog_player');
  await page.keyboard.press('Enter');

  // A fresh browser gets a server-issued profile: rank icon, title and the level bar at level 1.
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/Level 1/i);
  await expect(banner).toContainText('0 / 800 XP');
  await expect(banner.locator('.rank-badge')).toHaveAttribute('data-lv', '1');
  await expect(banner.locator('.bc-bar')).toBeVisible();
  // The daily challenges show under the playlist.
  await expect(page.locator('.home-chal[data-challenge]')).toHaveCount(3);
  const token = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('bunkcraft.profile.'))?.[1]);
  expect(token).toMatch(/^v1\./);

  // Stats and challenges open from the hub.
  await clickButton(page, 'Stats');
  await expect(page.getByRole('heading', { name: 'Combat Record' })).toBeVisible();
  await expect(page.locator('.prog-stat').first()).toBeVisible();
  await clickButton(page, 'Back');
  await clickButton(page, 'All challenges');
  await expect(page.locator('.prog-row[data-challenge]:visible')).toHaveCount(6);
  await clickButton(page, 'Back');

  // After a reload the same profile comes back (the token is kept per server in this browser).
  await page.reload();
  await openTitle(page);
  await expect(page.locator('.home-profile')).toContainText(/Level 1/i);
  expect(await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('bunkcraft.profile.'))?.[1])).toBe(token);
});

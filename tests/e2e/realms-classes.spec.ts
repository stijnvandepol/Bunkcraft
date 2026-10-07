import { type Page } from '@playwright/test';
import { clickButton, expect, forcePlaying, openTitle, play, test, waitForWorld } from './fixtures';

/*
 * QA round 3: Create-a-Class the way a player uses it (B, clicks on the cards and the editor, Done), against the real
 * server through the Realms menus.
 */

async function quickPlay(page: Page, name: string, mode = 'tdm'): Promise<void> {
  await openTitle(page);
  await clickButton(page, 'BunkCraft Realms');
  await expect(page.getByRole('heading', { name: 'Choose a Name' })).toBeVisible();
  await page.locator('input.mc-input:visible').first().fill(name);
  await page.keyboard.press('Enter');
  await page.locator(`.realms-item[data-mode="${mode}"]`).click();
  await clickButton(page, 'Quick Play');
  await waitForWorld(page);
  await forcePlaying(page);
}

const selectedIn = (page: Page, column: number) => page.locator('.arc-cac-col').nth(column).locator('.arc-cac-item.selected');

test('create-a-class: a picked preset shows in the editor, applies at once in the warm-up, and the chat stays out of the menu', async ({ page }) => {
  test.setTimeout(120_000);
  await quickPlay(page, 'cac_e2e');
  // The welcome lines are in the chat at this point.
  await expect(page.locator('.chat-line').first()).toBeVisible();
  await page.keyboard.press('KeyB');
  await expect(page.locator('.arc-loadout')).toBeVisible();
  // Before the fix the chat lines were drawn over the editor columns.
  await expect(page.locator('.chat')).toBeHidden();
  await page.locator('.arc-loadout .arc-chip', { hasText: 'Breacher' }).click();
  // Before the fix the editor kept showing the old custom class (Assault Rifle) after a preset pick.
  await expect(selectedIn(page, 0)).toHaveText(/Shotgun/);
  await expect(selectedIn(page, 2)).toHaveText(/Pistol/);
  await expect(selectedIn(page, 3)).toHaveText(/Ninja/);
  // Warm-up: no fighting, so the note does not promise "next life".
  await expect(page.locator('.arc-loadout-note')).toHaveText('Applies now');
  // Editing starts from the shown class: a new optic keeps the shotgun and becomes the custom class.
  await page.locator('.arc-cac-col').nth(1).locator('.arc-cac-item', { hasText: 'Red Dot' }).click();
  await expect(selectedIn(page, 0)).toHaveText(/Shotgun/);
  await expect(page.locator('.arc-chip.custom')).toHaveClass(/selected/);
  await page.locator('.arc-loadout button.mc-btn').click();
  await forcePlaying(page);
  await play(page, 500);
  await expect(page.locator('.arc-weapon-name')).toHaveText('Shotgun');
  await expect(page.locator('.chat')).toBeVisible();
});

test('hardpoint warm-up: no "Hill moves in 0" before the round is live', async ({ page }) => {
  test.setTimeout(120_000);
  await quickPlay(page, 'hill_e2e', 'hardpoint');
  await expect(page.locator('.mlobby-status')).toContainText('Waiting for players');
  await play(page, 1500);
  await expect(page.locator('.mode-panel')).not.toContainText('Hill moves');
});

test('language: switching to Dutch in a match redraws the HUD, the lobby panel and Create-a-Class', async ({ page }) => {
  test.setTimeout(120_000);
  await quickPlay(page, 'taal_e2e');
  await expect(page.locator('.arc-health-label')).toHaveText('HEALTH');
  // The same settings change the Language screen makes.
  await page.evaluate(() => (window as any).game.settings.set('language', 'nl'));
  await play(page, 300);
  // Before the fix these stayed English until the next match.
  await expect(page.locator('.arc-health-label')).toHaveText('GEZONDHEID');
  // The longer Dutch label ran into the number ("GEZONDHEID100").
  const label = (await page.locator('.arc-health-label').boundingBox())!;
  const num = (await page.locator('.arc-health-num').boundingBox())!;
  expect(label.x + label.width).toBeLessThan(num.x);
  await expect(page.locator('.mlobby-hint')).toHaveText('Houd Tab ingedrukt voor het scorebord');
  await page.keyboard.press('KeyB');
  await expect(page.locator('.arc-cac-head').first()).toHaveText('Primair');
  await expect(page.locator('.arc-loadout button.mc-btn')).toHaveText('Klaar');
  await page.locator('.arc-loadout button.mc-btn').click();
  await page.evaluate(() => (window as any).game.settings.set('language', 'en'));
});

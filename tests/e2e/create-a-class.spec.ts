import { type Page } from '@playwright/test';
import { clickButton, expect, forcePlaying, openTitle, play, test, waitForWorld } from './fixtures';

/*
 * Create-a-Class from the home screen (roadmap 6): several saved classes, named, kept with the profile on the server;
 * the equipped one is what a match starts with, and the in-match menu switches between them.
 */

const SHOTS = process.env.E2E_SHOTS_DIR;

const item = (page: Page, field: string, id: string) => page.locator(`.cac-home .arc-cac-item[data-field="${field}"][data-id="${id}"]`);
const tab = (page: Page, i: number) => page.locator(`.cac-home .cac-slot[data-slot="${i}"]`);

async function openClasses(page: Page): Promise<void> {
  await page.locator('.home-nav button', { hasText: 'Create-a-Class' }).click();
  await expect(page.getByRole('heading', { name: 'Create-a-Class' })).toBeVisible();
  await expect(page.locator('.cac-home .cac-slot')).toHaveCount(5);
}

test('create-a-class from the home screen: two classes edited and saved with the profile, a bot match, a class switch', async ({ page }) => {
  test.setTimeout(180_000);
  await openTitle(page);
  await page.evaluate(() => localStorage.setItem('bunkcraft.name', 'cac_home'));
  await openTitle(page); // with a name, the home screen loads (creates) the profile
  // The profile exists once the home screen has talked to the server (it carries the classes).
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('bunkcraft.profile.')))).toBe(true);
  await openClasses(page);

  // Class 1: SMG, Extended Mags + Ninja (two categories), renamed.
  await tab(page, 0).click();
  await item(page, 'primary', 'smg').click();
  await item(page, 'perk', 'extmag').click();
  // The second perk cannot come from the first perk's category.
  await expect(item(page, 'perk2', 'quickdraw')).toHaveClass(/disabled/);
  await item(page, 'perk2', 'ninja').click();
  // Attachments unlock with the level: a new profile sees the laser locked at level 2.
  await expect(item(page, 'rail', 'laser')).toHaveClass(/locked/);
  await expect(item(page, 'rail', 'laser').locator('em')).toHaveText('Lv 2');
  await page.locator('.cac-home .cac-name').fill('Run and Gun');
  await expect(tab(page, 0)).toContainText('Run and Gun');

  // Class 2: a template, then edited.
  await tab(page, 1).click();
  await page.locator('.cac-home .cac-preset', { hasText: 'Breacher' }).click();
  await expect(item(page, 'primary', 'shotgun')).toHaveClass(/selected/);
  await item(page, 'optic', 'reddot').click();
  await item(page, 'perk2', 'none').click();
  await page.locator('.cac-home .cac-name').fill('Door Kicker');
  await expect(page.locator('.cac-home .cac-line')).toContainText('Shotgun (Red Dot) + Pistol');
  if (SHOTS) { await page.mouse.move(0, 0); await play(page, 400); await page.screenshot({ path: `${SHOTS}/cac-home.png` }); }

  // Class 1 is the one to play with.
  await tab(page, 0).click();
  await expect(tab(page, 0)).toHaveClass(/selected/);

  // The book is in the profile on the server: without this browser's copy, a reload gets it back from there.
  await expect.poll(() => page.evaluate(async () => {
    const token = Object.entries(localStorage).find(([k]) => k.startsWith('bunkcraft.profile.'))![1];
    const r = await fetch('/api/profile', { headers: { authorization: `Bearer ${token}` } });
    const p = (await r.json()).profile;
    return p.classes ? `${p.classes.sel}:${p.classes.classes[0].name}:${p.classes.classes[1].name}:${p.classes.classes[0].perk2}` : '';
  }), { timeout: 10_000 }).toBe('0:Run and Gun:Door Kicker:ninja');
  await page.evaluate(() => localStorage.removeItem('bunkcraft.arcadeClasses'));
  await openTitle(page);
  await openClasses(page);
  await expect(tab(page, 0)).toContainText('Run and Gun');
  await expect(tab(page, 1)).toContainText('Door Kicker');
  await expect(item(page, 'perk2', 'ninja')).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Back' }).click();

  // A private match with a bot: the equipped class (the SMG) is in your hands.
  await clickButton(page, 'Private match');
  await expect(page.getByRole('heading', { name: 'Create Private Match' })).toBeVisible();
  await page.getByRole('button', { name: /^Bots:/ }).click();
  await expect(page.getByRole('button', { name: /^Bots: 1/ })).toBeVisible();
  await page.getByRole('button', { name: 'Create Lobby' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby Created' })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForWorld(page);
  await forcePlaying(page);
  await expect.poll(() => page.evaluate(() => (window as any).game.arcade?.players?.size ?? 0), { timeout: 30_000 }).toBeGreaterThan(1);
  await play(page, 500);
  await expect(page.locator('.arc-weapon-name')).toHaveText('SMG');

  // B opens the same editor; clicking class 2 equips it and (warm-up: nobody fights) puts it in your hands at once.
  await page.keyboard.press('KeyB');
  await expect(page.locator('.arc-loadout')).toBeVisible();
  await expect(page.locator('.arc-loadout .cac-slot.selected')).toContainText('Run and Gun');
  await expect(page.locator('.arc-loadout-note')).toHaveText('Applies now');
  await page.locator('.arc-loadout .cac-slot', { hasText: 'Door Kicker' }).click();
  await expect(page.locator('.arc-loadout .arc-cac-item.selected[data-field="primary"]')).toHaveText(/Shotgun/);
  if (SHOTS) { await play(page, 400); await page.screenshot({ path: `${SHOTS}/cac-match.png` }); }
  await page.locator('.arc-loadout button.mc-btn').click();
  await forcePlaying(page);
  await play(page, 500);
  await expect(page.locator('.arc-weapon-name')).toHaveText('Shotgun');
  // The switch is remembered: class 2 is now the equipped one.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bunkcraft.arcadeClasses')!).sel)).toBe(1);
});

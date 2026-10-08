import { type Browser, type Page } from '@playwright/test';
import { markerSkin } from '../helpers/png';
import { clickButton, expect, forcePlaying, openPauseMenu, openSandbox, openTitle, play, test, waitForWorld } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

const skinFile = { name: 'marker-skin.png', mimeType: 'image/png', buffer: Buffer.from(markerSkin()) };

async function secondPlayer(browser: Browser, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`second browser: ${e.message}`));
  return page;
}

/** Home → Build & Survival → Skin: picks the file and saves it as the skin of this browser's profile. */
async function uploadSkinViaMenu(page: Page): Promise<void> {
  await openTitle(page);
  await openSandbox(page);
  await page.getByRole('button', { name: 'Skin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Player Skin' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(skinFile);
  await expect(page.locator('.skin-caption')).toHaveText('Preview: not saved yet');
  await clickButton(page, 'Use This Skin');
  await expect(page.locator('.skin-status')).toHaveText(/Skin saved/);
  await expect(page.locator('.skin-caption')).toHaveText('Your skin');
  await clickButton(page, 'Back');
}

async function joinByLink(page: Page, code: string, name: string): Promise<void> {
  await openTitle(page, `/?join=${code}`);
  await expect(page.getByRole('button', { name: 'Join Game' })).toBeVisible();
  await page.locator('input.mc-input:visible').first().fill(name);
  await clickButton(page, 'Join Game');
  await waitForWorld(page);
  await forcePlaying(page);
}

/** What `viewer` draws for the player called `name`: the atlas cell, the model type and the pixel the face lands on. */
async function seen(viewer: Page, name: string): Promise<{ slot: number; kind: string; skin: string; face: number[] | null }> {
  await viewer.bringToFront();
  return viewer.evaluate(async (who) => {
    const g = (window as any).game;
    const r = [...g.remote.players.values()].find((p: any) => p.name === who) as any;
    if (!r) return { slot: -2, kind: '', skin: '', face: null };
    const { skinAtlas } = await import('/src/rendering/SkinAtlas.ts' as string);
    const atlas = skinAtlas();
    const slot = r.mob.skin as number;
    let face: number[] | null = null;
    if (slot >= 0) {
      const x = (slot % 8) * 64, y = Math.floor(slot / 8) * 64;
      face = [...atlas.canvas.getContext('2d')!.getImageData(x + 11, y + 11, 1, 1).data];
    }
    return { slot, kind: r.mob.type.kind as string, skin: r.skinHash as string, face };
  }, name);
}

test('skins: an uploaded skin shows on another player, can be hidden and switched off', async ({ page, browser, consoleErrors }) => {
  test.setTimeout(240_000);
  await uploadSkinViaMenu(page);
  // The skin is served as a canonical, immutable file.
  const hash = await page.evaluate(async () => {
    const token = localStorage.getItem(`bunkcraft.profile.${location.host}`)!;
    const res = await fetch('/api/profile', { headers: { authorization: `Bearer ${token}` } });
    return ((await res.json()) as { profile: { skin: string } }).profile.skin;
  });
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  const file = await page.request.get(`/skins/${hash}.png`);
  expect(file.status()).toBe(200);
  expect(file.headers()['cache-control']).toContain('immutable');

  // Alice creates a game (her hello carries the profile token), Bob joins with no skin of his own.
  await clickButton(page, 'Multiplayer');
  await page.locator('input.mc-input:visible').first().fill('alice_skin');
  await clickButton(page, 'Create Game');
  await clickButton(page, 'Create and Play');
  await waitForWorld(page);
  await forcePlaying(page);
  const code = await page.evaluate(() => (window as any).game.roomCode as string);
  const b = await secondPlayer(browser, consoleErrors);
  await joinByLink(b, code, 'bob_skin');

  // Bob's client fetched the skin and draws Alice with it: her cell of the atlas holds the magenta face.
  await expect.poll(async () => (await seen(b, 'alice_skin')).slot, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const s = await seen(b, 'alice_skin');
  expect(s.skin).toBe(hash);
  expect(s.face).toEqual([255, 0, 255, 255]);
  // Alice sees Bob with the default skin (he has none).
  expect((await seen(page, 'bob_skin')).slot).toBe(-1);

  // Look at her from the front for the record (a screenshot to review by eye, not a baseline).
  await b.evaluate(() => {
    const g = (window as any).game;
    const r = [...g.remote.players.values()].find((p: any) => p.name === 'alice_skin') as any;
    g.player.x = r.mob.x; g.player.y = r.mob.y; g.player.z = r.mob.z - 3; g.player.yaw = Math.PI; g.player.pitch = 0;
  });
  await play(b, 1500);
  await b.screenshot({ path: test.info().outputPath('alice-seen-by-bob.png') });

  // Bob hides the skin from the player list (pause menu), reports it, shows it again.
  // Bob's window must be in front (a background page in CI throttles rendering) and the real pointer lock must be released.
  await openPauseMenu(b);
  await b.getByRole('button', { name: 'Players & Skins' }).filter({ visible: true }).first().click();
  const row = b.locator('.players-row[data-player="alice_skin"]');
  await expect(row).toContainText('Custom skin');
  await row.getByRole('button', { name: 'Hide Skin' }).click();
  await expect.poll(async () => (await seen(b, 'alice_skin')).slot, { timeout: 10_000 }).toBe(-1);
  await row.getByRole('button', { name: 'Show Skin' }).click();
  await expect.poll(async () => (await seen(b, 'alice_skin')).slot, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await row.getByRole('button', { name: 'Report Skin' }).click();
  await expect(row.getByRole('button', { name: 'Reported' })).toBeDisabled();

  // The option "Custom Skins of Others" turns every custom skin off, and on again.
  await b.evaluate(() => (window as any).game.settings.set('showCustomSkins', false));
  await expect.poll(async () => (await seen(b, 'alice_skin')).slot, { timeout: 10_000 }).toBe(-1);
  await b.evaluate(() => (window as any).game.settings.set('showCustomSkins', true));
  await expect.poll(async () => (await seen(b, 'alice_skin')).slot, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  // Removing the skin takes effect live for the people in the game.
  await page.bringToFront();
  await page.evaluate(async () => {
    const token = localStorage.getItem(`bunkcraft.profile.${location.host}`)!;
    await fetch('/api/profile/skin', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  });
  await expect.poll(async () => (await seen(b, 'alice_skin')).slot, { timeout: 15_000 }).toBe(-1);
  await b.context().close();
});

test('skins: team players in an arena lobby keep their team look with a custom skin', async ({ page, browser, consoleErrors }) => {
  test.setTimeout(240_000);
  await uploadSkinViaMenu(page);
  const res = await page.request.post('/api/rooms', { data: { name: 'E2E skins', gameType: 'tdm', scoreLimit: 10, timeLimitSec: 300 } });
  expect(res.status()).toBe(201);
  const { code } = (await res.json()) as { code: string };
  // Alice joins the arena lobby with her profile (the home screen asks for a name once).
  await openTitle(page, `/?join=${code}`);
  await expect(page.getByRole('heading', { name: 'Choose a Name' })).toBeVisible();
  await page.locator('input.mc-input:visible').first().fill('alice_arena');
  await page.keyboard.press('Enter');
  await waitForWorld(page);
  await forcePlaying(page);
  const b = await secondPlayer(browser, consoleErrors);
  await openTitle(b, `/?join=${code}`);
  await expect(b.getByRole('heading', { name: 'Choose a Name' })).toBeVisible();
  await b.locator('input.mc-input:visible').first().fill('bob_arena');
  await b.keyboard.press('Enter');
  await waitForWorld(b);
  await forcePlaying(b);

  // Bob sees Alice on a team model (red or blue shirt and band) wearing her skin; her torso is tinted by team.
  await expect.poll(async () => {
    await page.bringToFront();
    const s = await seen(b, 'alice_arena');
    return s.slot >= 3 && /^player_(red|blue)$/.test(s.kind);
  }, { timeout: 40_000 }).toBe(true);
  expect((await seen(b, 'alice_arena')).face).toEqual([255, 0, 255, 255]);
  await b.context().close();
});

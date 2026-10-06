import { type Browser, type Page } from '@playwright/test';
import { clickButton, expect, forcePlaying, openTitle, play, test, waitForWorld } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A second browser (own storage, own identity) with the same console-error check as the main page. */
async function secondPlayer(browser: Browser, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`second browser: ${e.message}`));
  return page;
}

/**
 * Opens an invite link (?join=CODE), types a name and joins. A Minecraft game opens Multiplayer with the code filled in;
 * an arcade lobby opens BunkCraft Realms, which asks for the name once and then joins by itself.
 */
async function joinByLink(page: Page, code: string, name: string, realms = false): Promise<void> {
  await openTitle(page, `/?join=${code}`);
  if (realms) {
    await expect(page.getByRole('heading', { name: 'Choose a Name' })).toBeVisible();
    await page.locator('input.mc-input:visible').first().fill(name);
    await page.keyboard.press('Enter');
    await waitForWorld(page);
    await forcePlaying(page);
    return;
  }
  const nameInput = page.locator('input.mc-input:visible').first();
  await expect(page.getByRole('button', { name: 'Join Game' })).toBeVisible();
  await nameInput.fill(name);
  await clickButton(page, 'Join Game');
  await waitForWorld(page);
  await forcePlaying(page);
}

const roomCode = (page: Page) => page.evaluate(() => (window as any).game.roomCode as string);

test('multiplayer: create a game, join by link, chat and see each other\'s blocks', async ({ page, browser, consoleErrors }) => {
  test.setTimeout(180_000);
  // Player A creates a Minecraft game through the menus.
  await openTitle(page);
  await clickButton(page, 'Multiplayer');
  await page.locator('input.mc-input:visible').first().fill('alice_e2e');
  await clickButton(page, 'Create Game');
  await clickButton(page, 'Create and Play');
  await waitForWorld(page);
  await forcePlaying(page);
  const code = await roomCode(page);
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  // Player B opens the invite link in another browser.
  const b = await secondPlayer(browser, consoleErrors);
  await joinByLink(b, code, 'bob_e2e');
  await play(page, 1000);

  // Chat goes both ways.
  await page.evaluate(() => (window as any).game.chat.onSend('hello from alice'));
  await expect.poll(async () => { await b.bringToFront(); return b.evaluate(() => (window as any).game.chat.log.textContent as string); }, { timeout: 15_000 }).toContain('hello from alice');

  // A block placed by A shows up for B (and survives B's view of the world). Survival places must be backed by an
  // item (the server refuses blocks out of nothing), so A switches to creative first (A is the game's operator).
  await page.evaluate(() => (window as any).game.chat.onSend('/gamemode creative'));
  await expect.poll(() => page.evaluate(() => (window as any).game.mode), { timeout: 15_000 }).toBe('creative');
  const spot = await page.evaluate(async () => {
    const g = (window as any).game;
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    const p = g.player;
    const x = Math.floor(p.x) + 2, z = Math.floor(p.z), y = Math.floor(p.y) + 1;
    g.world.setBlock(x, y, z, BLOCK.GLOWSTONE);
    return { x, y, z, id: BLOCK.GLOWSTONE };
  });
  await expect.poll(async () => { await b.bringToFront(); return b.evaluate((s) => (window as any).game.world.getBlock(s.x, s.y, s.z), spot); }, { timeout: 15_000 }).toBe(spot.id);

  // B sees A in the player list.
  const remote = await b.evaluate(() => [...(window as any).game.remote.players?.values?.() ?? []].map((r: any) => r.name));
  expect(remote.join(',')).toContain('alice_e2e');
  await b.context().close();
});

for (const type of ['tdm', 'ctf', 'hardpoint'] as const) {
  test(`arcade ${type}: two players join, the match goes live and shots are fired`, async ({ page, browser, consoleErrors }) => {
    test.setTimeout(180_000);
    const res = await page.request.post('/api/rooms', { data: { name: `E2E ${type}`, gameType: type, scoreLimit: 10, timeLimitSec: 300 } });
    expect(res.status()).toBe(201);
    const { code } = (await res.json()) as { code: string };
    await joinByLink(page, code, `red_${type}`, true);
    const b = await secondPlayer(browser, consoleErrors);
    await joinByLink(b, code, `blue_${type}`, true);

    const info = await page.evaluate(() => { const g = (window as any).game; return { arcade: !!g.arcade, type: g.meta?.gameType ?? g.arcade?.info?.type }; });
    expect(info.arcade).toBe(true);
    // The arcade HUD is up and the warm-up turns live within ~10 s once two players are in.
    await expect.poll(async () => {
      await page.bringToFront();
      await b.bringToFront();
      return page.evaluate(() => (window as any).game.arcade?.phase);
    }, { timeout: 40_000 }).toBe('live');
    if (type !== 'tdm') await expect(page.locator('.mode-hud, [class*="mode"]').first()).toBeAttached();

    // Hold the trigger for a moment: the magazine empties a bit (the server confirms every shot).
    const before = await page.evaluate(() => (window as any).game.arcade.ammo[0].mag as number);
    await forcePlaying(page);
    await page.evaluate(() => (window as any).game.input.down.add('Mouse0'));
    await play(page, 1200);
    await page.evaluate(() => (window as any).game.input.down.delete('Mouse0'));
    const after = await page.evaluate(() => (window as any).game.arcade.ammo[0].mag as number);
    expect(after).toBeLessThan(before);
    await b.context().close();
  });
}

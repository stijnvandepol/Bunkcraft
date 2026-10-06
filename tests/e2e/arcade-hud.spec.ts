import { type Page } from '@playwright/test';
import { expect, openTitle, test } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Arcade HUD regressions found in the QA play test (docs/qa/ARCADE.md), on the dev preview (fake server):
 * no game server traffic needed.
 */
async function startPreview(page: Page, type: string, map: string): Promise<void> {
  await openTitle(page);
  await page.waitForFunction(() => !!(window as any).game.world, undefined, { timeout: 60_000 });
  await page.evaluate(([t, m]) => (window as any).game.arcadePreview(t, 'You', m), [type, map]);
  await page.waitForFunction(() => { const g = (window as any).game; return g.state !== 'loading' && g.state !== 'menu' && !!g.previewServer; }, undefined, { timeout: 90_000 });
  await page.evaluate(() => { const g = (window as any).game; g.input.locked = true; g.state = 'playing'; g.previewServer.botsAggressive = false; });
}

test('arcade: the end screen replaces the death screen when the final kill was yours', async ({ page }) => {
  await startPreview(page, 'tdm', 'atomic');
  await page.evaluate(() => (window as any).game.previewServer.killSelf(1, false));
  await expect(page.locator('.arc-death')).toBeVisible();
  await page.evaluate(() => (window as any).game.previewServer.endMatch('blue'));
  await expect(page.locator('.arc-end')).toBeVisible();
  // Checked at once: the respawn a few seconds later would hide the death screen anyway.
  expect(await page.evaluate(() => document.querySelector('.arc-death')!.classList.contains('hidden'))).toBe(true);
});

test('arcade: the end screen shows the final score that arrives right after matchend (objective modes)', async ({ page }) => {
  await startPreview(page, 'ctf', 'atomic');
  // The server's order for a winning capture: matchend first, then the match message with the new score.
  await page.evaluate(() => {
    const g = (window as any).game;
    g.onServerMessage({ t: 'matchend', winnerTeam: 'red', winnerId: 0, restartIn: 12 });
    g.onServerMessage({ t: 'match', phase: 'ended', timeLeft: 12, scores: { red: 3, blue: 1 }, info: g.previewServer.info });
  });
  await expect(page.locator('.arc-end')).toBeVisible();
  await expect(page.locator('.arc-end .arc-board-scores')).toContainText('RED 3');
  await expect(page.locator('.arc-end .arc-board-scores')).toContainText('1 BLUE');
});

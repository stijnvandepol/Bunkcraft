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
    // Like the real server after the end: the preview's own once-a-second match broadcast must not say "live" any more.
    g.previewServer.phase = 'ended';
    g.previewServer.endAt = g.previewServer.t + 60;
    g.previewServer.scores.red = 3; g.previewServer.scores.blue = 1;
    g.onServerMessage({ t: 'matchend', winnerTeam: 'red', winnerId: 0, restartIn: 12 });
    g.onServerMessage({ t: 'match', phase: 'ended', timeLeft: 12, scores: { red: 3, blue: 1 }, info: g.previewServer.info });
  });
  await expect(page.locator('.arc-end')).toBeVisible();
  await expect(page.locator('.arc-end .arc-board-scores')).toContainText('RED 3');
  await expect(page.locator('.arc-end .arc-board-scores')).toContainText('1 BLUE');
});

test('arcade: a long kill feed row stays clear of the score bar (it covered the blue score at 1280x720)', async ({ page }) => {
  await startPreview(page, 'tdm', 'atomic');
  await page.evaluate(() => {
    const g = (window as any).game;
    g.arcade.addPlayer(901, 'LongNameKiller16', 'blue');
    g.arcade.addPlayer(902, 'AnotherLongName1', 'red');
    g.onServerMessage({ t: 'kill', killer: 901, victim: 902, weapon: 'semisniper', head: true });
  });
  await expect(page.locator('.arc-feed-row')).toHaveCount(1);
  const feed = (await page.locator('.arc-feed-row').boundingBox())!;
  const top = (await page.locator('.arc-top-row').boundingBox())!;
  expect(feed.x).toBeGreaterThanOrEqual(top.x + top.width);
});

test('arcade: with the map vote up, your own row stays on the end screen in a full lobby (it was cut off at the bottom)', async ({ page }) => {
  await startPreview(page, 'tdm', 'atomic');
  await page.evaluate(() => {
    const g = (window as any).game;
    const self = g.arcade.d.selfId;
    g.previewServer.phase = 'ended';
    g.previewServer.endAt = g.previewServer.t + 60;
    const players = Array.from({ length: 11 }, (_, i) => ({ id: 800 + i, name: `bot${i}`, team: i % 2 ? 'red' : 'blue', kills: 20 - i, deaths: 3, ping: 20, pts: 0 }));
    players.push({ id: self, name: 'You', team: 'red', kills: 0, deaths: 9, ping: 20, pts: 0 });
    g.onServerMessage({ t: 'roster', players });
    g.onServerMessage({ t: 'matchend', winnerTeam: 'blue', winnerId: 0, restartIn: 20 });
    g.onServerMessage({ t: 'vote', options: ['classic', 'villa', 'town'], counts: [0, 0, 0], endsIn: 15 });
  });
  await expect(page.locator('.arc-end')).toBeVisible();
  await expect(page.locator('.mvote')).toBeVisible();
  const self = page.locator('.arc-end-board .arc-row.self');
  await expect(self).toHaveCount(1);
  const row = (await self.boundingBox())!;
  const board = (await page.locator('.arc-end-board').boundingBox())!;
  expect(row.y + row.height).toBeLessThanOrEqual(board.y + board.height + 1);
});

test('arcade: gun game shows one knife slot, not "2 Knife 3 Knife"', async ({ page }) => {
  await startPreview(page, 'gungame', 'atomic');
  await page.evaluate(() => (window as any).game.onServerMessage({ t: 'gear', primary: 'rifle', secondary: 'knife', optic: 'iron', perk: 'none' }));
  await expect(page.locator('.arc-slot:visible')).toHaveCount(2);
  await expect(page.locator('.arc-slot:visible').nth(1)).toContainText('Knife');
});

test('arcade: the Tab scoreboard hides the objective markers drawn over it', async ({ page }) => {
  await startPreview(page, 'domination', 'villa');
  await page.evaluate(() => (window as any).game.previewServer.demo());
  await page.waitForFunction(() => document.querySelectorAll('.mode-marker:not(.hidden)').length > 0, undefined, { timeout: 30_000 });
  await page.evaluate(() => (window as any).game.input.down.add('Tab'));
  await expect(page.locator('.arc-board')).toBeVisible();
  await expect(page.locator('.mode-markers')).toBeHidden();
  await page.evaluate(() => (window as any).game.input.down.delete('Tab'));
});

test('arcade: an objective marker at the screen edge keeps its whole caption on screen (wide "CONTESTED" label)', async ({ page }) => {
  await startPreview(page, 'domination', 'villa');
  // Three contested points, the player turning around: markers stick to the left and right edges.
  await page.evaluate(() => {
    const g = (window as any).game;
    g.previewServer.demo();
    const st = g.arcade.modeHud.state;
    g.previewServer.modeState({ ...st, zones: st.zones.map((z: any) => ({ ...z, contested: true, owner: '', progress: 0, progressTeam: '' })) });
  });
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    await page.evaluate((y) => { const g = (window as any).game; g.player.yaw = y; g.player.pitch = 0; }, yaw);
    await page.waitForTimeout(400);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('.mode-marker:not(.hidden)')].map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, text: e.textContent };
    }));
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.left, `${b.text} at yaw ${yaw}`).toBeGreaterThanOrEqual(0);
      expect(b.right, `${b.text} at yaw ${yaw}`).toBeLessThanOrEqual(1280);
    }
  }
});

test('arcade: the end screen hides the score bar, kill feed and panels under it', async ({ page }) => {
  await startPreview(page, 'tdm', 'atomic');
  await page.evaluate(() => (window as any).game.previewServer.botKill());
  await expect(page.locator('.arc-feed-row').first()).toBeVisible();
  await page.evaluate(() => (window as any).game.previewServer.endMatch('red'));
  await expect(page.locator('.arc-end-title')).toBeVisible();
  // The title sat on top of the timer and scores (QA round 2, shot r2-end-overlap.jpg).
  for (const s of ['.arc-top', '.arc-feed-row', '.arc-ammo', '.arc-health']) await expect(page.locator(s).first(), s).toBeHidden();
});

test('arcade: sound captions sit above the weapon slots and the ammo counter', async ({ page }) => {
  await startPreview(page, 'tdm', 'atomic');
  await page.evaluate(() => {
    const g = (window as any).game;
    g.subtitles.enabled = true;
    for (const label of ['Gunshot', 'Footsteps', 'Footsteps', 'Double kill']) g.caption(label, g.player.x + 5, g.player.z);
  });
  await expect(page.locator('.subtitle').first()).toBeVisible();
  const [subs, ammo] = await page.evaluate(() => ['.subtitles', '.arc-ammo'].map((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }));
  expect(subs.bottom).toBeLessThanOrEqual(ammo.top);
});

test('arcade: Create-a-Class hides the match HUD under it (its title sat on the score bar)', async ({ page }) => {
  await startPreview(page, 'tdm', 'atomic');
  await expect(page.locator('.arc-top')).toBeVisible();
  await page.evaluate(() => (window as any).game.arcade.openLoadout());
  await expect(page.locator('.arc-loadout-title')).toBeVisible();
  await expect(page.locator('.arc-top')).toBeHidden();
  await page.evaluate(() => (window as any).game.arcade.closeLoadout());
  await expect(page.locator('.arc-top')).toBeVisible();
});

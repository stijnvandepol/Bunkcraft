import { type Browser, type Page } from '@playwright/test';
import { expect, forcePlaying, openTitle, test, waitForWorld } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A fresh browser (own storage, own identity) that already has a gamertag, so the profile and the party use it at once. */
async function browserWithName(browser: Browser, name: string, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((n) => { if (!localStorage.getItem('bunkcraft.name')) localStorage.setItem('bunkcraft.name', n); }, name);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404|GPU stall|WebGL|AudioContext|pointer ?lock|\[vite\]/i.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  await openTitle(page);
  await expect(page.locator('.bc-play')).toBeEnabled();
  // the profile (and so the rank icon) is there before the party is made
  await expect(page.locator('.home-profile .rank-badge')).toBeVisible();
  return page;
}

const members = (page: Page) => page.locator('.home-party .party-member');
const team = (page: Page) => page.evaluate(() => (window as any).game.arcade?.team as string | undefined);
const roomCode = (page: Page) => page.evaluate(() => (window as any).game.roomCode as string);

/** Both windows in front in turn, so neither is throttled while we wait. */
async function until(pages: Page[], fn: (p: Page) => Promise<boolean>, timeout = 40_000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    const results: boolean[] = [];
    for (const p of pages) {
      await p.bringToFront();
      results.push(await fn(p));
    }
    if (results.every(Boolean)) return;
    if (Date.now() > end) throw new Error('condition not met in time');
    await pages[0].waitForTimeout(250);
  }
}

test('party: two friends group up, the leader plays and both land in one lobby on the same team', async ({ browser, consoleErrors }) => {
  test.setTimeout(240_000);
  const a = await browserWithName(browser, 'party_lead', consoleErrors);
  const b = await browserWithName(browser, 'party_mate', consoleErrors);

  // A makes a party with the keyboard (Tab to the button would do the same; Enter on the focused button creates it).
  await a.bringToFront();
  await a.locator('.home-party [data-key="create"]').focus();
  await a.keyboard.press('Enter');
  await expect(a.locator('.home-party[data-party="on"]')).toBeVisible();
  const code = (await a.locator('.party-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{5}$/);
  await expect(members(a)).toHaveCount(1);
  await expect(a.locator('.party-member.leader.you .party-crown')).toBeVisible();
  await expect(a.locator('.party-member .rank-badge')).toHaveCount(1);

  // B types the code and presses Enter.
  await b.bringToFront();
  await b.locator('.party-input').fill(code.toLowerCase());
  await b.keyboard.press('Enter');
  await expect(b.locator('.home-party[data-party="on"]')).toBeVisible();
  await expect(members(b)).toHaveCount(2);
  await expect(b.locator('.party-member .rank-badge')).toHaveCount(2);

  // A sees B arrive (polling), with the leader first.
  await until([a], async (p) => (await members(p).count()) === 2);
  await expect(members(a).first()).toContainText('party_lead');
  await expect(members(a).nth(1)).toContainText('party_mate');
  await expect(members(a).nth(1).locator('.party-chip')).toContainText('Not ready');
  // The member's big button is READY, and the playlist follows the leader.
  await expect(b.locator('.bc-play')).toContainText('Ready');
  await a.locator('.mode-card[data-mode="ctf"]').click();
  await until([b], async (p) => (await p.locator('.mode-card[data-mode="ctf"]').getAttribute('aria-pressed')) === 'true');
  await a.locator('.mode-card[data-mode="tdm"]').click();
  await until([b], async (p) => (await p.locator('.mode-card[data-mode="tdm"]').getAttribute('aria-pressed')) === 'true');

  // B readies up, A sees it.
  await b.bringToFront();
  await b.locator('.bc-play').click();
  await expect(b.locator('.bc-play')).toContainText('Ready!');
  await until([a], async (p) => /ready$/i.test(((await members(p).nth(1).locator('.party-chip').textContent()) ?? '').trim()));

  // A plays: both end up in the same lobby, on the same team (a plain quick play would split two players over both teams).
  await a.bringToFront();
  await a.locator('.bc-play').click();
  await waitForWorld(a);
  await forcePlaying(a);
  await waitForWorld(b);
  await forcePlaying(b);
  const codeA = await roomCode(a);
  expect(codeA).toMatch(/^[A-Z0-9]{6}$/);
  expect(await roomCode(b)).toBe(codeA);
  await until([a, b], async (p) => ['red', 'blue'].includes((await team(p)) ?? ''));
  expect(await team(a)).toBe(await team(b));
  expect(await a.evaluate(() => (window as any).game.arcade?.info?.type)).toBe('tdm');

  // After the match both go back to the home screen and the party is still there, ready flags cleared.
  await a.evaluate(() => (window as any).game.quitToTitle());
  await b.evaluate(() => (window as any).game.quitToTitle());
  await expect(a.locator('.home')).toBeVisible();
  await expect(b.locator('.home')).toBeVisible();
  await until([a, b], async (p) => (await members(p).count()) === 2);
  await expect(b.locator('.bc-play')).toContainText('Ready');
  expect(await b.locator('.bc-play').textContent()).not.toContain('Ready!');

  // A reload keeps the member in the party (session token).
  await b.bringToFront();
  await b.reload();
  await openTitle(b);
  await expect(b.locator('.home-party[data-party="on"]')).toBeVisible();
  await expect(members(b)).toHaveCount(2);

  // The leader leaves: the other one wears the crown.
  await a.bringToFront();
  await a.locator('.home-party [data-key="leave"]').click();
  await expect(a.locator('.home-party[data-party="off"]')).toBeVisible();
  await until([b], async (p) => (await members(p).count()) === 1);
  await expect(b.locator('.party-member.you.leader')).toBeVisible();
  await expect(b.locator('.bc-play')).toContainText('Play');

  await a.context().close();
  await b.context().close();
});

test('party: an invite link joins the party, and the leader can remove a member', async ({ browser, consoleErrors }) => {
  test.setTimeout(120_000);
  const a = await browserWithName(browser, 'invite_lead', consoleErrors);
  await a.locator('.home-party [data-key="create"]').click();
  await expect(a.locator('.party-code')).toBeVisible();
  const code = (await a.locator('.party-code').textContent())!.trim();

  // B opens the link from the party panel: ?party=CODE.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => { if (!localStorage.getItem('bunkcraft.name')) localStorage.setItem('bunkcraft.name', 'invite_mate'); });
  const b = await ctx.newPage();
  await b.goto(`/?party=${code}`);
  await expect(b.locator('.home-party[data-party="on"]')).toBeVisible({ timeout: 60_000 });
  await expect(members(b)).toHaveCount(2);
  await expect(b).not.toHaveURL(/party=/);

  // Only the leader sees the buttons to hand over the crown or remove somebody.
  await expect(b.locator('.party-actions')).toHaveCount(0);
  await a.bringToFront();
  await until([a], async (p) => (await members(p).count()) === 2);
  await expect(a.locator('.party-actions button')).toHaveCount(2);
  await a.getByRole('button', { name: 'Remove invite_mate from the party' }).click();
  await until([b], async (p) => (await p.locator('.home-party[data-party="off"]').count()) === 1);
  await expect(members(a)).toHaveCount(1);
  await ctx.close();
  await a.context().close();
});

test('party: the party panel looks right and is reachable with the keyboard', async ({ browser, consoleErrors }) => {
  const a = await browserWithName(browser, 'party_look', consoleErrors);
  // Tab order: PLAY first, then Lobbies, Private match, then the party panel before the friends code box.
  await a.keyboard.press('Tab');
  const order: string[] = [];
  for (let i = 0; i < 6; i++) {
    order.push(await a.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.classList.contains('bc-play') ? 'play' : el?.dataset.key === 'create' ? 'create' : el?.classList.contains('party-input') ? 'party-input' : el?.dataset.key === 'join' ? 'party-join' : (el?.textContent ?? '').trim().slice(0, 12);
    }));
    await a.keyboard.press('Tab');
  }
  const flat = order.join('|');
  expect(flat.indexOf('create')).toBeGreaterThan(flat.indexOf('play'));
  expect(flat).toContain('party-input');
  await a.context().close();
});

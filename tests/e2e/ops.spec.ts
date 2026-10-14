import type { Page } from '@playwright/test';
import { expect, openTitle, test } from './fixtures';

/**
 * The ops dashboard: an account in ADMIN_ACCOUNTS (playwright.config.ts) gets the admin link on the home screen, which
 * opens /ops in a new tab, logged in through the game's own session; the overview shows the running lobby, and a
 * setting changed there reaches the server at once. A normal account sees no link and the dashboard turns it away.
 */
const PW = 'correct horse battery';

/** Registers an account through the API and makes it this browser's session (what the account screen does). */
async function registerAndAdopt(page: Page, name: string): Promise<string> {
  return page.evaluate(async ({ name, pw }) => {
    const res = await fetch('/api/account/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password: pw }) });
    const j = await res.json() as { token: string };
    localStorage.setItem(`bunkcraft.profile.${location.host}`, j.token);
    localStorage.setItem('bunkcraft.name', name);
    return j.token;
  }, { name, pw: PW });
}

test('ops: an admin account opens the dashboard from the home screen, sees the lobby and changes a setting', async ({ page, context, consoleErrors }) => {
  await openTitle(page);
  await registerAndAdopt(page, 'E2e_Admin');
  // A running lobby to find in the dashboard.
  const code = await page.evaluate(async () => {
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ops E2E', gameType: 'tdm', scoreLimit: 50, timeLimitSec: 600 }) });
    return (await res.json() as { code: string }).code;
  });
  await openTitle(page);
  const link = page.locator('.home-account a[data-ops]');
  await expect(page.locator('.home-account')).toContainText('Account: E2e_Admin');
  await expect(link).toHaveText(/admin/i);
  await expect(link).toHaveAttribute('target', '_blank');

  const [ops] = await Promise.all([context.waitForEvent('page'), link.click()]);
  ops.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`ops console: ${m.text()}`); });
  ops.on('pageerror', (e) => consoleErrors.push(`ops pageerror: ${e.message}`));
  await ops.waitForLoadState();
  expect(new URL(ops.url()).pathname).toBe('/ops');
  // Logged in through the game's session, no form.
  await expect(ops.locator('#who')).toContainText('E2e_Admin', { timeout: 15_000 });
  await expect(ops.locator('#login')).toBeHidden();
  const cards = ops.locator('#cards');
  await expect(cards).toContainText('Isolatie');
  await expect(cards).toContainText('in-process');
  await expect(cards).toContainText('Spelers');
  // In-process: the lobbies table instead of containers, with the lobby we opened.
  const row = ops.locator('#ip-table tbody tr', { hasText: code });
  await expect(row).toBeVisible();
  await expect(row).toContainText('tdm');
  await row.getByRole('button', { name: 'Spelers' }).click();
  await expect(ops.locator('#sel')).toContainText(`Spelers in ${code}`);

  // Settings: the lobby size goes down at once, then back to the .env value.
  await ops.getByRole('tab', { name: 'Instellingen' }).click();
  const size = ops.locator('input[data-key="roomMaxPlayers"]');
  await expect(size).toHaveValue('12');
  await size.fill('10');
  await ops.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(ops.locator('#s-msg')).toContainText('Opgeslagen: roomMaxPlayers');
  expect(await ops.evaluate(async () => (await (await fetch('/api/server')).json() as { roomMaxPlayers: number }).roomMaxPlayers)).toBe(10);
  // Out of range: the form refuses it (min/max from the server's ranges) and nothing changes.
  await size.fill('99');
  await ops.getByRole('button', { name: 'Opslaan', exact: true }).click();
  expect(await size.evaluate((e: HTMLInputElement) => e.validity.rangeOverflow)).toBe(true);
  expect(await ops.evaluate(async () => (await (await fetch('/api/server')).json() as { roomMaxPlayers: number }).roomMaxPlayers)).toBe(10);
  await ops.locator('.set', { has: size }).getByRole('button', { name: 'Reset' }).click();
  await expect(size).toHaveValue('12');
  expect(await ops.evaluate(async () => (await (await fetch('/api/server')).json() as { roomMaxPlayers: number }).roomMaxPlayers)).toBe(12);

  // The audit log names the admin.
  await ops.getByRole('tab', { name: 'Audit log' }).click();
  await expect(ops.locator('#au-table tbody tr').first()).toContainText('E2e_Admin');
  await expect(ops.locator('#au-table')).toContainText('POST settings');
  await ops.close();
});

test('ops: a normal account gets no admin link and the dashboard asks for an admin login', async ({ page, consoleErrors }) => {
  await openTitle(page);
  await registerAndAdopt(page, 'E2e_Player');
  await openTitle(page);
  await expect(page.locator('.home-account')).toContainText('Account: E2e_Player');
  await expect(page.locator('.home-account a[data-ops]')).toHaveCount(0);
  // The 403 for this session is the expected answer, not a bug.
  page.on('console', () => undefined);
  await page.goto('/ops');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#lerr')).toContainText('zonder beheerrechten');
  // Logging in with a wrong password shows the error, nothing else.
  await page.locator('#lname').fill('E2e_Admin');
  await page.locator('#lpass').fill('wrong password here');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.locator('#lerr')).toContainText('verkeerd wachtwoord');
  // The right one gets in (a session of this tab, the game's session is untouched).
  await page.locator('#lpass').fill(PW);
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.locator('#who')).toContainText('E2e_Admin');
  expect(await page.evaluate(() => localStorage.getItem(`bunkcraft.profile.${location.host}`) ?? '')).toMatch(/^s1\./);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/status of (401|403)/.test(e)));
});
